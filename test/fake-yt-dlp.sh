#!/usr/bin/env bash
# Stand-in for yt-dlp in tests: speaks the same SPOOL* print lines Spool asks the real one for.
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then echo "2099.01.01-fake"; exit 0; fi
if [[ "${1:-}" == "-U" ]]; then echo "fake yt-dlp is up to date"; exit 0; fi
dir="."; out=""; url=""; flat=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -P) dir="$2"; shift 2 ;;
    -o) [[ -z "$out" ]] && out="$2"; shift 2 ;;
    --flat-playlist) flat=1; shift ;;
    --) url="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ $flat == 1 ]]; then
  echo "https://www.youtube.com/watch?v=AAAAAAAAAAA"
  echo "https://www.youtube.com/watch?v=BBBBBBBBBBB"
  exit 0
fi
if [[ "$url" == *fail* ]]; then echo "ERROR: [generic] Video unavailable" >&2; exit 1; fi
echo 'SPOOLMETA {"id": "x", "title": "Fake video", "channel": "Fake channel", "duration": 61, "filesize_approx": 2000}'
echo "SPOOLPROG 500 1500 NA"
echo "SPOOLPROG 1500 1500 NA"
echo "SPOOLPROG 250 500 NA"
[[ "$url" == *slow* ]] && sleep 5
echo "SPOOLPROG 500 500 NA"
file="$dir/${out%%.*}.mp4"
head -c 2000 /dev/zero > "$file"
head -c 10 /dev/zero > "$dir/${out%%.*}.jpg"
echo "SPOOLFILE $file"
