import { Elysia, t } from "elysia";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import type { Db, Video } from "./db.ts";
import type { Downloader } from "./downloader.ts";
import { COOKIE, checkPassword, isAuthed, sessionToken } from "./auth.ts";
import { canonical, extractUrls, isPlaylist, isYouTube } from "./urls.ts";

const PUBLIC_DIR = resolve(import.meta.dir, "../public");
const toId = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : -1);
const SAFE_NAME = /^\d+\.[A-Za-z0-9]{2,5}$/;

const MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime",
  jpg: "image/jpeg", html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", svg: "image/svg+xml", webmanifest: "application/manifest+json",
};
const mimeOf = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** What the page needs for each entry. Local thumbnails become same-origin URLs. */
function present(v: Video) {
  return {
    id: v.id,
    url: v.url,
    title: v.title,
    channel: v.channel,
    duration: v.duration,
    thumbnail: v.thumbnail?.startsWith("local:") ? `/thumbs/${v.thumbnail.slice(6)}` : v.thumbnail,
    status: v.watched && !v.file ? "cleared" : v.status,
    progress: v.progress,
    error: v.error,
    src: v.file && v.status === "ready" ? `/media/${v.file}` : null,
    size: v.size,
    watched: !!v.watched,
    resumeAt: v.resume_at,
    addedAt: v.added_at,
    watchedAt: v.watched_at,
  };
}

/** Serve a file with HTTP Range support. Safari and iOS refuse to play video without it. */
export function serveFile(path: string, req: Request, cacheControl = "no-cache"): Response {
  const file = Bun.file(path);
  const size = file.size;
  const type = mimeOf(path);
  const range = req.headers.get("range");
  const base = { "Accept-Ranges": "bytes", "Content-Type": type, "Cache-Control": cacheControl };
  if (!range) {
    return new Response(file, { headers: { ...base, "Content-Length": String(size) } });
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === "" && m[2] === "")) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  let start: number;
  let end: number;
  if (m[1] === "") {
    // Suffix range: the last N bytes.
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
  });
}

/** Quick title and channel from YouTube's oEmbed while the video waits its turn. Best effort. */
async function oembed(url: string): Promise<{ title?: string; author_name?: string; thumbnail_url?: string } | null> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(4000),
    });
    return res.ok ? ((await res.json()) as any) : null;
  } catch {
    return null;
  }
}

export function createApp(cfg: Config, db: Db, dl: Downloader, opts: { fetchTitles?: boolean } = {}) {
  const fetchTitles = opts.fetchTitles ?? true;

  async function addFromText(text: string) {
    const urls = extractUrls(text);
    const added: number[] = [];
    const skipped: string[] = [];
    const errors: { url: string; error: string }[] = [];

    const queue: string[] = [];
    for (const url of urls) {
      if (isPlaylist(url)) {
        try {
          queue.push(...(await dl.expandPlaylist(url)));
        } catch (err) {
          errors.push({ url, error: err instanceof Error ? err.message : String(err) });
        }
      } else {
        queue.push(url);
      }
    }

    for (const raw of queue) {
      const { url, sourceId } = canonical(raw);
      const existing = sourceId ? db.findActive(sourceId) : null;
      if (existing) {
        // Pasting a link that failed earlier is a retry, not a duplicate.
        if (existing.status === "failed") {
          db.update(existing.id, { status: "queued", progress: 0, error: null });
          added.push(existing.id);
        } else skipped.push(url);
        continue;
      }
      const row = db.add(url, sourceId);
      added.push(row.id);
      if (fetchTitles && isYouTube(url)) {
        oembed(url).then((o) => {
          const cur = o && db.get(row.id);
          if (cur && !cur.title) {
            db.update(row.id, {
              title: o.title ?? null,
              channel: o.author_name ?? null,
              thumbnail: cur.thumbnail ?? o.thumbnail_url ?? null,
            });
          }
        });
      }
    }
    if (added.length) dl.pump();
    return { added: added.length, skipped: skipped.length, errors, found: urls.length };
  }

  const isProtected = (path: string) =>
    path.startsWith("/api/") || path.startsWith("/media/") || path.startsWith("/thumbs/") || path === "/add";

  return new Elysia()
    .onRequest(({ request, set }) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/login" || path === "/api/session") return;
      if (isProtected(path) && !isAuthed(request, cfg.password)) {
        if (path === "/add") {
          set.status = 302;
          set.headers.location = "/";
          return "Sign in first";
        }
        set.status = 401;
        return { error: "unauthorized" };
      }
    })

    // ---- session ----
    .get("/api/session", ({ request }) => ({
      needsPassword: !!cfg.password,
      authed: isAuthed(request, cfg.password),
    }))
    .post(
      "/api/login",
      ({ body, set }) => {
        if (!cfg.password) return { ok: true };
        if (!checkPassword(body.password, cfg.password)) {
          set.status = 401;
          return { ok: false, error: "Wrong password" };
        }
        set.headers["set-cookie"] =
          `${COOKIE}=${sessionToken(cfg.password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
        return { ok: true };
      },
      { body: t.Object({ password: t.String() }) },
    )

    // ---- queue ----
    .get("/api/state", async () => ({
      videos: db.list().map(present),
      downloading: dl.active(),
      settings: {
        maxHeight: cfg.maxHeight,
        deleteWatchedAfterHours: cfg.deleteWatchedAfterHours,
        sponsorblock: cfg.sponsorblockRemove || null,
      },
    }))
    .get("/api/health", async () => ({ ok: true, ytdlp: await dl.version() }))
    .post("/api/videos", async ({ body, set }) => {
      // Accept JSON {text} / {url} / {urls}, or a raw text body (handy for iOS Shortcuts and curl).
      let text = "";
      if (typeof body === "string") text = body;
      else if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        text = [b.text, b.url, ...(Array.isArray(b.urls) ? b.urls : [])].filter((x) => typeof x === "string").join("\n");
      }
      const result = await addFromText(text);
      if (!result.found) {
        set.status = 400;
        return { ...result, error: "No links found in that text." };
      }
      return result;
    })
    .get("/add", async ({ query, set }) => {
      // Bookmarklet / share-sheet entry point: /add?url=...
      const q = query as Record<string, string | undefined>;
      await addFromText([q.url, q.text].filter(Boolean).join("\n"));
      set.status = 302;
      set.headers.location = "/";
      return "Added";
    })
    .patch(
      "/api/videos/:id",
      ({ params, body, set }) => {
        const id = toId(params.id);
        const v = db.get(id);
        if (!v) {
          set.status = 404;
          return { error: "not found" };
        }
        if (body.watched === true && !v.watched) {
          db.update(id, { watched: 1, watched_at: Date.now(), resume_at: 0 });
        } else if (body.watched === false && v.watched) {
          // Back into the queue at the end. If its file was cleaned up, fetch it again.
          const maxSort = Math.max(0, ...db.list().map((x) => x.sort));
          db.update(id, {
            watched: 0,
            watched_at: null,
            sort: maxSort + 1,
            ...(v.file ? {} : { status: "queued", progress: 0, error: null }),
          });
          dl.pump();
        }
        if (typeof body.resumeAt === "number" && body.resumeAt >= 0) db.update(id, { resume_at: body.resumeAt });
        return present(db.get(id)!);
      },
      {
        body: t.Object({ watched: t.Optional(t.Boolean()), resumeAt: t.Optional(t.Number()) }),
      },
    )
    .post(
      "/api/videos/:id/retry",
      ({ params, set }) => {
        const v = db.get(toId(params.id));
        if (!v) {
          set.status = 404;
          return { error: "not found" };
        }
        if (v.status === "failed" || (v.watched && !v.file)) {
          db.update(v.id, { status: "queued", progress: 0, error: null });
          dl.pump();
        }
        return present(db.get(v.id)!);
      },
    )
    .delete(
      "/api/videos/:id",
      ({ params }) => {
        const id = toId(params.id);
        dl.discard(id);
        db.remove(id);
        return { ok: true };
      },
    )
    .post(
      "/api/reorder",
      ({ body }) => {
        db.reorder(body.ids);
        return { ok: true };
      },
      { body: t.Object({ ids: t.Array(t.Integer()) }) },
    )
    .post("/api/clear-watched", () => {
      const rows = db.watchedRows();
      for (const v of rows) {
        dl.discard(v.id);
        db.remove(v.id);
      }
      return { removed: rows.length };
    })

    // ---- files ----
    .get("/media/:file", ({ params, request, set }) => {
      const path = join(cfg.videosDir, params.file);
      if (!SAFE_NAME.test(params.file) || !existsSync(path)) {
        set.status = 404;
        return "Not found";
      }
      return serveFile(path, request);
    })
    .get("/thumbs/:file", ({ params, request, set }) => {
      const path = join(cfg.videosDir, params.file);
      if (!SAFE_NAME.test(params.file) || !params.file.endsWith(".jpg") || !existsSync(path)) {
        set.status = 404;
        return "Not found";
      }
      return serveFile(path, request, "public, max-age=86400");
    })

    // ---- the page ----
    .get("/", ({ request }) => serveFile(join(PUBLIC_DIR, "index.html"), request))
    .get("/:asset", ({ params, request, set }) => {
      const name = params.asset;
      const path = join(PUBLIC_DIR, name);
      if (!/^[\w.-]+$/.test(name) || !existsSync(path)) {
        set.status = 404;
        return "Not found";
      }
      return serveFile(path, request);
    });
}
