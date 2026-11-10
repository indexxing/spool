import { readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { Subprocess } from "bun";
import type { Config } from "./config.ts";
import type { Db, Video } from "./db.ts";
import { isYouTube } from "./urls.ts";

type Log = (...args: unknown[]) => void;

export interface Meta {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
  filesize_approx?: number;
}

/** Build the yt-dlp argument list for one queue entry. Exported so tests can check it. */
export function downloadArgs(cfg: Config, row: Pick<Video, "id" | "url">): string[] {
  const h = cfg.maxHeight;
  const args = [
    "--no-playlist",
    "--newline",
    "--progress",
    "--no-colors",
    "--no-mtime",
    "--match-filter", "!is_live",
    // Prefer H.264 + AAC in MP4: it plays natively in Safari, Chrome and Firefox,
    // and the Pi only has to copy streams, never re-encode.
    "-f", `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`,
    "-S", `vcodec:h264,res:${h},acodec:m4a`,
    "--merge-output-format", "mp4",
    "--remux-video", "mp4",
    "--write-thumbnail",
    "--convert-thumbnails", "jpg",
    "-P", cfg.videosDir,
    "-o", `${row.id}.%(ext)s`,
    "-o", `thumbnail:${row.id}.%(ext)s`,
    "--no-simulate",
    "--print", "before_dl:SPOOLMETA %(.{id,title,channel,uploader,duration,thumbnail,filesize_approx})j",
    "--print", "after_move:SPOOLFILE %(filepath)s",
    "--progress-template",
    "download:SPOOLPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
  ];
  if (cfg.jsRuntime && isYouTube(row.url)) args.push("--js-runtimes", cfg.jsRuntime);
  if (cfg.sponsorblockRemove) args.push("--sponsorblock-remove", cfg.sponsorblockRemove);
  if (cfg.cookiesFile) args.push("--cookies", cfg.cookiesFile);
  args.push(...cfg.extraArgs, "--", row.url);
  return args;
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.search(/\r?\n|\r/)) !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + (buf[nl] === "\r" && buf[nl + 1] === "\n" ? 2 : 1));
    }
  }
  if (buf) yield buf;
}

const num = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Track progress across the separate video and audio downloads yt-dlp does before merging. */
export class ProgressTracker {
  private doneBytes = 0;
  private lastDownloaded = 0;
  private lastTotal = 0;
  constructor(private expectedTotal = 0) {}
  setExpected(total: number) {
    this.expectedTotal = total;
  }
  /** Feed one SPOOLPROG line's numbers, get 0..1 back. */
  push(downloaded: number, total: number): number {
    if (downloaded < this.lastDownloaded) {
      // A new stream started (audio after video).
      this.doneBytes += this.lastTotal || this.lastDownloaded;
    }
    this.lastDownloaded = downloaded;
    this.lastTotal = total;
    const overall = this.expectedTotal || this.doneBytes + total;
    if (!overall) return 0;
    return Math.min(0.99, (this.doneBytes + downloaded) / overall);
  }
}

export function createDownloader(cfg: Config, db: Db, log: Log = console.log) {
  const running = new Map<number, Subprocess>();
  const cancelled = new Set<number>();
  let active = 0;

  function filesFor(id: number): string[] {
    if (!existsSync(cfg.videosDir)) return [];
    const prefix = `${id}.`;
    return readdirSync(cfg.videosDir).filter((f) => f.startsWith(prefix));
  }

  function deleteFiles(id: number) {
    for (const f of filesFor(id)) rmSync(join(cfg.videosDir, f), { force: true });
  }

  function applyMeta(id: number, meta: Meta, keepTitle = false) {
    const current = db.get(id);
    db.update(id, {
      title: keepTitle && current?.title ? current.title : meta.title ?? current?.title ?? null,
      channel: meta.channel ?? meta.uploader ?? current?.channel ?? null,
      duration: meta.duration ?? current?.duration ?? null,
      thumbnail: current?.thumbnail ?? meta.thumbnail ?? null,
    });
  }

  async function run(row: Video) {
    db.update(row.id, { status: "downloading", progress: 0, error: null });
    const args = downloadArgs(cfg, row);
    log(`[spool] downloading #${row.id} ${row.url}`);
    let proc: Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([cfg.ytdlp, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (err) {
      db.update(row.id, { status: "failed", error: `Couldn't start yt-dlp (${cfg.ytdlp}): ${String(err)}` });
      return;
    }
    running.set(row.id, proc);

    const tracker = new ProgressTracker();
    let file: string | null = null;
    let lastWrite = 0;
    const errors: string[] = [];
    const tail: string[] = [];

    const readOut = (async () => {
      for await (const line of lines(proc.stdout)) {
        if (line.startsWith("SPOOLMETA ")) {
          try {
            const meta = JSON.parse(line.slice(10)) as Meta;
            applyMeta(row.id, meta);
            if (meta.filesize_approx) tracker.setExpected(meta.filesize_approx);
          } catch {
            /* odd metadata line, ignore */
          }
        } else if (line.startsWith("SPOOLPROG ")) {
          const [, d, t, te] = line.split(" ");
          const p = tracker.push(num(d), num(t) || num(te));
          const now = Date.now();
          if (now - lastWrite > 750) {
            lastWrite = now;
            db.update(row.id, { progress: p });
          }
        } else if (line.startsWith("SPOOLFILE ")) {
          file = line.slice(10).trim();
        }
      }
    })();
    const readErr = (async () => {
      for await (const line of lines(proc.stderr)) {
        if (!line.trim()) continue;
        if (line.startsWith("ERROR:")) errors.push(line.replace(/^ERROR:\s*/, ""));
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    })();

    const code = await proc.exited;
    await Promise.all([readOut, readErr]);
    running.delete(row.id);

    if (cancelled.delete(row.id)) {
      deleteFiles(row.id);
      return;
    }
    if (!db.get(row.id)) return; // removed while running

    const finalFile = file && existsSync(file) ? basename(file) : findVideoFile(row.id);
    if (code === 0 && finalFile) {
      const thumb = filesFor(row.id).find((f) => f.endsWith(".jpg"));
      db.update(row.id, {
        status: "ready",
        progress: 1,
        file: finalFile,
        size: statSync(join(cfg.videosDir, finalFile)).size,
        thumbnail: thumb ? `local:${thumb}` : db.get(row.id)?.thumbnail ?? null,
        error: null,
      });
      log(`[spool] ready #${row.id} ${finalFile}`);
    } else {
      const reason =
        errors.at(-1) ??
        (code === 0 ? "yt-dlp finished without a video file (live streams and premieres are skipped)." : tail.at(-1)) ??
        `yt-dlp exited with code ${code}`;
      db.update(row.id, { status: "failed", error: reason.slice(0, 500) });
      log(`[spool] failed #${row.id}: ${reason}`);
    }
  }

  function findVideoFile(id: number): string | null {
    return (
      filesFor(id).find((f) => /\.(mp4|webm|mkv|mov|m4v)$/i.test(f) && !f.includes(".part") && !/\.f\d+\./.test(f)) ??
      null
    );
  }

  /** Start downloads until we hit the concurrency limit. Safe to call any time. */
  function pump() {
    while (active < cfg.concurrency) {
      const next = db.nextQueued();
      if (!next) break;
      // Mark it before the async work starts so the loop doesn't pick it twice.
      db.update(next.id, { status: "downloading" });
      active++;
      run(next)
        .catch((err) => db.update(next.id, { status: "failed", error: String(err) }))
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  /** Stop a download in progress (if any) and remove the entry's files. */
  function discard(id: number) {
    const proc = running.get(id);
    if (proc) {
      cancelled.add(id);
      proc.kill();
    } else {
      deleteFiles(id);
    }
  }

  /** Expand a playlist link into its video links. */
  async function expandPlaylist(url: string): Promise<string[]> {
    const args = ["--flat-playlist", "--no-warnings", "--print", "url"];
    if (cfg.cookiesFile) args.push("--cookies", cfg.cookiesFile);
    args.push("--", url);
    const proc = Bun.spawn([cfg.ytdlp, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(err.split("\n").find((l) => l.startsWith("ERROR:"))?.slice(7) ?? "Couldn't read that playlist.");
    return out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
  }

  /** Delete files of videos you finished more than N hours ago. Rows stay, so you can re-download. */
  function sweep() {
    if (!cfg.deleteWatchedAfterHours) return;
    const before = Date.now() - cfg.deleteWatchedAfterHours * 3_600_000;
    for (const v of db.staleWatched(before)) {
      deleteFiles(v.id);
      db.update(v.id, { file: null, size: null, status: "queued", progress: 0, thumbnail: v.thumbnail?.startsWith("local:") ? null : v.thumbnail });
      // Watched rows aren't picked up by the queue, so "queued" here just means "not on disk".
      log(`[spool] cleaned up watched #${v.id}`);
    }
  }

  async function selfUpdate() {
    if (!cfg.autoUpdateYtdlp) return;
    try {
      const proc = Bun.spawn([cfg.ytdlp, "-U"], { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      const last = `${out}\n${err}`.trim().split("\n").filter(Boolean).at(-1);
      if (last) log(`[spool] yt-dlp update${code === 0 ? "" : " failed"}: ${last}`);
    } catch (err) {
      log(`[spool] yt-dlp self-update skipped: ${String(err)}`);
    }
  }

  async function version(): Promise<string | null> {
    try {
      const proc = Bun.spawn([cfg.ytdlp, "--version"], { stdout: "pipe", stderr: "ignore" });
      const v = (await new Response(proc.stdout).text()).trim();
      return (await proc.exited) === 0 ? v : null;
    } catch {
      return null;
    }
  }

  return { pump, discard, expandPlaylist, sweep, selfUpdate, version, deleteFiles, active: () => active };
}

export type Downloader = ReturnType<typeof createDownloader>;
