const { mkdirSync } = require('node:fs');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, screen, session } = require('electron');
const { io } = require('socket.io-client');
const { createSignalingServer } = require('../server/signaling');
const { resolveSignalingServerUrl } = require('./config');
const { MpvBridge } = require('./mpv-bridge');
const { createUserPreferences } = require('./user-preferences');
const { Win32VideoHost } = require('./win32-video-host');

const roomEvents = [
  'connect', 'disconnect', 'connect_error', 'peer-joined', 'peer-left', 'host-changed',
  'sync-event', 'sync-request', 'chat-message', 'reaction', 'webrtc-offer',
  'webrtc-answer', 'webrtc-ice', 'sync-settings',
];
const outgoingEvents = new Set([
  'sync-event', 'request-sync', 'chat-message', 'reaction',
  'webrtc-offer', 'webrtc-answer', 'webrtc-ice', 'sync-settings',
]);
const reactionEmojis = new Set(['❤️', '😂', '👏', '😮', '🔥', '😭', '🎉']);
const SIGNALING_CONNECT_TIMEOUT_MS = 75000;
const sessionDataPath = path.join(tmpdir(), `syncwatch-session-${process.pid}`);
mkdirSync(sessionDataPath, { recursive: true });
app.setPath('sessionData', sessionDataPath);
let signalingSocket;
let localSignalingServer;
let signalingServerUrl;
let mpvBridge;
let activeEngine = 'browser';
let userPreferences;
const videoHosts = new Map();
const videoFilesByWindow = new Map();

function getUserPreferences() {
  if (!userPreferences) {
    userPreferences = createUserPreferences(app.getPath('userData'), app.getPath('downloads'));
  }
  return userPreferences;
}

function getVideoHost(window) {
  if (process.platform !== 'win32') return null;
  let host = videoHosts.get(window.id);
  if (host) return host;

  const nativeHandle = window.getNativeWindowHandle();
  const parentHandle = nativeHandle.length >= 8
    ? nativeHandle.readBigUInt64LE(0)
    : BigInt(nativeHandle.readUInt32LE(0));
  host = new Win32VideoHost(parentHandle);
  videoHosts.set(window.id, host);
  return host;
}

function getMpvBridge(windowId = null) {
  if (mpvBridge) return mpvBridge;

  mpvBridge = new MpvBridge({ windowId, showWindow: !windowId });
  mpvBridge.on('property-change', (property) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('mpv:event', property);
    }
  });
  mpvBridge.on('file-loaded', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('mpv:event', { name: 'file-loaded', value: true });
    }
  });
  mpvBridge.on('end-file', (reason) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('mpv:event', { name: 'end-file', value: reason });
    }
  });
  mpvBridge.on('exit', (details) => {
    activeEngine = 'browser';
    for (const host of videoHosts.values()) {
      try {
        host.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
      } catch {
        // The window may have been destroyed during shutdown.
      }
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('mpv:event', { name: 'engine-exit', value: details });
    }
  });
  return mpvBridge;
}

async function startLocalSignalingServer() {
  const configuredUrl = await resolveSignalingServerUrl({
    onRemoteConfigError: (error) => {
      console.warn('[syncwatch] Remote server config unavailable; using fallback:', error.message);
    },
  });
  if (configuredUrl) {
    signalingServerUrl = configuredUrl;
    console.info('[syncwatch] Using signaling server:', signalingServerUrl);
    return;
  }

  const port = Number(process.env.SYNCWATCH_SERVER_PORT ?? 3000);
  const url = `http://127.0.0.1:${port}`;
  const server = createSignalingServer({ host: '127.0.0.1', port });
  try {
    await server.listen();
    localSignalingServer = server;
    signalingServerUrl = url;
    console.info('[syncwatch] Using local signaling server:', signalingServerUrl);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;

    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      const health = await response.json();
      if (response.ok && health.status === 'ok') {
        signalingServerUrl = url;
        return;
      }
    } catch {
      // Report the occupied port below when it is not a SyncWatch server.
    }

    throw new Error(`Port ${port} is already in use by a service that is not SyncWatch.`);
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#11130f',
    title: 'SyncWatch',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  window.on('closed', () => {
    const host = videoHosts.get(window.id);
    videoHosts.delete(window.id);
    videoFilesByWindow.delete(window.id);
    if (mpvBridge) {
      const player = mpvBridge;
      mpvBridge = null;
      activeEngine = 'browser';
      player.stop().catch(() => {}).finally(() => host?.destroy());
    } else {
      host?.destroy();
    }
  });
}

ipcMain.handle('video:open', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const preferences = getUserPreferences();
  const result = await dialog.showOpenDialog(window, {
    title: 'Open a video',
    defaultPath: await preferences.getDialogDefaultPath(),
    properties: ['openFile'],
    filters: [
      {
        name: 'Video files',
        extensions: ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'avi', 'mkv'],
      },
      { name: 'All files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  await preferences.rememberOpenedFile(filePath);
  const resumePosition = await preferences.getVideoPosition(filePath) ?? 0;
  videoFilesByWindow.set(window.id, filePath);
  const videoHost = getVideoHost(window);
  const player = getMpvBridge(videoHost?.mpvWindowId ?? null);
  try {
    await player.start();
    activeEngine = 'mpv';
    await player.loadFile(filePath, resumePosition);
    await player.setProperty('force-media-title', path.basename(filePath)).catch(() => undefined);
    return { engine: 'mpv', name: path.basename(filePath), resumePosition };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    activeEngine = 'browser';
    if (mpvBridge === player) mpvBridge = null;
    await player.stop().catch(() => {});
    videoHost?.destroy();
    videoHosts.delete(window.id);
  }

  return {
    engine: 'browser',
    mpvUnavailable: true,
    name: path.basename(filePath),
    url: pathToFileURL(filePath).href,
    resumePosition,
  };
});

ipcMain.handle('video:save-position', async (event, seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  const window = BrowserWindow.fromWebContents(event.sender);
  const filePath = window && videoFilesByWindow.get(window.id);
  if (!filePath) return false;
  await getUserPreferences().saveVideoPosition(filePath, seconds);
  return true;
});

app.whenReady().then(async () => {
  configureMediaPermissions();
  await startLocalSignalingServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  console.error('SyncWatch could not start:', error);
  dialog.showErrorBox('SyncWatch could not start', error.message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('app:get-config', async () => {
  const preferences = await getUserPreferences().load();
  return {
    signalingServerUrl,
    mpvPath: process.env.MPV_PATH ?? null,
    username: preferences.username,
    iceServers: [
      { urls: 'stun:stun.cloudflare.com:3478' },
      ...(process.env.SYNCWATCH_TURN_URL ? [{
        urls: process.env.SYNCWATCH_TURN_URL,
        username: process.env.SYNCWATCH_TURN_USERNAME ?? '',
        credential: process.env.SYNCWATCH_TURN_CREDENTIAL ?? '',
      }] : []),
    ],
  };
});

ipcMain.handle('app:save-username', (_event, username) => getUserPreferences().saveUsername(username));

ipcMain.handle('mpv:get-state', async () => {
  if (activeEngine !== 'mpv' || !mpvBridge?.socket?.writable) return null;
  const properties = ['time-pos', 'duration', 'pause', 'speed', 'volume', 'mute', 'track-list'];
  const values = await Promise.all(properties.map(async (property) => {
    try {
      return await mpvBridge.getProperty(property);
    } catch {
      return null;
    }
  }));
  return Object.fromEntries(properties.map((property, index) => [property, values[index]]));
});

ipcMain.handle('mpv:command', async (_event, action, value) => {
  if (activeEngine !== 'mpv' || !mpvBridge?.socket?.writable) {
    throw new Error('mpv is not playing a file.');
  }

  if (action === 'refresh-tracks') return mpvBridge.getProperty('track-list');
  if (action === 'reaction' && value && reactionEmojis.has(value.emoji) &&
    value.width === 128 && value.height === 128 && value.pixels instanceof Uint8Array &&
    value.pixels.byteLength === 128 * 128 * 4
  ) {
    return mpvBridge.showReactionBitmap(value);
  }
  if (action === 'play') return mpvBridge.setProperty('pause', false);
  if (action === 'pause') return mpvBridge.setProperty('pause', true);
  if (action === 'seek' && Number.isFinite(value) && value >= 0) return mpvBridge.seek(value);
  if (action === 'speed' && Number.isFinite(value) && value >= 0.25 && value <= 3) {
    return mpvBridge.setProperty('speed', value);
  }
  if (action === 'volume' && Number.isFinite(value) && value >= 0 && value <= 100) {
    return mpvBridge.setProperty('volume', value);
  }
  if (action === 'mute' && typeof value === 'boolean') return mpvBridge.setProperty('mute', value);
  if (action === 'audio-track' && (value === 'auto' || Number.isInteger(value))) {
    return mpvBridge.setProperty('aid', value === 'auto' ? 'auto' : value);
  }
  if (action === 'subtitle-track' && (value === 'off' || Number.isInteger(value))) {
    return mpvBridge.setProperty('sid', value === 'off' ? 'no' : value);
  }
  if (action === 'aspect' && (value === 'auto' || value === 'fill' || Number.isFinite(value))) {
    await mpvBridge.setProperty('keepaspect', value !== 'fill');
    return mpvBridge.setProperty('video-aspect-override', value === 'auto' || value === 'fill' ? -1 : value);
  }

  throw new Error('Unsupported or invalid mpv command.');
});

ipcMain.handle('room:connect', async (_event, serverUrl) => {
  if (typeof serverUrl !== 'string' || !/^https?:\/\//.test(serverUrl)) {
    throw new Error('The signaling server URL must start with http:// or https://.');
  }
  if (signalingSocket?.connected && signalingSocket.io.uri === serverUrl) {
    return { id: signalingSocket.id };
  }

  signalingSocket?.disconnect();
  signalingSocket = io(serverUrl, {
    autoConnect: false,
    timeout: 20000,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
  const socket = signalingSocket;
  for (const eventName of roomEvents) {
    socket.on(eventName, (...args) => {
      if (eventName === 'connect_error') {
        console.warn('[syncwatch] signaling connection attempt failed:', args[0]?.message ?? args[0]);
      } else if (eventName === 'disconnect') {
        console.warn('[syncwatch] signaling connection lost:', args[0]);
      }
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          const eventArgs = eventName === 'connect' ? [{ id: socket.id }] : args;
          window.webContents.send('room:event', { event: eventName, args: eventArgs });
        }
      }
    });
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    let lastError;
    const timeout = setTimeout(() => {
      finish(lastError ?? new Error('Timed out waiting for the signaling server.'));
    }, SIGNALING_CONNECT_TIMEOUT_MS);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_failed', onReconnectFailed);
      if (error) reject(error);
      else resolve();
    };
    const onConnect = () => finish();
    const onConnectError = (error) => { lastError = error; };
    const onReconnectFailed = () => finish(lastError ?? new Error('Connection retries were exhausted.'));

    socket.once('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.io.on('reconnect_failed', onReconnectFailed);
    socket.connect();
  }).catch((error) => {
    signalingSocket?.disconnect();
    signalingSocket = undefined;
    throw new Error(`Could not connect to signaling server: ${error.message}. The hosted server may be waking up; wait briefly and try again.`);
  });

  return { id: signalingSocket.id };
});

ipcMain.handle('room:join', async (_event, payload) => {
  if (!signalingSocket?.connected) {
    throw new Error('Connect to the signaling server first.');
  }
  return signalingSocket.timeout(5000).emitWithAck('join-room', payload);
});

ipcMain.handle('room:leave', async () => {
  if (!signalingSocket?.connected) {
    return { ok: true };
  }
  return signalingSocket.timeout(3000).emitWithAck('leave-room', null);
});

ipcMain.handle('room:emit', (_event, eventName, payload) => {
  if (!outgoingEvents.has(eventName)) {
    throw new Error('Unsupported signaling event.');
  }
  if (!signalingSocket?.connected) {
    throw new Error('The signaling server is disconnected.');
  }
  signalingSocket.emit(eventName, payload);
});

ipcMain.handle('room:disconnect', () => {
  signalingSocket?.disconnect();
  signalingSocket = undefined;
});

function configureMediaPermissions() {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => (
    permission === 'media' && requestingOrigin.startsWith('file://')
  ));

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const isLocalApp = webContents.getURL().startsWith('file://');
    const mediaTypes = details?.mediaTypes ?? [];
    const supportedMedia = mediaTypes.every((type) => type === 'audio' || type === 'video');
    callback(permission === 'media' && isLocalApp && supportedMedia);
  });
}

app.on('before-quit', (event) => {
  signalingSocket?.disconnect();
  if (!localSignalingServer && !mpvBridge && videoHosts.size === 0) return;

  event.preventDefault();
  const server = localSignalingServer;
  localSignalingServer = undefined;
  const cleanup = [mpvBridge?.stop()];
  if (server) cleanup.push(server.close());
  Promise.allSettled(cleanup).finally(() => {
    for (const host of videoHosts.values()) host.destroy();
    videoHosts.clear();
    app.quit();
  });
});

ipcMain.handle('subtitle:open', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const preferences = getUserPreferences();
  const result = await dialog.showOpenDialog(window, {
    title: 'Open subtitles',
    defaultPath: await preferences.getDialogDefaultPath(),
    properties: ['openFile'],
    filters: [{ name: 'Subtitle files', extensions: ['srt', 'vtt'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  await preferences.rememberOpenedFile(filePath);
  const fileInfo = await stat(filePath);
  if (fileInfo.size > 5 * 1024 * 1024) {
    throw new Error('Subtitle files must be smaller than 5 MB.');
  }
  const name = path.basename(filePath);
  if (activeEngine === 'mpv') {
    await getMpvBridge().addSubtitle(filePath);
    return { engine: 'mpv', name };
  }
  return { engine: 'browser', name, content: await readFile(filePath, 'utf8') };
});

ipcMain.handle('mpv:set-viewport', (event, bounds) => {
  if (process.platform !== 'win32' || activeEngine !== 'mpv') return false;
  const window = BrowserWindow.fromWebContents(event.sender);
  const host = window && videoHosts.get(window.id);
  if (!host || !bounds || typeof bounds !== 'object') return false;

  const { x, y, width, height, scaleFactor } = bounds;
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0 || width > 10000 || height > 10000) {
    throw new Error('Invalid mpv viewport bounds.');
  }
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const contentBounds = window.getContentBounds();
  const contentOrigin = screen.dipToScreenPoint({ x: contentBounds.x, y: contentBounds.y });
  const parentOrigin = host.getParentClientOrigin();
  host.setBounds({
    x,
    y,
    width,
    height,
    scaleFactor: scale,
    parentOffsetX: contentOrigin.x - parentOrigin.x,
    parentOffsetY: contentOrigin.y - parentOrigin.y,
    visible: width > 0 && height > 0,
  });
  return true;
});