const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncwatch', {
  openVideo: () => ipcRenderer.invoke('video:open'),
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
});