const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncwatch', {
  openVideo: () => ipcRenderer.invoke('video:open'),
  openSubtitle: () => ipcRenderer.invoke('subtitle:open'),
  mpvCommand: (action, value) => ipcRenderer.invoke('mpv:command', action, value),
  getMpvState: () => ipcRenderer.invoke('mpv:get-state'),
  setMpvViewport: (bounds) => ipcRenderer.invoke('mpv:set-viewport', bounds),
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  connect: (serverUrl) => ipcRenderer.invoke('room:connect', serverUrl),
  joinRoom: (payload) => ipcRenderer.invoke('room:join', payload),
  leaveRoom: () => ipcRenderer.invoke('room:leave'),
  emit: (eventName, payload) => ipcRenderer.invoke('room:emit', eventName, payload),
  disconnect: () => ipcRenderer.invoke('room:disconnect'),
  onRoomEvent: (callback) => {
    const listener = (_event, message) => callback(message.event, ...message.args);
    ipcRenderer.on('room:event', listener);
    return () => ipcRenderer.removeListener('room:event', listener);
  },
  onMpvEvent: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('mpv:event', listener);
    return () => ipcRenderer.removeListener('mpv:event', listener);
  },
});