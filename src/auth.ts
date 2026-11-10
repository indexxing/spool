import { timingSafeEqual } from "node:crypto";

export const COOKIE = "spool_session";

/** A stable session value derived from the password, so restarts don't log you out. */
export function sessionToken(password: string): string {
  const h = new Bun.CryptoHasher("sha256", password);
  h.update("spool-session-v1");
  return h.digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** True when no password is set, or the request carries the right cookie or Bearer token. */
export function isAuthed(req: Request, password: string): boolean {
  if (!password) return true;
  const expected = sessionToken(password);
  const cookie = readCookie(req.headers.get("cookie"), COOKIE);
  if (cookie && safeEqual(cookie, expected)) return true;
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return safeEqual(auth.slice(7), password);
  return false;
}

export function checkPassword(given: string, password: string): boolean {
  return safeEqual(given, password);
}
