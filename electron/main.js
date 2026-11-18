const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { io } = require('socket.io-client');
const { createSignalingServer } = require('../server/signaling');
const { getSignalingServerUrl } = require('./config');

const roomEvents = [
  'connect', 'disconnect', 'connect_error', 'peer-joined', 'peer-left', 'host-changed',
  'sync-event', 'sync-request', 'chat-message', 'reaction', 'webrtc-offer',
  'webrtc-answer', 'webrtc-ice',
];
const outgoingEvents = new Set([
  'sync-event', 'request-sync', 'chat-message', 'reaction',
  'webrtc-offer', 'webrtc-answer', 'webrtc-ice',
]);
const sessionDataPath = path.join(tmpdir(), `syncwatch-session-${process.pid}`);
mkdirSync(sessionDataPath, { recursive: true });
app.setPath('sessionData', sessionDataPath);
let signalingSocket;
let localSignalingServer;
let signalingServerUrl;

async function startLocalSignalingServer() {
  const configuredUrl = getSignalingServerUrl();
  if (configuredUrl) {
    signalingServerUrl = configuredUrl;
    return;
  }

  const port = Number(process.env.SYNCWATCH_SERVER_PORT ?? 3000);
  const url = `http://127.0.0.1:${port}`;
  const server = createSignalingServer({ host: '127.0.0.1', port });
  try {
    await server.listen();
    localSignalingServer = server;
    signalingServerUrl = url;
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
}

ipcMain.handle('video:open', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(window, {
    title: 'Open a video',
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
  return {
    name: path.basename(filePath),
    url: pathToFileURL(filePath).href,
  };
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

ipcMain.handle('app:get-config', () => ({
  signalingServerUrl,
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    ...(process.env.SYNCWATCH_TURN_URL ? [{
      urls: process.env.SYNCWATCH_TURN_URL,
      username: process.env.SYNCWATCH_TURN_USERNAME ?? '',
      credential: process.env.SYNCWATCH_TURN_CREDENTIAL ?? '',
    }] : []),
  ],
}));

ipcMain.handle('room:connect', async (_event, serverUrl) => {
  if (typeof serverUrl !== 'string' || !/^https?:\/\//.test(serverUrl)) {
    throw new Error('The signaling server URL must start with http:// or https://.');
  }
  if (signalingSocket?.connected && signalingSocket.io.uri === serverUrl) {
    return { id: signalingSocket.id };
  }

  signalingSocket?.disconnect();
  signalingSocket = io(serverUrl, { autoConnect: false, timeout: 8000 });
  for (const eventName of roomEvents) {
    signalingSocket.on(eventName, (...args) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('room:event', { event: eventName, args });
        }
      }
    });
  }

  await new Promise((resolve, reject) => {
    signalingSocket.once('connect', resolve);
    signalingSocket.once('connect_error', reject);
    signalingSocket.connect();
  }).catch((error) => {
    signalingSocket?.disconnect();
    signalingSocket = undefined;
    throw new Error(`Could not connect to signaling server: ${error.message}`);
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
  if (!localSignalingServer) return;

  event.preventDefault();
  const server = localSignalingServer;
  localSignalingServer = undefined;
  server.close().finally(() => app.quit());
});