#!/bin/sh
# Stand-in for yt-dlp. Behaviour is chosen by the video id in the URL.
url="$1"; id="${url##*v=}"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
[ "$1" = "--version" ] && { echo "2026.08.19"; exit 0; }
echo "$id" >> "$FAKE_LOG"
case "$id" in
  *FAIL*)  echo "ERROR: [youtube] $id: Video unavailable" >&2; exit 1 ;;
  *AGE*)   echo "ERROR: [youtube] $id: Sign in to confirm your age" >&2; exit 1 ;;
  *NOJS*)  echo "WARNING: [youtube] No supported JavaScript runtime could be found." >&2
           echo "ERROR: [youtube] $id: Requested format is not available" >&2; exit 1 ;;
  *FLAKY*) marker="$FAKE_LOG.$id"
           if [ ! -f "$marker" ]; then touch "$marker"; echo "ERROR: unable to download: HTTP Error 503" >&2; exit 1; fi ;;
  *SLOW*)  sleep 0.4 ;;
esac
file="$(echo "$out" | sed "s/%(id)s/$id/; s/%(ext)s/m4a/")"
printf 'audio' > "$file.part"; mv "$file.part" "$file"
echo "$file"
