# LANDMINE

LAN Distributed Music Integrated Node Engine :)   
Maybe start a group Jam, everybody adds to queue, everybody enjoys!

---
<img width="1454" height="967" alt="image" src="https://github.com/user-attachments/assets/c630159e-27ee-44e4-b28f-502f073f3975" />

---

One server holds the queue and the playback state. Any phone or laptop on the
same Wi-Fi opens the page and gets the full player. Sound comes out of one
device at a time, and you choose which from the "Playing on" button.

## Run it

```bash
npm install
npm start
```

Open the address it prints. Needs Node 20+ and `yt-dlp` on your PATH.

Put settings in a `.env` file next to `package.json`:

```
GEMINI_API_KEY=your_key
```
## The DJ

Gemini only proposes titles. Each one is matched to a real YouTube result, and
misses and duplicates are dropped. It tops the queue up once the last track is
half over. Setting a mood lines tracks up right after the current song.  

<img width="659" height="329" alt="image" src="https://github.com/user-attachments/assets/e4af76e8-2def-48ee-937e-b59d8065595d" />



## Environment variables

| Variable | What it does |
|---|---|
| `GEMINI_API_KEY` | Turns the DJ on. Free key at aistudio.google.com/apikey. |
| `GEMINI_MODEL` | Defaults to `gemini-3.1-flash-lite`. |
| `YTDLP_PATH` | If yt-dlp is not on your PATH. |
| `YTDLP_JS_RUNTIME` | Defaults to the Node running the server. Set `off` to disable, or e.g. `deno`. |
| `YTDLP_COOKIES_FROM_BROWSER` | e.g. `firefox`. Fixes tracks that need a signed-in session. |
| `YTDLP_COOKIES_FILE` | Same idea, from a cookies.txt file. |
| `YTDLP_REMOTE_COMPONENTS` | e.g. `ejs:github`, if yt-dlp reports its challenge solver is missing. |
| `YTDLP_EXTRA_ARGS` | Extra yt-dlp flags, space separated. |
| `CACHE_DIR`, `CACHE_MAX_TRACKS` | Where downloaded tracks live (default: temp dir, 80 tracks). |
| `PORT` | Defaults to 3000. |

## How the queue works

The queue is one list you can see: history, now playing, up next. What is
listed is exactly what plays, in that order.

- **Shuffle** reorders the up-next tracks in place. Nothing jumps around.
- **Play next** (search results) inserts right after the current track.
- Pasting a YouTube link in the search bar adds it straight to the queue.
  `watch`, `youtu.be`, `shorts`, `live` and `embed` links add one song;
  `playlist` links (and video links carrying a `list=`) add every song in order.
- Adding a song that is already up next is ignored, not duplicated.
- Previous at the first track restarts it. Next at the end stops.
- Adding a song to a finished queue starts it.

## Why some tracks used to fail

Each track is downloaded by yt-dlp itself, one to three ahead of time, then
served from disk. That removes the URL-forwarding problems of the old version.

Recent YouTube also needs a JavaScript runtime for yt-dlp to see every audio
format, and yt-dlp only switches on Deno by default. LANDMINE hands it the Node
that is already running, which is the likeliest reason only some tracks played.

A track that still can't be fetched is marked "Unavailable" with a plain reason
(private, age-restricted, region-blocked, and so on) and skipped, with one
short message instead of a stack of errors. Server logs carry yt-dlp's own
last lines for anything odd.



## Tests

```bash
npm test
```
