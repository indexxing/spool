import { join, resolve } from "node:path";

const env = Bun.env;

function int(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return n;
}

const dataDir = resolve(env.SPOOL_DATA_DIR ?? "./data");

export const config = {
  port: int("PORT", 3000),
  host: env.HOST ?? "0.0.0.0",
  dataDir,
  videosDir: join(dataDir, "videos"),
  dbPath: join(dataDir, "spool.db"),
  /** Optional. When set, the page asks for it once and remembers you with a cookie. */
  password: env.SPOOL_PASSWORD ?? "",
  ytdlp: env.SPOOL_YTDLP ?? "yt-dlp",
  /** Highest resolution to fetch. 1080 keeps files small and plays smoothly everywhere. */
  maxHeight: int("SPOOL_MAX_HEIGHT", 1080),
  /** How many downloads run at once. 1 is kind to a Pi's SD card and network. */
  concurrency: Math.max(1, int("SPOOL_CONCURRENCY", 1)),
  /** Delete a watched video's file this many hours after you finish it. 0 keeps files forever. */
  deleteWatchedAfterHours: Math.max(0, int("SPOOL_DELETE_WATCHED_AFTER_HOURS", 24)),
  /** Comma list of SponsorBlock categories to cut out (e.g. "sponsor,selfpromo"). Empty = off. */
  sponsorblockRemove: (env.SPOOL_SPONSORBLOCK ?? "").trim(),
  /** Optional Netscape cookies file for members-only or age-gated videos. */
  cookiesFile: env.SPOOL_COOKIES ?? "",
  /** JS runtime yt-dlp uses for YouTube's player challenges. The Docker image ships Bun. */
  jsRuntime: env.SPOOL_JS_RUNTIME ?? "bun",
  /** Run `yt-dlp -U` at startup (only works with the standalone binary). */
  autoUpdateYtdlp: (env.SPOOL_YTDLP_AUTOUPDATE ?? "1") !== "0",
  /** Extra raw yt-dlp arguments, space separated. */
  extraArgs: (env.SPOOL_YTDLP_ARGS ?? "").split(/\s+/).filter(Boolean),
} as const;

export type Config = typeof config;
