# LANDMINE on Windows

You do not need to know any commands. This guide is for the one computer that
will host the music. Everyone else just opens a web link.

## Run it

1. On GitHub, click **Code → Download ZIP**, then unzip the folder somewhere
   easy to find, like your Desktop.
2. Open that folder and double-click **`START-LANDMINE.bat`**.
3. A black window appears. Read what it says and wait — the first run may take
   a few minutes while it installs the pieces it needs.
4. Your browser opens LANDMINE by itself. **Leave the black window open** while
   you use the app. Closing it stops the server and the music.

That's it. Search for a song, or paste a YouTube link, and press play.

## What the launcher does

- Checks for **Node.js 20 or newer**. If it is missing or too old, it tries to
  install the current LTS version with Windows' built-in `winget`.
- Checks for **yt-dlp** (the tool that fetches the audio). It tries to install
  that with `winget` too.
- If you prefer not to install yt-dlp, download `yt-dlp.exe` from
  [the release page](https://github.com/yt-dlp/yt-dlp/releases/latest) and put
  it in the same folder as `START-LANDMINE.bat`. The launcher will use it.
- Creates a `.env` settings file from `.env.example` the first time.
- Downloads the app's libraries with `npm install`, starts the server and opens
  your browser.

## Let other devices join

The black window prints a line like:

```
LANDMINE live at  http://192.168.1.23:3000
```

Give **that** address to friends on the same Wi-Fi. `localhost` only works on
the hosting computer. If Windows Firewall asks about Node.js, allow it — that
is what lets phones and laptops connect.

On each device, pick the speaker under **Playing on**. Sound plays from that
device only; the others are remotes. If a phone blocks audio, tap
**Enable sound**.

## Optional: turn on the DJ

The DJ needs a free Gemini API key.

1. Get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. In the LANDMINE folder, open `.env` with Notepad.
   (If you cannot see it, Windows may be hiding file extensions — search for
   `.env` in the folder's search box.)
3. Replace `GEMINI_API_KEY=` with `GEMINI_API_KEY=your_key` and save.
4. Close the black window and double-click `START-LANDMINE.bat` again.

The DJ tab now lets you pick a mood and add songs automatically. With no key,
the rest of the player works normally and the DJ stays off.

## If something goes wrong

| Symptom | What to do |
|---|---|
| Windows says "Windows protected your PC" | Click **More info → Run anyway**. The launcher is a plain text script you can read in Notepad. |
| It says it could not install Node.js | Your Windows may not have `winget`. Install Node.js LTS from [nodejs.org](https://nodejs.org/), then run the launcher again. |
| It says it could not install yt-dlp | Download `yt-dlp.exe` into the LANDMINE folder as described above and run the launcher again. |
| `npm install` fails | Check your internet connection and try again. Corporate networks or proxies can block it. |
| The browser shows "Can't reach this page" | Make sure the black window is still open, and use the printed LAN address (not `localhost`) on other devices. |
| Port 3000 is already in use | Open `.env`, add `PORT=3001`, save, and restart the launcher. Then open the address it prints. |
| Search or playback fails for some songs | Update yt-dlp, or put a `yt-dlp.exe` from the latest release in the folder. Some tracks need a signed-in YouTube session; see the cookie options in the README. |

## Stop it

Close the black window, or press **Ctrl+C** in it. Refreshing a phone's browser
does not stop the music.
