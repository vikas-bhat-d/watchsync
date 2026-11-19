# SyncWatch

SyncWatch is an Electron watch-party app. Each participant opens their own local copy of the same video. Everyone can play, pause, seek, and change shared playback speed; the host configures the room-wide drift tolerance. Participants can also chat, send floating reactions, and share webcam/microphone video peer-to-peer.

## Requirements

- Node.js 22.12 or newer (Node.js 24 was used during development)
- npm
- Windows x64 to build the configured installer

SyncWatch uses mpv for broad format and track support. The Windows installer bundles mpv, so users do not need to install it separately. When running from source, mpv is optional; if it is unavailable, the app falls back to Chromium's built-in decoder, whose supported formats depend on Electron's codecs. Native mpv embedding is currently Windows-only; on other platforms mpv may open in a separate window.

When running from source on Windows, install a portable mpv build with:

```powershell
winget install --id mpv-player.mpv-CI.MSVC --exact
```

Restart the terminal/app after installation. If mpv is not on `PATH`, set `MPV_PATH` to the full path of `mpv.exe` before launching SyncWatch.

## Run from Source

Open PowerShell in the project directory:

```powershell
npm ci
npm exec -- install-electron
npm start
```

`npm exec -- install-electron` downloads Electron's runtime and is needed once after installing dependencies. `npm start` opens the desktop app and starts a local signaling server on `127.0.0.1:3000`. If another SyncWatch instance already owns that port, the new app reuses it. Videos use embedded mpv on Windows when found; otherwise they use the browser fallback.

Run checks and signaling tests with:

```powershell
npm run check
npm test
```

## Build the Windows Installer

On Windows x64, ensure a Windows x64 mpv build is installed on the build machine or set `MPV_PATH` to its `mpv.exe`, then run:

```powershell
npm ci
npm exec -- install-electron
npm run build:win
```

Each build uses a fresh output directory so a running app from an earlier build cannot lock the next build's `app.asar`. The installer is written under a unique directory like:

```text
dist\win-build-<build-id>\SyncWatch-Setup-0.1.0.exe
```

The unpacked executable is in the same build directory under `win-unpacked`. The build stages `mpv.exe` and its neighboring DLLs into the installer; users do not need a separate mpv installation. The installer is currently unsigned, so Windows may show its standard unknown-publisher warning. `npm start` runs from source; `npm run build:win` creates the installable `.exe`.

## Configure the Signaling Server

With no URL configured, the app starts or reuses its local server at `http://127.0.0.1:3000`. To select another server, pass `--server-url`. This overrides `SYNCWATCH_SERVER_URL` and disables the embedded local server.

For a source run:

```powershell
npm start -- --server-url https://sync.example.com
```

Both `--server-url https://sync.example.com` and `--server-url=https://sync.example.com` are accepted. For an installed executable, add this to the shortcut's **Target** and **Arguments** fields:

| Shortcut field | Value |
|---|---|
| Target | Path to the installed `SyncWatch.exe` |
| Arguments | `--server-url https://sync.example.com` |

Or launch it from PowerShell:

```powershell
& 'C:\path\to\installed\SyncWatch.exe' --server-url https://sync.example.com
```

Replace the example URL and executable path with your server and install location. Use HTTPS for an internet-hosted server. The environment variable remains available as a fallback for scripts that do not use command-line arguments.

To run a standalone signaling server for LAN testing, start it on the host computer:

```powershell
$env:SYNCWATCH_BIND_HOST = '0.0.0.0'
$env:SYNCWATCH_SERVER_PORT = '3000'
npm run server
```

Then point each client, including the host computer's app, at that computer's LAN IP:

```powershell
npm start -- --server-url http://192.168.1.20:3000
```

Run `npm run server` once on the signaling host; each participant launches the app with `--server-url` set to that host's LAN URL. Allow the chosen port through the host firewall. `SYNCWATCH_BIND_HOST` applies to the standalone server and defaults to `127.0.0.1`; `PORT` takes precedence over `SYNCWATCH_SERVER_PORT` for the standalone server. The embedded app server uses `SYNCWATCH_SERVER_PORT` and defaults to `3000`.

WebRTC uses a public STUN server by default. For networks that require TURN, set these variables in the environment used to launch each client:

```powershell
$env:SYNCWATCH_TURN_URL = 'turn:turn.example.com:3478'
$env:SYNCWATCH_TURN_USERNAME = 'your-turn-username'
$env:SYNCWATCH_TURN_CREDENTIAL = 'your-turn-credential'
npm start
```

Keep TURN credentials private. Room codes are the only access check currently; use a trusted signaling service and share codes only with invited participants.

## Use the App

1. Enter a display name and select **Create room**. Copy the room code and send it to the other participants.
2. Other participants enter that code and select **Join**. Rooms allow up to four people.
3. Everyone selects **Open file** and opens their own local copy of the same video. On Windows, mpv renders inside the SyncWatch window and SyncWatch controls playback. Video files are not uploaded or sent through the signaling server.
4. Anyone in the room can play, pause, seek, or change playback speed. The last action applies to everyone. Space toggles play/pause, Left and Right seek 10 seconds, and M toggles local mute; shortcuts pause while typing. Guests can select **Request sync**; the host can force-sync and set the room drift tolerance.
5. Use the chat composer or reaction buttons to send messages and emoji reactions. Reactions use the floating browser animation or a full-color rising mpv overlay, depending on the active player.
6. Audio track, subtitles, aspect ratio, and volume are local to each participant and are not shared. Camera and microphone start off. Select **Camera on** or **Mic on** to request device access. Use the PiP button on a webcam tile for native picture-in-picture where available; otherwise it toggles a floating in-app tile.
7. Select **Leave room** to disconnect. Theater mode narrows the sidebar to quick actions; Panel mode shows room, video, and chat controls.

## Configuration Reference

| Variable | Purpose | Default |
|---|---|---|
| `--server-url URL` | Signaling URL used by the desktop app; takes precedence over the environment variable and skips its embedded server | Embedded local server |
| `SYNCWATCH_SERVER_URL` | Fallback signaling URL for scripts or launchers that do not pass `--server-url` | Unset |
| `SYNCWATCH_SERVER_PORT` | Port for the embedded server, or fallback port for standalone server | `3000` |
| `SYNCWATCH_BIND_HOST` | Bind address for `npm run server` | `127.0.0.1` |
| `PORT` | Standalone server port; overrides `SYNCWATCH_SERVER_PORT` | Unset |
| `SYNCWATCH_TURN_URL` | Optional TURN URL | Unset |
| `SYNCWATCH_TURN_USERNAME` | Optional TURN username | Unset |
| `SYNCWATCH_TURN_CREDENTIAL` | Optional TURN credential | Unset |
| `MPV_PATH` | Optional full path to `mpv.exe`/`mpv`; also used as the build-time source for the bundled Windows mpv | Search `PATH` |

The Electron main process and secure IPC bridge are in `electron/`; the UI is in `renderer/`; the Socket.IO service is in `server/`.
