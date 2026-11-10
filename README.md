# Spool

Paste YouTube links, and your Pi downloads them with yt-dlp. Then they play back to back, ad free, on any browser on your home network.

- Paste one link or a whole pile (or a playlist link), and press Enter. You can paste anywhere on the page too.
- Videos download in order, one at a time, as H.264/AAC MP4 up to 1080p, so they play natively in Safari, Chrome and Firefox and the Pi never has to re-encode.
- The player autoplays the next video, remembers where you stopped, and shows lock screen and media key controls on iPhone and Mac.
- You can reorder the queue (arrows, or drag on desktop), remove videos, retry failed ones, and put watched ones back.
- Watched files are deleted 24 hours after you finish them, so the SD card doesn't fill up. The entry stays, and "Watch again" downloads it again.
- It's built with Bun, Elysia and SQLite, with no frontend build step. Its only runtime dependency is Elysia.

It's for personal use: one person, on their own network.

## Deploy with Coolify

1. In Coolify, add a new resource from this Git repository (public repo, or private through Coolify's GitHub App or a deploy key).
2. Pick **Docker Compose** as the build pack. The compose file is `/docker-compose.yml`.
3. Set any variables from `.env.example` in the resource's Environment Variables tab. Coolify lists them from the compose file. All are optional.
4. Deploy. The image builds for whichever architecture the server runs (arm64 on a Pi 5, or amd64).

The compose file publishes port 8088 on the host, so Spool is at `http://<server-ip>:8088` on your LAN. If you'd rather go through Coolify's proxy with a domain, set the domain on the `spool` service to port 3000 and drop the `ports:` lines. Downloads and the database live in the `spool-data` volume, which Coolify keeps across redeploys.

## Deploy with plain Docker Compose

You need Docker with the compose plugin.

```sh
git clone https://github.com/indexxing/spool && cd spool
cp .env.example .env        # optional, then edit it
docker compose up -d --build
```

Open `http://<pi-hostname-or-ip>:8088`. To browse the downloaded files, run `docker compose exec spool ls /data/videos`.

**Updating yt-dlp:** YouTube changes things often and yt-dlp keeps up. Spool runs `yt-dlp -U` every time it starts, so if downloads start failing, restart the container. Rebuilding the image also fetches the newest release.

## Settings

All optional. Set them in `.env` (compose picks them up) or in Coolify.

| Variable | Default | What it does |
| --- | --- | --- |
| `SPOOL_PASSWORD` | empty | When set, the page asks for it once and remembers you for a year. Set it if Spool is ever reachable beyond your LAN (for example over a Cloudflare Tunnel). |
| `SPOOL_MAX_HEIGHT` | `1080` | Highest resolution to fetch. Use `720` to save space. |
| `SPOOL_CONCURRENCY` | `1` | Downloads at once. |
| `SPOOL_DELETE_WATCHED_AFTER_HOURS` | `24` | Hours after you finish a video before its file is deleted. `0` keeps files forever. |
| `SPOOL_SPONSORBLOCK` | empty | SponsorBlock categories to cut out of the video, such as `sponsor,selfpromo,interaction`. This sends video ids to the SponsorBlock API. |
| `SPOOL_YTDLP_AUTOUPDATE` | `1` | Set `0` to skip the startup self-update. |
| `SPOOL_COOKIES` | empty | Path inside the container to a Netscape `cookies.txt`, for age-gated or members-only videos. Copy it into the data volume (for example `docker cp cookies.txt <container>:/data/cookies.txt`) and set this to `/data/cookies.txt`. |
| `SPOOL_YTDLP_ARGS` | empty | Extra raw yt-dlp flags, space separated. |
| `PORT` | `3000` | Port inside the container. |

At 1080p, expect very roughly 30 to 40 MB per minute of video. At 720p it's about half that.

## Adding links from elsewhere

**Bookmarklet:** drag the "+ Spool bookmarklet" link at the bottom of the page to your bookmarks bar. Clicking it on a YouTube page sends that video to Spool.

**Share sheet on iPhone (Shortcuts):** make a shortcut that receives URLs from the share sheet and runs "Get contents of URL":

- URL: `http://<pi>:8088/api/videos`
- Method: `POST`
- Request body: Text, set to the Shortcut Input
- Header (only if you set a password): `Authorization: Bearer <your password>`

**curl:**

```sh
curl -X POST http://pi:8088/api/videos -H 'content-type: text/plain' \
  --data 'https://youtu.be/dQw4w9WgXcQ https://youtu.be/jNQXAC9IVRw'
```

Any site that yt-dlp supports works, not only YouTube. Only YouTube links are de-duplicated and get a title before downloading.

## API

| Method and path | Body | Notes |
| --- | --- | --- |
| `GET /api/state` | | Queue first (in order), then watched. |
| `POST /api/videos` | `{ "text": "...links..." }`, `{ "urls": [...] }` or plain text | Adds every link found. Playlist links expand into their videos. |
| `GET /add?url=...` | | Adds and redirects to the page (used by the bookmarklet). |
| `PATCH /api/videos/:id` | `{ "watched": true/false, "resumeAt": seconds }` | |
| `POST /api/videos/:id/retry` | | |
| `DELETE /api/videos/:id` | | Stops a running download and deletes the files. |
| `POST /api/reorder` | `{ "ids": [3, 1, 2] }` | New order for the queue. |
| `POST /api/clear-watched` | | Removes watched entries and their files. |
| `GET /media/:file` | | The video, with HTTP range support (Safari needs it). |
| `GET /api/health` | | Reports the yt-dlp version. Used by the Docker healthcheck. |

## Develop

```sh
bun install
SPOOL_DATA_DIR=./data bun run dev   # needs yt-dlp and ffmpeg on your PATH
bun test                            # uses a fake yt-dlp, no network needed
bun run typecheck
```

Layout: `src/index.ts` starts everything, `src/app.ts` holds the routes, `src/downloader.ts` runs and parses yt-dlp, `src/db.ts` is the SQLite queue, and `public/` is the page.
