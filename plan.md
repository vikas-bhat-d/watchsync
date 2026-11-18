# SyncWatch — Build Plan

> Electron + mpv + Node.js signaling + WebRTC  
> Local-first. No uploads. No accounts. Full format support.

---

## 1. What We're Building

A desktop app where two (or more) people:
- Each load their own local copy of the same video file (any format: MKV, AVI, HEVC, MP4, etc.)
- Stay in sync: play, pause, seek, and playback speed are broadcast to everyone
- Pick their own audio track and subtitles independently (not synced)
- See each other's webcam via WebRTC
- Chat in a sidebar
- Toggle between Theater mode (fullscreen-ish, controls hidden) and Panel mode (sidebar open)

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Electron App (each user)           │
│                                                     │
│  ┌──────────────┐    IPC     ┌───────────────────┐  │
│  │  Renderer    │◄──────────►│   Main Process    │  │
│  │  (HTML/JS)   │            │   (Node.js)       │  │
│  │              │            │                   │  │
│  │  - UI        │            │  - mpv via IPC    │  │
│  │  - Chat      │            │  - File picker    │  │
│  │  - WebRTC    │            │  - Socket.IO      │  │
│  │  - Controls  │            │    client         │  │
│  └──────────────┘            └───────────────────┘  │
└─────────────────────────────────────────────────────┘
                        │
                        │  WebSocket (Socket.IO)
                        ▼
┌─────────────────────────────────────────────────────┐
│          Signaling Server (Node.js + Express)       │
│          Hosted free on Railway / Render            │
│                                                     │
│  - Room management                                  │
│  - Sync event relay (play/pause/seek/speed)         │
│  - Chat relay                                       │
│  - WebRTC offer/answer/ICE relay                    │
└─────────────────────────────────────────────────────┘
```

WebRTC for webcam is peer-to-peer directly between users.  
Signaling server only relays the handshake (offer/answer/ICE candidates), not the media stream.

---

## 3. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| App shell | Electron | Native file access, bundles Node.js, cross-platform |
| Video player | mpv (via IPC socket) | Supports every format, subtitle rendering, audio tracks, aspect ratio — all out of the box |
| mpv bridge | `node-mpv` npm package | Wraps mpv IPC socket cleanly in Node.js |
| Sync + chat | Socket.IO | Simple, reliable, works through NAT |
| Signaling server | Node.js + Express + Socket.IO | Minimal, deployable on free tier |
| Webcam | WebRTC (native browser API in Electron renderer) | P2P, no relay needed for media |
| NAT traversal | Google/Cloudflare STUN (free) | Required for WebRTC across different networks |
| TURN fallback | Metered.ca free TURN | For users behind strict NAT/firewall |
| Frontend | HTML + CSS + Vanilla JS | No framework overhead needed |

---

## 4. Folder Structure

```
syncwatch/
├── electron/
│   ├── main.js              # Electron main process
│   ├── preload.js           # Context bridge (IPC exposure)
│   └── mpv-bridge.js        # mpv IPC wrapper logic
│
├── renderer/
│   ├── index.html           # Main UI shell
│   ├── app.js               # UI logic, mode toggle, controls
│   ├── sync.js              # Socket.IO sync logic
│   ├── webrtc.js            # WebRTC webcam logic
│   ├── chat.js              # Chat UI logic
│   └── style.css            # All styles
│
├── server/
│   ├── index.js             # Express + Socket.IO signaling server
│   └── rooms.js             # Room state management
│
├── package.json
└── plan.md
```

---

## 5. mpv Integration

mpv runs as a child process. Electron spawns it, communicates via a Unix socket (macOS/Linux) or named pipe (Windows).

### Spawning mpv

```js
// electron/mpv-bridge.js
const { execFile } = require('child_process');
const NodeMpv = require('node-mpv');

const mpv = new NodeMpv({
  socket: '/tmp/syncwatch-mpv.sock',  // Windows: '\\\\.\\pipe\\syncwatch-mpv'
  verbose: false,
  time_update: 1,     // emit timeposition every 1s
}, [
  '--no-terminal',
  '--keep-open=yes',  // don't close on file end
  '--osc=no',         // disable default on-screen controls (we draw our own)
  '--input-ipc-server=/tmp/syncwatch-mpv.sock',
]);
```

### Commands we use from node-mpv

```js
mpv.load(filePath)                    // open file
mpv.play()                            // play
mpv.pause()                           // pause
mpv.goToPosition(seconds)             // seek to timestamp
mpv.getProperty('time-pos')          // get current position
mpv.getProperty('duration')          // total duration
mpv.getProperty('track-list')        // get all audio/subtitle tracks
mpv.setProperty('aid', trackId)      // set audio track (local only, NOT synced)
mpv.setProperty('sid', trackId)      // set subtitle track (local only, NOT synced)
mpv.setProperty('sub-pos', value)    // subtitle vertical position (0-100)
mpv.setProperty('sub-scale', value)  // subtitle size
mpv.setProperty('video-aspect', val) // aspect ratio override e.g. '16:9', '4:3', '-1' (auto)
mpv.setProperty('panscan', value)    // crop to fill (0.0 to 1.0)
mpv.setProperty('video-zoom', value) // zoom level
mpv.setProperty('speed', value)      // playback rate; synchronized room-wide
```

### Events from mpv we listen to

```js
mpv.on('timeposition', (seconds) => {
  // update our progress bar UI
  // also drift-check against remote
});

mpv.on('paused', () => { /* user hit pause locally */ });
mpv.on('resumed', () => { /* user hit play locally */ });
mpv.on('seek', (data) => { /* user seeked */ });
```

---

## 6. Signaling Server

Simple, stateless relay. Rooms identified by a short random code (e.g. `movie-night-42`).

### Events it handles

| Event (client → server) | What it does |
|---|---|
| `join-room` | Adds socket to room, notifies others |
| `leave-room` | Removes socket, notifies others |
| `sync-event` | Relays play/pause/seek/speed to everyone else in room |
| `chat-message` | Relays chat message to room |
| `webrtc-offer` | Relays WebRTC offer to target peer |
| `webrtc-answer` | Relays WebRTC answer to target peer |
| `webrtc-ice` | Relays ICE candidate to target peer |
| `request-sync` | Ask host for a force-sync ping |

### Server sketch

```js
// server/index.js
const io = require('socket.io')(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, username }) => {
    socket.join(roomId);
    socket.to(roomId).emit('peer-joined', { username, socketId: socket.id });
  });

  socket.on('sync-event', ({ roomId, type, payload }) => {
    // type: 'play' | 'pause' | 'seek' | 'speed' | 'heartbeat' | 'force-sync'
    socket.to(roomId).emit('sync-event', {
      type, payload, from: socket.id, serverTime: Date.now()
    });
  });

  socket.on('chat-message', ({ roomId, username, text }) => {
    io.to(roomId).emit('chat-message', { username, text, ts: Date.now() });
  });

  // WebRTC relay
  socket.on('webrtc-offer', ({ to, offer }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, offer });
  });
  socket.on('webrtc-answer', ({ to, answer }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, answer });
  });
  socket.on('webrtc-ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc-ice', { from: socket.id, candidate });
  });
});
```

---

## 7. Sync Logic

This is the core. The rule is: **sync play, pause, seek, and playback speed.**
Track selection, subtitles, volume, and display preferences remain local.

### Who controls playback?

Every room member may play, pause, seek, or change speed. The last action is relayed to
everyone and wins; the host remains responsible for periodic heartbeats, force-sync, and
the room-wide drift-tolerance setting.

### On a local play/pause/seek/speed change

```js
// renderer/sync.js

function onLocalEvent(type, payload) {
  if (!inRoom) return;
  socket.emit('sync-event', { roomId, type, payload });
}
```

There is no consensus or host lock on transport controls. The signaling server relays
commands from every room member; only heartbeats and force-sync are host-only.

### On receiving a sync event

```js
socket.on('sync-event', ({ type, payload }) => {
  if (type === 'play')  mpv.play();
  if (type === 'pause') mpv.pause();
  if (type === 'seek')  mpv.goToPosition(payload.seconds);
  if (type === 'speed') mpv.setProperty('speed', payload.speed);
  if (type === 'force-sync') {
    mpv.goToPosition(payload.seconds);
    mpv.setProperty('speed', payload.speed);
    if (payload.playing) mpv.play(); else mpv.pause();
  }
});
```

### Drift detection

Every 5 seconds, non-host clients compare their position against the host position projected
forward from the last heartbeat using its playback state and speed. This avoids treating
intentional faster or slower playback as drift:

```js
setInterval(async () => {
  const myPos = await mpv.getProperty('time-pos');
  const elapsed = (Date.now() - lastHostState.receivedAt) / 1000;
  const expectedPos = lastHostState.seconds +
    (lastHostState.playing ? elapsed * lastHostState.speed : 0);
  const drift = Math.abs(myPos - expectedPos);
  updateDriftUI(drift);          // show "drift: 0.3s" in sync bar
  if (drift > 3) autoResync();   // auto-snap if drift > 3s
}, 5000);
```

Host broadcasts their position every 5 seconds as a heartbeat:

```js
// host only
setInterval(async () => {
  const pos = await mpv.getProperty('time-pos');
  const paused = await mpv.getProperty('pause');
  socket.emit('sync-event', {
    roomId,
    type: 'heartbeat',
    payload: {
      seconds: pos,
      playing: !paused,
      speed: await mpv.getProperty('speed')
    }
  });
}, 5000);
```

Guests store the heartbeat's position, playing state, speed, and local receipt time as
`lastHostState`. They update that state on each heartbeat or playback event.

### Force Sync button

```js
// renderer/app.js
async function forceSync() {
  if (!iAmHost) return;
  const pos = await mpv.getProperty('time-pos');
  const paused = await mpv.getProperty('pause');
  socket.emit('sync-event', {
    roomId,
    type: 'force-sync',
    payload: {
      seconds: pos,
      playing: !paused,
      speed: await mpv.getProperty('speed')
    }
  });
  showToast('Force sync sent');
}
```

Force sync button visible to host only. Guest sees "Request sync" which pings host to trigger a force sync.

---

## 8. Video Player Controls (Renderer UI)

### Progress bar

- Custom HTML `<div>` bar, not `<input type="range">`
- Click anywhere on bar to seek
- Draggable scrubber handle
- Shows buffered range as lighter fill
- Time display: `HH:MM:SS / HH:MM:SS`
- mpv emits `timeposition` every 1s — update bar from that

### Playback controls

- Play / Pause — sends sync event if host
- Skip ±10s — sends seek sync event if host
- Playback speed — host-controlled selector; changing it broadcasts the new rate, and
  guests apply it locally. Include the current speed in heartbeat and force-sync state.
- Volume — local only, no sync, calls `mpv.setProperty('volume', val)`

### Audio track selector

- On file load, call `mpv.getProperty('track-list')` and filter `type === 'audio'`
- Render as dropdown: `Track 1 — English AC3`, `Track 2 — Hindi`, etc.
- On change: `mpv.setProperty('aid', id)` — local only, not synced

### Subtitle track selector

- Same as audio: filter `type === 'sub'` from track-list
- Options: Off, Track 1 — English SRT, Track 2 — Arabic PGS, etc.
- On change: `mpv.setProperty('sid', id)` — local only

### Subtitle position control

- Slider (vertical position): maps to `sub-pos` property (0 = top, 100 = bottom, default 100)
- Slider (size/scale): maps to `sub-scale` (0.5 = small, 1.0 = default, 2.0 = large)
- Both are local only

### Aspect ratio selector

| Label | mpv value |
|---|---|
| Auto (default) | `video-aspect=-1` |
| 16:9 | `video-aspect=1.7778` |
| 4:3 | `video-aspect=1.3333` |
| 2.35:1 (Cinema) | `video-aspect=2.35` |
| Stretch to fill | `panscan=1.0` |
| Zoom in | `video-zoom=0.1` (increment) |

Rendered as a small dropdown or button group next to the subtitle controls.

### Controls visibility logic

```
Theater mode:
  - mousemove on video → show controls overlay (opacity 1, transition 0.2s)
  - no movement for 3s → hide controls (opacity 0)
  - hover on controls bar → reset 3s timer

Panel mode:
  - controls always visible below video
  - no hide behavior
```

---

## 9. WebRTC Webcam

Each peer connects directly to every other peer. For 2 users: 1 connection. For 3: 3 connections. Keep rooms small (max 4 recommended).

### Flow

```
User A joins room
  → server notifies User B
  → B sends WebRTC offer to A via signaling server
  → A responds with answer
  → Both exchange ICE candidates
  → Direct P2P media stream established
```

### Code sketch

```js
// renderer/webrtc.js
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // TURN fallback for strict NAT:
    { urls: 'turn:relay.metered.ca:80', username: '...', credential: '...' }
  ]
});

// Add local webcam stream
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
stream.getTracks().forEach(track => pc.addTrack(track, stream));

// Show local video
document.getElementById('webcam-local').srcObject = stream;

// On remote stream
pc.ontrack = (event) => {
  document.getElementById('webcam-remote').srcObject = event.streams[0];
};

// ICE candidates
pc.onicecandidate = ({ candidate }) => {
  if (candidate) socket.emit('webrtc-ice', { to: peerId, candidate });
};

// Offer (initiator side)
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
socket.emit('webrtc-offer', { to: peerId, offer });
```

---

## 10. UI Mode Toggle

```js
// renderer/app.js
let mode = 'theater'; // or 'panel'

function setMode(newMode) {
  mode = newMode;
  document.body.setAttribute('data-mode', newMode);
}

// CSS handles everything via data-mode attribute:
// [data-mode="theater"] .sidebar { width: 34px; }
// [data-mode="panel"]   .sidebar { width: 220px; }
// [data-mode="theater"] .controls { opacity: 0; transition: opacity 0.2s; }
// [data-mode="theater"]:hover .controls { opacity: 1; }
```

Sidebar strip (theater mode) shows:
- Green dot = your webcam live
- Purple dot = remote webcam live
- Chat icon + unread count badge (clears when panel opened)

---

## 11. Electron IPC Bridge

Renderer cannot access Node.js directly (security). Use `contextBridge` in preload.js.

```js
// electron/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncwatch', {
  openFile: () => ipcRenderer.invoke('open-file'),
  mpv: {
    play:        () => ipcRenderer.invoke('mpv-play'),
    pause:       () => ipcRenderer.invoke('mpv-pause'),
    seek:        (s) => ipcRenderer.invoke('mpv-seek', s),
    getPos:      () => ipcRenderer.invoke('mpv-get-pos'),
    setAudio:    (id) => ipcRenderer.invoke('mpv-set-audio', id),
    setSub:      (id) => ipcRenderer.invoke('mpv-set-sub', id),
    setSubPos:   (v) => ipcRenderer.invoke('mpv-sub-pos', v),
    setSubScale: (v) => ipcRenderer.invoke('mpv-sub-scale', v),
    setAspect:   (v) => ipcRenderer.invoke('mpv-set-aspect', v),
    getTrackList:() => ipcRenderer.invoke('mpv-get-tracks'),
  },
  on: (event, cb) => ipcRenderer.on(event, (_, data) => cb(data)),
});
```

---

## 12. Build Phases

### Phase 1 — Local player (no networking)
- [x] Electron app boots with a secure renderer
- [x] Open local files through mpv JSON IPC when available, with browser fallback
- [x] Audio track, subtitle track/file, volume, and aspect ratio controls stay local
- [ ] Validate playback against representative formats and tracks on each supported OS
- [x] Theater/Panel mode toggle works without document overflow

### Phase 2 — Signaling server
- [x] Node.js server with room join/leave and four-person room limit
- [ ] Deploy the signaling service for internet rooms
- [x] Room code generation and sharing

### Phase 3 — Sync
- [x] Socket.IO client connected through the Electron preload boundary
- [x] Any room member can play, pause, seek, or change playback speed
- [x] Heartbeat + drift correction
- [x] Host heartbeat and force-sync restore position, playing/paused state, and playback speed

### Phase 4 — Chat
- [x] Chat UI in sidebar
- [x] Messages relayed via signaling server

### Phase 5 — WebRTC webcam
- [x] getUserMedia, offer/answer and ICE exchange
- [x] Webcam tiles in sidebar
- [x] Mic/cam toggles
- [ ] Cross-device camera and NAT/TURN validation

### Phase 6 — Polish
- [ ] Auto-hide controls in theater mode
- [x] Unread badge on sidebar strip
- [ ] Subtitle position/scale sliders
- [ ] Aspect ratio presets
- [x] Toast notifications for room and sync events

### Implementation sequence
1. **[x] Electron shell and local player UI** — secure preload boundary, file picker, responsive theater/panel layouts, and browser fallback.
2. **[x] Watch-party features** — room signaling, shared transport and speed, host drift settings, chat, WebRTC devices, reactions, and webcam picture-in-picture.
3. **[x] mpv playback adapter** — launch mpv, connect over JSON IPC, and control playback/track properties; the native mpv video window is separate from the SyncWatch control window.
4. **[x] Local media controls** — audio/subtitle tracks, external subtitles, aspect ratio, and local volume.
5. **Validation and release** — test representative formats and cross-device WebRTC, deploy signaling, and package macOS/Linux builds.

Steps 1–4 are implemented. The mpv IPC bridge is tested; representative file playback and cross-device WebRTC still need validation. Windows installer output is `dist/SyncWatch-Setup-0.1.0.exe`; public signaling deployment and macOS/Linux packaging remain pending.

---

## 13. mpv Installation Note

mpv is optional but recommended for broad format and track support. SyncWatch looks for
`MPV_PATH`, an app-bundled `resources/mpv` binary, the Windows WinGet link, or `mpv` on
`PATH`; if none is found, it falls back to Chromium's supported formats. The current
Windows installer does not bundle mpv. On Windows, a portable build can be installed with
`winget install --id mpv-player.mpv-CI.MSVC --exact`.

---

## 14. What is NOT synced (by design)

| Feature | Reason |
|---|---|
| Audio track choice | Each person may want different language |
| Subtitle track choice | Personal preference |
| Subtitle position/size | Accessibility preference |
| Volume | Local comfort |
| Aspect ratio | Display difference |
| Zoom/pan | Local screen difference |

Synced playback state: **play, pause, seek timestamp, playback speed.**
The drift-tolerance threshold is a shared room setting controlled by the host. Audio track,
subtitle track/file, subtitle presentation, aspect ratio, and volume stay local to each viewer.

---

## 15. Deployment and Packaging

Signaling server is the only hosted component.

```
Railway free tier:
  - 500 hours/month
  - $0 for small usage
  - Deploy: railway up

Or Render free tier:
  - Spins down after 15min inactivity
  - Add a /health endpoint + UptimeRobot ping to keep alive
```

Windows x64 installer packaging is configured with electron-builder and NSIS. From Windows, build it with:

```powershell
npm run build:win
```

Output: `dist/SyncWatch-Setup-0.1.0.exe`. The installer is unsigned. macOS and Linux package targets are not configured yet. For internet rooms, deploy the signaling service behind HTTPS and configure TURN for restrictive networks.

---

## 16. Nice-to-Haves (Post-MVP)

- Subtitle file drag-and-drop (load external .srt/.ass)
- [x] Reaction emojis: send a small emoji-only room event; briefly animate it over the video,
  then remove it. Reactions are ephemeral (not chat history), rate-limited, and never
  affect playback state.
- Room password protection
- [x] Webcam picture-in-picture: detach a remote webcam video into the browser's native
  picture-in-picture window, with a fallback floating tile if native PiP is unavailable.
- Mobile companion app (just chat + webcam, no video, for people watching on TV)