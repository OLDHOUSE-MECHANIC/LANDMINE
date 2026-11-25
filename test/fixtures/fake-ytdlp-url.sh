#!/bin/sh
# Stand-in for yt-dlp that prints metadata JSON instead of downloading audio.
[ "$1" = "--version" ] && { echo "2026.08.19"; exit 0; }

single=""; flat=""
for a in "$@"; do
  case "$a" in
    --dump-single-json) single=1 ;;
    --flat-playlist) flat=1 ;;
  esac
done

if [ -n "$single" ]; then
  id=""
  for a in "$@"; do
    case "$a" in
      *v=*) id="${a##*v=}" ;;
    esac
  done
  printf '{"id":"%s","title":"Solo (Official Video)","uploader":"Artist - Topic","duration":180}\n' "$id"
  exit 0
fi

if [ -n "$flat" ]; then
  printf '%s\n' \
    '{"id":"vid11111111","title":"First song","channel":"Channel A","duration":120}' \
    '{"id":"vid22222222","title":"Second song","channel":"Channel B"}' \
    '{"id":"vid11111111","title":"Duplicate","channel":"Channel A"}'
  exit 0
fi

echo "unexpected yt-dlp args: $*" >&2
exit 1
