import { mkdirSync } from "node:fs";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { createDownloader } from "./downloader.ts";
import { createApp } from "./app.ts";

mkdirSync(config.videosDir, { recursive: true });
const db = openDb(config.dbPath);
db.resetInterrupted(); // anything mid-download when we stopped goes back in line (yt-dlp resumes .part files)

const dl = createDownloader(config, db);
const app = createApp(config, db, dl).listen({ port: config.port, hostname: config.host });

console.log(`[spool] listening on http://${config.host}:${config.port}`);
if (!config.password) console.log("[spool] no SPOOL_PASSWORD set; anyone on your network can use it");

dl.selfUpdate()
  .then(() => dl.version())
  .then((v) => {
    if (v) console.log(`[spool] yt-dlp ${v}`);
    else console.error(`[spool] couldn't run yt-dlp at "${config.ytdlp}"; downloads will fail until it's installed`);
    dl.pump();
  });

dl.sweep();
setInterval(() => dl.sweep(), 15 * 60_000);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.stop();
    db.raw.close();
    process.exit(0);
  });
}
