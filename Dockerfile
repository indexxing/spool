# Spool: paste YouTube links, watch them back to back on your LAN.
# Builds for arm64 (Raspberry Pi 5) and amd64.
FROM oven/bun:1.4.4-slim

ARG TARGETARCH
# ffmpeg merges the separate video and audio streams into one MP4 and converts thumbnails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The standalone yt-dlp build bundles Python and YouTube's challenge solver scripts.
# It lives somewhere the app user can write, so `yt-dlp -U` can update it at startup.
RUN mkdir -p /app/bin /data \
 && case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      arm64) asset=yt-dlp_linux_aarch64 ;; \
      amd64) asset=yt-dlp_linux ;; \
      *) echo "unsupported arch ${TARGETARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL -o /app/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}" \
 && chmod +x /app/bin/yt-dlp \
 && /app/bin/yt-dlp --version

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY public ./public

RUN chown -R bun:bun /app /data
USER bun

ENV NODE_ENV=production \
    PORT=3000 \
    SPOOL_DATA_DIR=/data \
    SPOOL_YTDLP=/app/bin/yt-dlp \
    SPOOL_JS_RUNTIME=bun
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/index.ts"]
