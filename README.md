<img width="267" height="49" alt="image" src="https://github.com/user-attachments/assets/3030104c-c9af-4a51-9c8b-eea4a57e6db9" />  

LAN Distributed Music Integrated Node Engine :)   
Maybe start a group Jam, everybody adds to queue, everybody enjoys!

---
<img width="1454" height="967" alt="image" src="https://github.com/user-attachments/assets/c630159e-27ee-44e4-b28f-502f073f3975" />

---

<img width="267" height="49" alt="LANDMINE" src="https://github.com/user-attachments/assets/3030104c-c9af-4a51-9c8b-eea4a57e6db9" />

**L**AN **D**istributed **M**usic **I**ntelligence **N**ode **E**ngine
Locally shared music player for a room. One computer runs LANDMINE, and every phone
or laptop on the same Wi-Fi opens a web page and joins the same queue. Sound
comes out of one device at a time — choose which one with **Playing on**, and
hand the music around without stopping it.

No accounts, no apps to install on phones. Maybe start a group jam: everybody
adds to the queue, everybody enjoys.

<img width="1454" height="967" alt="LANDMINE player, queue and search" src="https://github.com/user-attachments/assets/c630159e-27ee-44e4-b28f-502f073f3975" />

## What it does

- **One shared queue.** History, now playing and up next are a single list
  everybody sees. What you see is exactly what plays, in that order.
- **Search or paste a link.** Search YouTube, or paste a `watch`, `youtu.be`,
  `shorts`, `live`, `embed` or `playlist` link straight into the search bar.
- **Real player controls.** Play/pause, next, previous, seek, volume, shuffle,
  repeat off/all/one, reorder up-next tracks, play next, remove and clear.
- **Pick the speaker.** Any connected device can become the speaker. Playback
  moves instantly and carries on from the same moment.
- **Made for phones and laptops.** A mini player on phones, a side panel on
  computers, keyboard shortcuts, media keys and per-device themes.
- **An optional DJ.** Gemini suggests songs in the mood you pick, tops the
  queue up before it runs dry, and skips misses and duplicates.
- **Tracks are ready ahead of time.** The current song and the next few are
  downloaded to disk, so playback and seeking are smooth.
- **Honest failures.** A song that can't be fetched is labelled "Unavailable"
  with a plain reason and skipped, instead of spewing errors at you.

## Quick start

### Windows — double-click to run

1. Download the project (**Code → Download ZIP**) and unzip it.
2. Double-click **`START-LANDMINE.bat`**.
3. Wait while it checks for Node.js and yt-dlp (and installs them if missing),
   then downloads the app's libraries.
4. Your browser opens automatically. **Keep the black window open** — closing
   it stops the server and the music.

Nothing to type. See [WINDOWS.md](WINDOWS.md) for a step-by-step guide and
fixes for the usual hiccups.

### macOS / Linux

Requires Node.js 20+ and `yt-dlp` on your PATH:

```bash
npm install
npm start
```

Open the address the server prints.

## Playing together

The server prints the address to open. On the hosting computer you can also
use `http://localhost:3000`; everyone else on the same Wi-Fi should open the
**LAN address** it prints, for example `http://192.168.1.23:3000`.

Every device gets its own copy of the player and can add, reorder and control
tracks. Only the device chosen under **Playing on** makes sound. If your phone
asks permission to play sound, tap **Enable sound**. If another device can't
connect, allow the server through Windows Firewall (or your OS equivalent).

## The DJ (optional)

Gemini only proposes titles. Each suggestion is matched to a real YouTube
result, and misses and duplicates are dropped. It tops the queue up once the
last track is half over. Setting a mood lines tracks up right after the
current song.

<img width="659" height="329" alt="The DJ mood and auto-fill controls" src="https://github.com/user-attachments/assets/e4af76e8-2def-48ee-937e-b59d8065595d" />

The DJ is off until you give it a key. Copy `.env.example` to `.env` and add:

```
GEMINI_API_KEY=your_key
```
## The DJ

Gemini only proposes titles. Each one is matched to a real YouTube result, and
misses and duplicates are dropped. It tops the queue up once the last track is
half over. Setting a mood lines tracks up right after the current song.  

<img width="659" height="329" alt="image" src="https://github.com/user-attachments/assets/e4af76e8-2def-48ee-937e-b59d8065595d" />



A free key is available at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
The `.env` file is ignored by git — your key stays on your machine.

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



=======
## Configuration

Settings live in a `.env` file next to `package.json`. Nothing here is
required for the basic player; everything is optional.

| Variable | What it does |
|---|---|
| `GEMINI_API_KEY` | Turns the DJ on. Free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). |
| `GEMINI_MODEL` | Defaults to `gemini-3.1-flash-lite`. |
| `YTDLP_PATH` | If yt-dlp is not on your PATH (e.g. a `yt-dlp.exe` dropped in the project folder). |
| `YTDLP_JS_RUNTIME` | Defaults to the Node running the server. Set `off` to disable, or e.g. `deno`. |
| `YTDLP_COOKIES_FROM_BROWSER` | e.g. `firefox`. Fixes tracks that need a signed-in session. |
| `YTDLP_COOKIES_FILE` | Same idea, from a cookies.txt file. |
| `YTDLP_REMOTE_COMPONENTS` | e.g. `ejs:github`, if yt-dlp reports its challenge solver is missing. |
| `YTDLP_EXTRA_ARGS` | Extra yt-dlp flags, space separated. |
| `CACHE_DIR`, `CACHE_MAX_TRACKS` | Where downloaded tracks live (default: temp dir, 80 tracks). |
| `PORT` | Defaults to 3000. |
>>>>>>> ad54f94 (Commiting 2.1.5 Setup Addons)

## Tests

```bash
npm test
```

## License

See [LICENSE](LICENSE).
