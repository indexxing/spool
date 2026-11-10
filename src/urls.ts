/** Pull every http(s) link out of whatever was pasted: one per line, space separated, or mixed with text. */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let raw of found) {
    raw = raw.replace(/[),.;!?]+$/, ""); // trailing punctuation from prose
    try {
      const u = new URL(raw);
      const key = u.toString();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    } catch {
      /* not a URL after all */
    }
  }
  return out;
}

const YT_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be",
]);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isYouTube(url: string): boolean {
  try {
    return YT_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** The 11-character video id for any common YouTube link shape, or null. */
export function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  let id: string | null | undefined = null;
  if (host === "youtu.be") id = parts[0];
  else if (parts[0] === "watch") id = u.searchParams.get("v");
  else if (["shorts", "embed", "live", "v", "e"].includes(parts[0] ?? "")) id = parts[1];
  else id = u.searchParams.get("v");
  return id && ID_RE.test(id) ? id : null;
}

/** A link that is a whole playlist (not a video that happens to sit in one). */
export function isPlaylist(url: string): boolean {
  if (!isYouTube(url)) return false;
  const u = new URL(url);
  return u.pathname === "/playlist" && u.searchParams.has("list");
}

/** A tidy canonical link for a YouTube video, so the same video pasted two ways is one entry. */
export function canonical(url: string): { url: string; sourceId: string | null } {
  const id = youtubeId(url);
  if (id) return { url: `https://www.youtube.com/watch?v=${id}`, sourceId: `yt:${id}` };
  return { url, sourceId: null };
}
