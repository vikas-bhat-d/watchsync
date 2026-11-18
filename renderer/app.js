const byId = (id) => document.getElementById(id);
const video = byId('video');
const seek = byId('seek');
const playPauseButton = byId('play-pause');
const speedSelect = byId('speed');
const roomCodeInput = byId('room-code');
const usernameInput = byId('username');
const chatMessages = byId('chat-messages');
const localStream = new MediaStream();
const peers = new Map();
const displayNames = new Map();

let roomState = null;
let signalingServerUrl = 'http://127.0.0.1:3000';
let iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
let hostHeartbeatTimer;
let driftCheckTimer;
let toastTimer;
let unreadMessages = 0;
let lastHostState = null;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '--:--:--';
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2800);
}

function setRoomMessage(message, isError = false) {
  const roomMessage = byId('room-message');
  roomMessage.textContent = message;
  roomMessage.dataset.state = isError ? 'error' : 'normal';
}

function setConnectionLabel(message, state = 'idle') {
  byId('connection-label').textContent = message;
  byId('connection-state').dataset.state = state;
}

function canControlPlayback() {
  return !roomState || roomState.isHost;
}

function updatePlaybackControls() {
  const hasVideo = Boolean(video.currentSrc);
  const allowed = canControlPlayback();
  playPauseButton.disabled = !hasVideo || !allowed;
  byId('backward').disabled = !hasVideo || !allowed;
  byId('forward').disabled = !hasVideo || !allowed;
  seek.disabled = !hasVideo || !allowed;
  speedSelect.disabled = !hasVideo || !allowed;
  byId('play-pause').textContent = video.paused ? '▶' : 'Ⅱ';
  byId('play-pause').setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
  byId('play-pause').title = video.paused ? 'Play' : 'Pause';
  byId('playback-status').textContent = roomState && !roomState.isHost
    ? 'Synced to the host'
    : video.paused ? 'Paused' : 'Playing';
}

function updateTime() {
  byId('current-time').textContent = formatTime(video.currentTime);
  byId('duration').textContent = formatTime(video.duration);
  if (Number.isFinite(video.duration) && video.duration > 0 && !seek.matches(':active')) {
    seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
  }
}

function updateRoomUi() {
  const inRoom = Boolean(roomState);
  byId('create-room').hidden = inRoom;
  byId('join-room').hidden = inRoom;
  byId('leave-room').hidden = !inRoom;
  byId('copy-room').hidden = !inRoom;
  roomCodeInput.readOnly = inRoom;
  usernameInput.readOnly = inRoom;
  byId('room-state').textContent = inRoom ? (roomState.isHost ? 'Host' : 'Guest') : 'Offline';
  byId('room-pill').textContent = inRoom ? `ROOM ${roomState.roomId}` : '';
  byId('room-pill').hidden = !inRoom;
  byId('rail-avatar').textContent = inRoom ? roomState.username.slice(0, 2).toUpperCase() : 'SW';
  byId('rail-avatar').setAttribute('aria-label', inRoom ? `${roomState.username} in room` : 'Not in a room');
  byId('chat-input').disabled = !inRoom;
  document.querySelector('.send-button').disabled = !inRoom;
  document.querySelectorAll('.reaction-picker button').forEach((button) => {
    button.disabled = !inRoom;
  });
  byId('toggle-microphone').disabled = !inRoom;
  byId('toggle-camera').disabled = !inRoom;
  byId('sync-action').disabled = !inRoom;
  byId('sync-action').textContent = roomState?.isHost ? 'Force sync' : 'Request sync';
  byId('sync-readout').textContent = inRoom
    ? roomState.isHost ? 'You are hosting' : 'Following host'
    : 'Local playback';
  byId('participant-count').textContent = `${inRoom ? peers.size + 1 : 0}/4`;
  updatePlaybackControls();
}

async function openVideo() {
  byId('media-error').hidden = true;
  try {
    const selectedVideo = await window.syncwatch.openVideo();
    if (!selectedVideo) return;

    video.src = selectedVideo.url;
    video.load();
    video.hidden = false;
    byId('empty-state').hidden = true;
    byId('media-title').textContent = selectedVideo.name;
    byId('playback-status').textContent = 'Loading local video';
    updatePlaybackControls();
  } catch (error) {
    byId('media-error').textContent = error instanceof Error ? error.message : 'The video could not be opened.';
    byId('media-error').hidden = false;
  }
}

function sendHostEvent(type, payload = {}) {
  if (roomState?.isHost) {
    window.syncwatch.emit('sync-event', { type, payload }).catch((error) => showToast(error.message));
  }
}

function hostSnapshot() {
  return {
    seconds: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    playing: !video.paused,
    speed: video.playbackRate || 1,
  };
}

function applyHostEvent(type, payload = {}, serverTime) {
  const receivedAt = Date.now();
  const previous = lastHostState ?? hostSnapshot();
  lastHostState = {
    seconds: Number.isFinite(payload.seconds) ? payload.seconds : previous.seconds,
    playing: typeof payload.playing === 'boolean'
      ? payload.playing
      : type === 'play' ? true : type === 'pause' ? false : previous.playing,
    speed: Number.isFinite(payload.speed) ? payload.speed : previous.speed,
    receivedAt,
  };

  if (!video.currentSrc) {
    byId('playback-status').textContent = 'Open your local copy to sync';
    return;
  }

  if (Number.isFinite(payload.speed)) {
    video.playbackRate = payload.speed;
    speedSelect.value = String(payload.speed);
  }
  if (Number.isFinite(payload.seconds) && Math.abs(video.currentTime - payload.seconds) > 0.8) {
    video.currentTime = payload.seconds;
  }
  if (type === 'play' || type === 'force-sync' || (type === 'heartbeat' && payload.playing)) {
    video.play().catch(() => {
      byId('playback-status').textContent = 'Choose a compatible local video';
    });
  } else if (type === 'pause' || type === 'force-sync' || (type === 'heartbeat' && payload.playing === false)) {
    video.pause();
  }
  if (type === 'seek' && Number.isFinite(payload.seconds)) {
    video.currentTime = payload.seconds;
  }
  updatePlaybackControls();
}

function startSyncTimers() {
  clearInterval(hostHeartbeatTimer);
  clearInterval(driftCheckTimer);
  hostHeartbeatTimer = setInterval(() => {
    if (roomState?.isHost) sendHostEvent('heartbeat', hostSnapshot());
  }, 5000);
  driftCheckTimer = setInterval(() => {
    if (!roomState || roomState.isHost || !lastHostState || !video.currentSrc) return;
    const elapsed = Math.max(0, (Date.now() - lastHostState.receivedAt) / 1000);
    const expected = lastHostState.seconds + (lastHostState.playing ? elapsed * lastHostState.speed : 0);
    const drift = Math.abs(video.currentTime - expected);
    byId('sync-readout').textContent = `Drift ${drift.toFixed(1)}s`;
    if (drift > 3) {
      applyHostEvent('force-sync', { ...lastHostState, seconds: expected });
      showToast('Playback resynced');
    }
  }, 5000);
}

async function joinRoom(roomId) {
  const username = usernameInput.value.trim();
  if (!username) {
    setRoomMessage('Enter your display name first.', true);
    usernameInput.focus();
    return;
  }
  if (!roomId) {
    setRoomMessage('Enter a room code to join.', true);
    roomCodeInput.focus();
    return;
  }

  setRoomMessage('Connecting to the watch room...');
  try {
    const connection = await window.syncwatch.connect(signalingServerUrl);
    const response = await window.syncwatch.joinRoom({ roomId, username });
    if (!response.ok) {
      throw new Error(response.error);
    }

    roomState = {
      roomId: response.roomId,
      username: response.username,
      socketId: connection.id,
      hostId: response.hostId,
      isHost: response.isHost,
    };
    usernameInput.value = response.username;
    localStorage.setItem('syncwatch-username', response.username);
    roomCodeInput.value = response.roomId;
    displayNames.set(connection.id, response.username);
    for (const peer of response.peers) {
      displayNames.set(peer.id, peer.username);
      createPeerConnection(peer.id, peer.username);
    }

    if (response.playbackState) {
      lastHostState = { ...response.playbackState, receivedAt: Date.now() };
      if (video.currentSrc) applyHostEvent('force-sync', response.playbackState);
    }
    setConnectionLabel('Connected to room', 'connected');
    setRoomMessage(roomState.isHost ? 'You are hosting. Share the room code.' : 'Room joined. Open your copy of the same video.');
    byId('chat-messages').replaceChildren();
    unreadMessages = 0;
    updateUnreadBadge();
    updateRoomUi();
    updatePeerCount();
    startSyncTimers();
    if (roomState.isHost) sendHostEvent('heartbeat', hostSnapshot());
    appendSystemMessage(`${response.username} joined the room`);
  } catch (error) {
    setConnectionLabel('Not connected', 'error');
    setRoomMessage(error instanceof Error ? error.message : 'Could not join the room.', true);
  }
}

function makeRoomCode() {
  return `movie-night-${Math.random().toString(36).slice(2, 6)}`;
}

async function createRoom() {
  if (!roomCodeInput.value.trim()) roomCodeInput.value = makeRoomCode();
  await joinRoom(roomCodeInput.value.trim());
}

async function leaveRoom() {
  if (!roomState) return;
  try {
    await window.syncwatch.leaveRoom();
  } catch {
    // Continue local cleanup when the signaling connection has already closed.
  }
  clearInterval(hostHeartbeatTimer);
  clearInterval(driftCheckTimer);
  for (const peerId of [...peers.keys()]) closePeer(peerId);
  for (const track of localStream.getTracks()) {
    track.stop();
    localStream.removeTrack(track);
  }
  byId('local-camera').srcObject = null;
  byId('local-tile').classList.remove('has-camera');
  byId('local-placeholder').hidden = false;
  byId('toggle-camera').textContent = 'Camera off';
  byId('toggle-microphone').textContent = 'Mic off';
  roomState = null;
  lastHostState = null;
  displayNames.clear();
  roomCodeInput.readOnly = false;
  usernameInput.readOnly = false;
  setConnectionLabel('Not connected', 'idle');
  setRoomMessage('Create a room or enter a code to join.');
  updateRoomUi();
  updatePeerCount();
  await window.syncwatch.disconnect().catch(() => {});
}

function appendSystemMessage(text) {
  const item = document.createElement('p');
  item.className = 'chat-system-message';
  item.textContent = text;
  chatMessages.append(item);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendChatMessage(message) {
  const item = document.createElement('article');
  item.className = `chat-message${message.senderId === roomState?.socketId ? ' is-self' : ''}`;
  const heading = document.createElement('div');
  heading.className = 'chat-message-heading';
  const name = document.createElement('span');
  name.textContent = message.username;
  const time = document.createElement('time');
  time.dateTime = new Date(message.ts).toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(message.ts);
  const body = document.createElement('p');
  body.textContent = message.text;
  heading.append(name, time);
  item.append(heading, body);
  chatMessages.append(item);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  byId('chat-count').textContent = String(chatMessages.querySelectorAll('.chat-message').length);

  if (message.senderId !== roomState?.socketId && document.body.dataset.mode === 'theater') {
    unreadMessages += 1;
    updateUnreadBadge();
  }
}

function updateUnreadBadge() {
  const badge = byId('unread-badge');
  badge.textContent = String(unreadMessages);
  badge.hidden = unreadMessages === 0;
}

function showFloatingReaction(emoji, senderId) {
  const reaction = document.createElement('span');
  const position = Math.floor(Math.random() * 7);
  reaction.className = `floating-reaction reaction-position-${position}`;
  reaction.textContent = emoji;
  reaction.setAttribute('aria-label', `${displayNames.get(senderId) ?? 'Someone'} reacted`);
  byId('reaction-layer').append(reaction);
  reaction.addEventListener('animationend', () => reaction.remove(), { once: true });
}

function createPeerConnection(peerId, username = 'Guest') {
  if (peers.has(peerId) || !roomState) return peers.get(peerId);
  ensureRemoteTile(peerId, username);
  const pc = new RTCPeerConnection({
    iceServers,
  });
  const state = {
    pc,
    polite: roomState.socketId.localeCompare(peerId) > 0,
    makingOffer: false,
    ignoreOffer: false,
    settingRemoteAnswer: false,
    pendingCandidates: [],
  };
  peers.set(peerId, state);
  displayNames.set(peerId, username);
  for (const track of localStream.getTracks()) {
    if (track.readyState === 'live') pc.addTrack(track, localStream);
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) window.syncwatch.emit('webrtc-ice', { to: peerId, candidate: candidate.toJSON() });
  };
  pc.ontrack = (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    attachRemoteStream(peerId, username, stream);
  };
  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      if (pc.localDescription?.type === 'offer') {
        await window.syncwatch.emit('webrtc-offer', {
          to: peerId,
          description: pc.localDescription.toJSON(),
        });
      }
    } catch (error) {
      showToast(`Camera connection failed: ${error.message}`);
    } finally {
      state.makingOffer = false;
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') showToast(`Could not connect to ${username}'s camera.`);
  };
  updatePeerCount();
  return state;
}

function attachRemoteStream(peerId, username, stream) {
  const tile = ensureRemoteTile(peerId, username);
  const remoteVideo = tile.querySelector('video');
  remoteVideo.srcObject = stream;
  remoteVideo.play().catch(() => {});
  tile.classList.add('has-camera');
}

function ensureRemoteTile(peerId, username) {
  let tile = document.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile remote-tile';
    tile.dataset.peerId = peerId;
    const remoteVideo = document.createElement('video');
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;
    remoteVideo.className = 'remote-camera';
    const placeholder = document.createElement('span');
    placeholder.className = 'video-placeholder';
    placeholder.textContent = username.slice(0, 1).toUpperCase();
    const name = document.createElement('span');
    name.className = 'video-name';
    name.textContent = username;
    tile.append(remoteVideo, placeholder, name);
    byId('webcam-grid').append(tile);
  }
  byId('remote-empty').hidden = true;
  return tile;
}

async function flushIceCandidates(state) {
  if (!state.pc.remoteDescription) return;
  for (const candidate of state.pendingCandidates.splice(0)) {
    try {
      await state.pc.addIceCandidate(candidate);
    } catch (error) {
      if (!state.ignoreOffer) showToast(`ICE connection error: ${error.message}`);
    }
  }
}

async function receiveOffer({ from, description }) {
  const username = displayNames.get(from) ?? 'Guest';
  const state = createPeerConnection(from, username);
  if (!state || state.ignoreOffer) return;
  const readyForOffer = !state.makingOffer &&
    (state.pc.signalingState === 'stable' || state.settingRemoteAnswer);
  const collision = description.type === 'offer' && !readyForOffer;
  state.ignoreOffer = !state.polite && collision;
  if (state.ignoreOffer) return;

  try {
    if (collision && state.polite) await state.pc.setLocalDescription({ type: 'rollback' });
    state.settingRemoteAnswer = description.type === 'answer';
    await state.pc.setRemoteDescription(description);
    state.settingRemoteAnswer = false;
    await flushIceCandidates(state);
    if (description.type === 'offer') {
      await state.pc.setLocalDescription();
      await window.syncwatch.emit('webrtc-answer', {
        to: from,
        description: state.pc.localDescription.toJSON(),
      });
    }
  } catch (error) {
    showToast(`Could not negotiate camera with ${username}: ${error.message}`);
  }
}

async function receiveIce({ from, candidate }) {
  const state = peers.get(from);
  if (!state) return;
  if (!state.pc.remoteDescription) {
    state.pendingCandidates.push(candidate);
    return;
  }
  try {
    await state.pc.addIceCandidate(candidate);
  } catch (error) {
    if (!state.ignoreOffer) showToast(`ICE connection error: ${error.message}`);
  }
}

function closePeer(peerId) {
  const state = peers.get(peerId);
  state?.pc.close();
  peers.delete(peerId);
  displayNames.delete(peerId);
  document.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`)?.remove();
  byId('remote-empty').hidden = peers.size > 0;
  updatePeerCount();
}

function updatePeerCount() {
  const count = roomState ? peers.size + 1 : 0;
  byId('participant-count').textContent = `${count}/4`;
  byId('rail-avatar').classList.toggle('has-peers', peers.size > 0);
}

async function toggleDevice(kind) {
  if (!roomState) return;
  const isVideo = kind === 'video';
  const button = byId(isVideo ? 'toggle-camera' : 'toggle-microphone');
  let track = localStream.getTracks().find((item) => item.kind === kind);
  if (track?.readyState === 'live') {
    track.enabled = !track.enabled;
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: isVideo ? { width: { ideal: 320 }, height: { ideal: 180 } } : false,
        audio: isVideo ? false : true,
      });
      track = stream.getTracks().find((item) => item.kind === kind);
      if (!track) throw new Error(`No ${isVideo ? 'camera' : 'microphone'} was returned.`);
      localStream.addTrack(track);
      for (const { pc } of peers.values()) pc.addTrack(track, localStream);
      if (isVideo) {
        byId('local-camera').srcObject = localStream;
        await byId('local-camera').play().catch(() => {});
      }
    } catch (error) {
      showToast(`Could not start ${isVideo ? 'camera' : 'microphone'}: ${error.message}`);
      return;
    }
  }

  const active = track.enabled;
  button.textContent = isVideo ? `Camera ${active ? 'on' : 'off'}` : `Mic ${active ? 'on' : 'off'}`;
  button.classList.toggle('is-active', active);
  if (isVideo) {
    byId('local-tile').classList.toggle('has-camera', active);
    byId('local-placeholder').hidden = active;
  }
}

async function openWebcamPictureInPicture() {
  const remoteVideo = document.querySelector('.remote-camera');
  const targetVideo = remoteVideo?.srcObject ? remoteVideo : byId('local-camera');
  const tile = targetVideo.closest('.video-tile');
  if (!targetVideo.srcObject) {
    showToast('Turn on a camera or wait for a participant camera first.');
    return;
  }
  if (document.pictureInPictureElement === targetVideo) {
    await document.exitPictureInPicture();
    return;
  }

  if (document.pictureInPictureEnabled && typeof targetVideo.requestPictureInPicture === 'function') {
    try {
      await targetVideo.requestPictureInPicture();
      return;
    } catch {
      // Use the in-window floating tile when native picture-in-picture is unavailable.
    }
  }
  tile.classList.toggle('is-floating');
}

function handleRoomEvent(event, payload) {
  if (event === 'connect') {
    setConnectionLabel(roomState ? 'Connected to room' : 'Connected to server', 'connected');
  } else if (event === 'disconnect') {
    setConnectionLabel('Connection lost', 'error');
  } else if (event === 'connect_error') {
    setConnectionLabel('Server unavailable', 'error');
  } else if (event === 'peer-joined') {
    displayNames.set(payload.id, payload.username);
    createPeerConnection(payload.id, payload.username);
    setRoomMessage(`${payload.username} joined the room.`);
    appendSystemMessage(`${payload.username} joined`);
    updatePeerCount();
  } else if (event === 'peer-left') {
    closePeer(payload.id);
    setRoomMessage(`${payload.username} left the room.`);
    appendSystemMessage(`${payload.username} left`);
  } else if (event === 'host-changed') {
    if (!roomState) return;
    roomState.hostId = payload.hostId;
    roomState.isHost = payload.hostId === roomState.socketId;
    updateRoomUi();
    startSyncTimers();
    if (roomState.isHost) sendHostEvent('heartbeat', hostSnapshot());
    showToast(roomState.isHost ? 'You are now the host.' : 'The room host changed.');
  } else if (event === 'sync-event') {
    if (roomState && !roomState.isHost) applyHostEvent(payload.type, payload.payload, payload.serverTime);
  } else if (event === 'sync-request') {
    showToast(`${payload.username} requested a sync.`);
  } else if (event === 'chat-message') {
    appendChatMessage(payload);
  } else if (event === 'reaction') {
    showFloatingReaction(payload.emoji, payload.senderId);
  } else if (event === 'webrtc-offer') {
    receiveOffer(payload);
  } else if (event === 'webrtc-answer') {
    const state = peers.get(payload.from);
    if (state) {
      state.pc.setRemoteDescription(payload.description)
        .then(() => flushIceCandidates(state))
        .catch((error) => showToast(`Could not accept camera connection: ${error.message}`));
    }
  } else if (event === 'webrtc-ice') {
    receiveIce(payload);
  }
}

document.querySelectorAll('.mode-button').forEach((button) => {
  button.addEventListener('click', () => {
    document.body.dataset.mode = button.dataset.mode;
    document.querySelectorAll('.mode-button').forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    if (button.dataset.mode === 'panel') {
      unreadMessages = 0;
      updateUnreadBadge();
    }
  });
});

document.querySelectorAll('#open-video, #open-empty').forEach((button) => button.addEventListener('click', openVideo));
byId('create-room').addEventListener('click', createRoom);
byId('join-room').addEventListener('click', () => joinRoom(roomCodeInput.value.trim()));
byId('leave-room').addEventListener('click', leaveRoom);
byId('toggle-camera').addEventListener('click', () => toggleDevice('video'));
byId('toggle-microphone').addEventListener('click', () => toggleDevice('audio'));
byId('pip-webcam').addEventListener('click', openWebcamPictureInPicture);
byId('rail-chat').addEventListener('click', () => {
  document.querySelector('[data-mode="panel"]').click();
  byId('chat-input').focus();
});
byId('rail-expand').addEventListener('click', () => document.querySelector('[data-mode="panel"]').click());
byId('copy-room').addEventListener('click', async () => {
  if (!roomState) return;
  try {
    await navigator.clipboard.writeText(roomState.roomId);
    showToast('Room code copied.');
  } catch {
    showToast(`Room code: ${roomState.roomId}`);
  }
});

playPauseButton.addEventListener('click', async () => {
  if (!canControlPlayback()) return;
  if (video.paused) {
    try {
      await video.play();
      sendHostEvent('play');
    } catch {
      byId('media-error').textContent = 'This file may use a format the current player cannot decode.';
      byId('media-error').hidden = false;
    }
  } else {
    video.pause();
    sendHostEvent('pause');
  }
  updatePlaybackControls();
});

byId('backward').addEventListener('click', () => {
  video.currentTime = Math.max(0, video.currentTime - 10);
  sendHostEvent('seek', { seconds: video.currentTime });
});
byId('forward').addEventListener('click', () => {
  video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
  sendHostEvent('seek', { seconds: video.currentTime });
});
seek.addEventListener('input', () => {
  if (Number.isFinite(video.duration)) video.currentTime = (Number(seek.value) / 1000) * video.duration;
});
seek.addEventListener('change', () => sendHostEvent('seek', { seconds: video.currentTime }));
speedSelect.addEventListener('change', () => {
  video.playbackRate = Number(speedSelect.value);
  sendHostEvent('speed', { speed: video.playbackRate });
});
byId('volume').addEventListener('input', (event) => {
  video.volume = Number(event.currentTarget.value) / 100;
});
byId('sync-action').addEventListener('click', () => {
  if (roomState?.isHost) sendHostEvent('force-sync', hostSnapshot());
  else window.syncwatch.emit('request-sync').catch((error) => showToast(error.message));
});

byId('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = byId('chat-input').value.trim();
  if (!text || !roomState) return;
  window.syncwatch.emit('chat-message', { text }).catch((error) => showToast(error.message));
  byId('chat-input').value = '';
});
document.querySelectorAll('.reaction-picker button').forEach((button) => {
  button.addEventListener('click', () => {
    if (roomState) window.syncwatch.emit('reaction', { emoji: button.dataset.emoji });
  });
});

video.addEventListener('loadedmetadata', () => {
  updateTime();
  video.volume = Number(byId('volume').value) / 100;
  video.playbackRate = Number(speedSelect.value);
  updatePlaybackControls();
  if (roomState && !roomState.isHost && lastHostState) {
    applyHostEvent('force-sync', lastHostState);
  }
});
video.addEventListener('timeupdate', updateTime);
video.addEventListener('play', updatePlaybackControls);
video.addEventListener('pause', updatePlaybackControls);
video.addEventListener('ended', updatePlaybackControls);
video.addEventListener('error', () => {
  byId('playback-status').textContent = 'Unsupported video format';
  byId('media-error').textContent = 'This file is not supported by the current browser player. mpv playback is the next player integration.';
  byId('media-error').hidden = false;
});

window.syncwatch.onRoomEvent(handleRoomEvent);
window.syncwatch.getConfig().then((config) => {
  signalingServerUrl = config.signalingServerUrl;
  iceServers = config.iceServers ?? iceServers;
}).catch(() => {});
usernameInput.value = localStorage.getItem('syncwatch-username') ?? '';
updateRoomUi();
updateTime();