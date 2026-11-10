import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Status = "queued" | "downloading" | "ready" | "failed";

export interface Video {
  id: number;
  url: string;
  source_id: string | null;
  title: string | null;
  channel: string | null;
  duration: number | null;
  thumbnail: string | null;
  status: Status;
  progress: number;
  error: string | null;
  file: string | null;
  size: number | null;
  sort: number;
  watched: number;
  resume_at: number;
  added_at: number;
  watched_at: number | null;
}

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`
    CREATE TABLE IF NOT EXISTS videos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      url         TEXT    NOT NULL,
      source_id   TEXT,
      title       TEXT,
      channel     TEXT,
      duration    REAL,
      thumbnail   TEXT,
      status      TEXT    NOT NULL DEFAULT 'queued',
      progress    REAL    NOT NULL DEFAULT 0,
      error       TEXT,
      file        TEXT,
      size        INTEGER,
      sort        REAL    NOT NULL,
      watched     INTEGER NOT NULL DEFAULT 0,
      resume_at   REAL    NOT NULL DEFAULT 0,
      added_at    INTEGER NOT NULL,
      watched_at  INTEGER
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS videos_sort ON videos (watched, sort)");

  const q = {
    all: db.query<Video, []>("SELECT * FROM videos ORDER BY watched ASC, sort ASC, id ASC"),
    get: db.query<Video, [number]>("SELECT * FROM videos WHERE id = ?"),
    maxSort: db.query<{ m: number | null }, []>("SELECT MAX(sort) AS m FROM videos"),
    findActive: db.query<Video, [string]>(
      "SELECT * FROM videos WHERE source_id = ? AND watched = 0 LIMIT 1",
    ),
    insert: db.query<Video, [string, string | null, number, number]>(
      "INSERT INTO videos (url, source_id, sort, added_at) VALUES (?, ?, ?, ?) RETURNING *",
    ),
    nextQueued: db.query<Video, []>(
      "SELECT * FROM videos WHERE status = 'queued' AND watched = 0 ORDER BY sort ASC, id ASC LIMIT 1",
    ),
    remove: db.query<null, [number]>("DELETE FROM videos WHERE id = ?"),
    staleWatched: db.query<Video, [number]>(
      "SELECT * FROM videos WHERE watched = 1 AND file IS NOT NULL AND watched_at < ?",
    ),
    watchedRows: db.query<Video, []>("SELECT * FROM videos WHERE watched = 1"),
    resetInterrupted: db.query<null, []>(
      "UPDATE videos SET status = 'queued', progress = 0 WHERE status = 'downloading'",
    ),
  };

  const updatable = new Set<keyof Video>([
    "source_id", "title", "channel", "duration", "thumbnail", "status", "progress",
    "error", "file", "size", "sort", "watched", "resume_at", "watched_at",
  ]);

  function update(id: number, patch: Partial<Video>): Video | null {
    const keys = (Object.keys(patch) as (keyof Video)[]).filter((k) => updatable.has(k));
    if (keys.length === 0) return q.get.get(id);
    const sets = keys.map((k) => `${k} = $${k}`).join(", ");
    const params: Record<string, unknown> = { id };
    for (const k of keys) params[k] = patch[k] ?? null;
    return db
      .query<Video, Record<string, any>>(`UPDATE videos SET ${sets} WHERE id = $id RETURNING *`)
      .get(params as Record<string, any>);
  }

  return {
    raw: db,
    list: () => q.all.all(),
    get: (id: number) => q.get.get(id),
    findActive: (sourceId: string) => q.findActive.get(sourceId),
    add(url: string, sourceId: string | null): Video {
      const sort = (q.maxSort.get()?.m ?? 0) + 1;
      return q.insert.get(url, sourceId, sort, Date.now())!;
    },
    update,
    nextQueued: () => q.nextQueued.get(),
    remove: (id: number) => q.remove.run(id),
    staleWatched: (before: number) => q.staleWatched.all(before),
    watchedRows: () => q.watchedRows.all(),
    resetInterrupted: () => q.resetInterrupted.run(),
    /** Put the given unwatched ids in this exact order. Unlisted rows keep their relative order after them. */
    reorder(ids: number[]) {
      db.transaction(() => {
        ids.forEach((id, i) => update(id, { sort: i + 1 }));
        const rest = q.all.all().filter((v) => !ids.includes(v.id));
        rest.forEach((v, i) => update(v.id, { sort: ids.length + i + 1 }));
      })();
    },
  };
}

export type Db = ReturnType<typeof openDb>;
