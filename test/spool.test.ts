import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createDownloader, downloadArgs, ProgressTracker } from "../src/downloader.ts";
import { createApp, serveFile } from "../src/app.ts";
import { canonical, extractUrls, isPlaylist, youtubeId } from "../src/urls.ts";
import { sessionToken } from "../src/auth.ts";

describe("urls", () => {
  test("pulls links out of messy paste", () => {
    const text = "check https://youtu.be/dQw4w9WgXcQ, and\nhttps://www.youtube.com/watch?v=jNQXAC9IVRw&t=5 (lol)";
    expect(extractUrls(text)).toEqual([
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5",
    ]);
  });
  test("finds video ids in every common shape", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    ]) expect(youtubeId(u)).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://vimeo.com/123")).toBeNull();
  });
  test("playlists vs videos in playlists", () => {
    expect(isPlaylist("https://www.youtube.com/playlist?list=PL123")).toBe(true);
    expect(isPlaylist("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123")).toBe(false);
  });
  test("canonical form dedupes", () => {
    expect(canonical("https://youtu.be/dQw4w9WgXcQ?t=3").url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

describe("downloader pieces", () => {
  test("asks for browser-friendly H.264 MP4 and the JS runtime on YouTube", () => {
    const args = downloadArgs(config, { id: 7, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(args).toContain("--merge-output-format");
    expect(args.join(" ")).toContain("vcodec:h264");
    expect(args).toContain("--js-runtimes");
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(args.at(-2)).toBe("--");
  });
  test("progress spans the video and audio downloads", () => {
    const p = new ProgressTracker(2000);
    expect(p.push(1500, 1500)).toBeCloseTo(0.75);
    expect(p.push(250, 500)).toBeCloseTo(0.875);
    expect(p.push(500, 500)).toBeCloseTo(0.99);
  });
});

describe("range requests", () => {
  const dir = mkdtempSync(join(tmpdir(), "spool-range-"));
  const f = join(dir, "1.mp4");
  writeFileSync(f, "0123456789");
  const get = (range?: string) =>
    serveFile(f, new Request("http://x/media/1.mp4", { headers: range ? { range } : {} }));
  test("full, partial, suffix and bad ranges", async () => {
    expect((await get()).status).toBe(200);
    const r = await get("bytes=2-4");
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await r.text()).toBe("234");
    expect(await (await get("bytes=-3")).text()).toBe("789");
    expect(await (await get("bytes=8-")).text()).toBe("89");
    expect((await get("bytes=50-")).status).toBe(416);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

describe("app", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let db: ReturnType<typeof openDb>;
  const call = (path: string, init?: RequestInit) => app.handle(new Request(`http://spool${path}`, init));
  const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const state = async () => (await (await call("/api/state")).json()).videos as any[];
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) { if (await fn()) return; await Bun.sleep(50); }
    throw new Error("timed out");
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "spool-app-"));
    const cfg = {
      ...config,
      dataDir: dir,
      videosDir: join(dir, "videos"),
      dbPath: ":memory:",
      ytdlp: join(import.meta.dir, "fake-yt-dlp.sh"),
      password: "",
    };
    db = openDb(":memory:");
    const dl = createDownloader(cfg, db, () => {});
    require("node:fs").mkdirSync(cfg.videosDir, { recursive: true });
    app = createApp(cfg, db, dl, { fetchTitles: false });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("adds, dedupes, downloads and serves", async () => {
    const r = await (await call("/api/videos", json({ text: "https://youtu.be/dQw4w9WgXcQ https://www.youtube.com/watch?v=dQw4w9WgXcQ" }))).json();
    expect(r).toMatchObject({ added: 1, skipped: 1 });
    await until(async () => (await state())[0]?.status === "ready");
    const [v] = await state();
    expect(v).toMatchObject({ title: "Fake video", channel: "Fake channel", duration: 61, src: "/media/1.mp4", thumbnail: "/thumbs/1.jpg" });
    const media = await call("/media/1.mp4", { headers: { range: "bytes=0-9" } });
    expect(media.status).toBe(206);
  });

  test("failed downloads say why and can be retried", async () => {
    await call("/api/videos", json({ url: "https://example.com/fail" }));
    await until(async () => (await state()).some((v) => v.status === "failed"));
    const failed = (await state()).find((v) => v.status === "failed");
    expect(failed.error).toContain("Video unavailable");
    const retried = await (await call(`/api/videos/${failed.id}/retry`, { method: "POST" })).json();
    expect(["queued", "downloading", "failed"]).toContain(retried.status);
  });

  test("playlists expand into their videos", async () => {
    const r = await (await call("/api/videos", json({ text: "https://www.youtube.com/playlist?list=PLfake" }))).json();
    expect(r.added).toBe(2);
  });

  test("raw text bodies work (for Shortcuts and curl)", async () => {
    const r = await call("/api/videos", { method: "POST", headers: { "content-type": "text/plain" }, body: "https://youtu.be/CCCCCCCCCCC" });
    expect((await r.json()).added).toBe(1);
  });

  test("reorder, watch, unwatch, remove", async () => {
    await until(async () => (await state()).every((v) => v.status !== "downloading" && v.status !== "queued"));
    const ids = (await state()).filter((v) => !v.watched).map((v) => v.id);
    const reversed = [...ids].reverse();
    await call("/api/reorder", json({ ids: reversed }));
    expect((await state()).map((v) => v.id)).toEqual(reversed);

    const first = reversed[0];
    await call(`/api/videos/${first}`, json({ resumeAt: 42 }, "PATCH"));
    expect((await state()).find((v) => v.id === first).resumeAt).toBe(42);
    const w = await (await call(`/api/videos/${first}`, json({ watched: true }, "PATCH"))).json();
    expect(w).toMatchObject({ watched: true, resumeAt: 0 });
    expect((await state()).at(-1).id).toBe(first); // watched sorts after the queue
    await call(`/api/videos/${first}`, json({ watched: false }, "PATCH"));
    expect((await state()).find((v) => v.id === first).watched).toBe(false);

    expect((await call("/api/videos/999", json({ watched: true }, "PATCH"))).status).toBe(404);
    await call(`/api/videos/${first}`, { method: "DELETE" });
    expect((await state()).some((v) => v.id === first)).toBe(false);
    expect(existsSync(join(dir, "videos", `${first}.mp4`))).toBe(false);
  });

  test("clear watched deletes files", async () => {
    const [v] = (await state()).filter((x) => x.status === "ready");
    await call(`/api/videos/${v.id}`, json({ watched: true }, "PATCH"));
    const r = await (await call("/api/clear-watched", { method: "POST" })).json();
    expect(r.removed).toBe(1);
    expect(existsSync(join(dir, "videos", `${v.id}.mp4`))).toBe(false);
  });

  test("removing a video mid-download stops it and leaves no files", async () => {
    const r = await (await call("/api/videos", json({ url: "https://example.com/slow" }))).json();
    expect(r.added).toBe(1);
    await until(async () => (await state()).some((v) => v.url.includes("slow") && v.status === "downloading" && v.progress > 0));
    const v = (await state()).find((x) => x.url.includes("slow"));
    await call(`/api/videos/${v.id}`, { method: "DELETE" });
    await Bun.sleep(300);
    expect((await state()).some((x) => x.id === v.id)).toBe(false);
    expect(existsSync(join(dir, "videos", `${v.id}.mp4`))).toBe(false);
  });

  test("refuses path tricks on media", async () => {
    expect((await call("/media/..%2Fspool.db")).status).toBe(404);
    expect((await call("/thumbs/1.mp4")).status).toBe(404);
  });
});

describe("password", () => {
  const db = openDb(":memory:");
  const cfg = { ...config, password: "hunter2", ytdlp: "/bin/false" };
  const app = createApp(cfg, db, createDownloader(cfg, db, () => {}), { fetchTitles: false });
  const call = (path: string, init?: RequestInit) => app.handle(new Request(`http://spool${path}`, init));

  test("locks the API until you sign in", async () => {
    expect((await call("/api/state")).status).toBe(401);
    expect((await call("/")).status).toBe(200); // the page itself loads so it can show the sign-in form
    const bad = await call("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: '{"password":"nope"}' });
    expect(bad.status).toBe(401);
    const ok = await call("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: '{"password":"hunter2"}' });
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toContain(sessionToken("hunter2"));
    expect((await call("/api/state", { headers: { cookie: cookie.split(";")[0]! } })).status).toBe(200);
    expect((await call("/api/state", { headers: { authorization: "Bearer hunter2" } })).status).toBe(200);
    expect((await call("/add?url=https://youtu.be/dQw4w9WgXcQ")).status).toBe(302);
    expect((await db.list()).length).toBe(0);
  });
});
