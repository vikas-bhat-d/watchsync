const byId = (id) => document.getElementById(id);
const video = byId('video');
const seek = byId('seek');
const playPauseButton = byId('play-pause');
const speedSelect = byId('speed');
const audioTrackSelect = byId('audio-track');
const subtitleTrackSelect = byId('subtitle-track');
const aspectRatioSelect = byId('aspect-ratio');
const playerColumn = document.querySelector('.player-column');
const playerFrame = byId('player-frame');
const roomCodeInput = byId('room-code');
const usernameInput = byId('username');
const chatMessages = byId('chat-messages');
const localStream = new MediaStream();
const peers = new Map();
const displayNames = new Map();
const mpvState = {
  loaded: false,
  position: 0,
  duration: NaN,
  paused: true,
  speed: 1,
  volume: 100,
  muted: false,
  trackList: [],
};

let roomState = null;
let playerEngine = 'browser';
let signalingServerUrl = 'http://127.0.0.1:3000';
let iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
let hostHeartbeatTimer;
let driftCheckTimer;
let toastTimer;
let controlsHideTimer;
let mpvViewportFrame = 0;
let unreadMessages = 0;
let lastHostState = null;
const subtitleBlobUrls = [];

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
  return true;
}

function hasLoadedVideo() {
  return playerEngine === 'mpv' ? mpvState.loaded : Boolean(video.currentSrc);
}

function playerPosition() {
  return playerEngine === 'mpv' ? mpvState.position : video.currentTime;
}

function playerDuration() {
  return playerEngine === 'mpv' ? mpvState.duration : video.duration;
}

function playerPaused() {
  return playerEngine === 'mpv' ? mpvState.paused : video.paused;
}

function playerSpeed() {
  return playerEngine === 'mpv' ? mpvState.speed : video.playbackRate;
}

function setMpvProperty(action, value) {
  return window.syncwatch.mpvCommand(action, value).catch((error) => showToast(error.message));
}

function updatePlaybackControls() {
  const hasVideo = hasLoadedVideo();
  const allowed = canControlPlayback();
  const paused = playerPaused();
  playPauseButton.disabled = !hasVideo || !allowed;
  byId('backward').disabled = !hasVideo || !allowed;
  byId('forward').disabled = !hasVideo || !allowed;
  seek.disabled = !hasVideo || !allowed;
  speedSelect.disabled = !hasVideo || !allowed;
  byId('play-pause').textContent = paused ? '▶' : 'Ⅱ';
  byId('play-pause').setAttribute('aria-label', paused ? 'Play' : 'Pause');
  byId('play-pause').title = paused ? 'Play' : 'Pause';
  byId('playback-status').textContent = paused ? 'Paused' : 'Playing';
}

function updateTime() {
  const position = playerPosition();
  const duration = playerDuration();
  byId('current-time').textContent = formatTime(position);
  byId('duration').textContent = formatTime(duration);
  if (Number.isFinite(duration) && duration > 0 && !seek.matches(':active')) {
    seek.value = String(Math.round((position / duration) * 1000));
  }
}

function updateMpvViewport() {
  if (playerEngine !== 'mpv') return;
  const bounds = playerFrame.getBoundingClientRect();
  window.syncwatch.setMpvViewport({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    scaleFactor: window.devicePixelRatio || 1,
  }).catch((error) => showToast(error.message));
}

function queueMpvViewportUpdate() {
  if (mpvViewportFrame) cancelAnimationFrame(mpvViewportFrame);
  mpvViewportFrame = requestAnimationFrame(() => {
    mpvViewportFrame = 0;
    updateMpvViewport();
  });
}

function updateAudioTracks() {
  if (playerEngine === 'mpv') {
    const tracks = mpvState.trackList.filter((track) => track.type === 'audio');
    audioTrackSelect.replaceChildren(new Option('Audio', 'auto'));
    for (const [index, track] of tracks.entries()) {
      const label = track.title || track.lang || `Track ${index + 1}`;
      audioTrackSelect.add(new Option(label, String(track.id), false, Boolean(track.selected)));
    }
    audioTrackSelect.disabled = tracks.length === 0;
    return;
  }

  const tracks = video.audioTracks;
  audioTrackSelect.replaceChildren(new Option('Audio', 'default'));
  if (!tracks || tracks.length < 2) {
    audioTrackSelect.disabled = true;
    return;
  }

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    const label = track.label || track.language || `Track ${index + 1}`;
    const option = new Option(label, String(index), false, track.enabled);
    audioTrackSelect.add(option);
  }
  audioTrackSelect.disabled = false;
}

function updateMuteButton() {
  const muted = playerEngine === 'mpv' ? mpvState.muted || mpvState.volume === 0 : video.muted || video.volume === 0;
  byId('toggle-mute').textContent = muted ? 'Unmute' : 'Mute';
  byId('toggle-mute').title = muted ? 'Unmute audio' : 'Mute audio';
  byId('toggle-mute').setAttribute('aria-pressed', String(muted));
}

function updateAspectRatio() {
  const selection = aspectRatioSelect.value;
  if (playerEngine === 'mpv') {
    const value = selection === 'fill' ? 'fill' : selection === 'auto' ? 'auto' : Number(selection);
    setMpvProperty('aspect', value);
    return;
  }

  if (!video.currentSrc || selection === 'auto') {
    video.style.removeProperty('left');
    video.style.removeProperty('top');
    video.style.removeProperty('right');
    video.style.removeProperty('bottom');
    video.style.removeProperty('transform');
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    return;
  }

  video.style.left = '50%';
  video.style.top = '50%';
  video.style.right = 'auto';
  video.style.bottom = 'auto';
  video.style.transform = 'translate(-50%, -50%)';
  if (selection === 'fill') {
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'fill';
    return;
  }

  const ratio = Number(selection);
  const bounds = playerFrame.getBoundingClientRect();
  let width = bounds.width;
  let height = width / ratio;
  if (height > bounds.height) {
    height = bounds.height;
    width = height * ratio;
  }
  video.style.width = `${width}px`;
  video.style.height = `${height}px`;
  video.style.objectFit = 'fill';
}

function clearExternalSubtitles() {
  video.querySelectorAll('track[data-external-subtitle]').forEach((track) => track.remove());
  while (subtitleBlobUrls.length) URL.revokeObjectURL(subtitleBlobUrls.pop());
  subtitleTrackSelect.replaceChildren(new Option('Subtitles off', 'off'));
  subtitleTrackSelect.disabled = true;
}

function updateSubtitleTracks() {
  if (playerEngine === 'mpv') {
    const tracks = mpvState.trackList.filter((track) => track.type === 'sub');
    subtitleTrackSelect.replaceChildren(new Option('Subtitles off', 'off'));
    for (const [index, track] of tracks.entries()) {
      const label = track.title || track.lang || `Subtitle ${index + 1}`;
      subtitleTrackSelect.add(new Option(label, String(track.id), false, Boolean(track.selected)));
    }
    subtitleTrackSelect.disabled = tracks.length === 0;
    return;
  }

  const selected = subtitleTrackSelect.value;
  const tracks = Array.from(video.textTracks ?? []);
  subtitleTrackSelect.replaceChildren(new Option('Subtitles off', 'off'));
  tracks.forEach((track, index) => {
    const element = video.querySelectorAll('track')[index];
    const label = track.label || element?.label || track.language || `Track ${index + 1}`;
    subtitleTrackSelect.add(new Option(label, String(index), false, track.mode === 'showing'));
  });
  subtitleTrackSelect.disabled = tracks.length === 0;
  if (selected !== 'off' && Number(selected) < tracks.length) subtitleTrackSelect.value = selected;
}

async function loadSubtitleFile() {
  try {
    const subtitle = await window.syncwatch.openSubtitle();
    if (!subtitle) return;

    if (subtitle.engine === 'mpv') {
      mpvState.trackList = await window.syncwatch.mpvCommand('refresh-tracks');
      updateSubtitleTracks();
      showToast(`Loaded subtitles: ${subtitle.name}`);
      return;
    }

    clearExternalSubtitles();
    const isWebVtt = subtitle.name.toLowerCase().endsWith('.vtt') && /^\s*WEBVTT/m.test(subtitle.content);
    const content = isWebVtt
      ? subtitle.content
      : `WEBVTT\n\n${subtitle.content.replace(/^\uFEFF/, '').replace(/\r/g, '').replace(/(\d{2}:\d{2}(?::\d{2})?),(\d{3})/g, '$1.$2')}`;
    const subtitleUrl = URL.createObjectURL(new Blob([content], { type: 'text/vtt' }));
    subtitleBlobUrls.push(subtitleUrl);

    const trackElement = document.createElement('track');
    trackElement.kind = 'subtitles';
    trackElement.label = subtitle.name;
    trackElement.srclang = 'en';
    trackElement.dataset.externalSubtitle = 'true';
    trackElement.src = subtitleUrl;
    video.append(trackElement);
    trackElement.track.mode = 'showing';
    trackElement.addEventListener('load', updateSubtitleTracks, { once: true });
    updateSubtitleTracks();
    subtitleTrackSelect.value = String(video.textTracks.length - 1);
    showToast(`Loaded subtitles: ${subtitle.name}`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not load subtitles.');
  }
}

function applyMpvState(state) {
  if (Number.isFinite(state['time-pos'])) mpvState.position = state['time-pos'];
  if (Number.isFinite(state.duration)) mpvState.duration = state.duration;
  if (typeof state.pause === 'boolean') mpvState.paused = state.pause;
  if (Number.isFinite(state.speed)) mpvState.speed = state.speed;
  if (Number.isFinite(state.volume)) mpvState.volume = state.volume;
  if (typeof state.mute === 'boolean') mpvState.muted = state.mute;
  if (Array.isArray(state['track-list'])) mpvState.trackList = state['track-list'];
  updateAudioTracks();
  updateSubtitleTracks();
  updateMuteButton();
  updateTime();
  updatePlaybackControls();
}

function handleMpvEvent({ name, value }) {
  if (name === 'engine-exit') {
    playerEngine = 'browser';
    mpvState.loaded = false;
    byId('mpv-status').hidden = true;
    byId('media-error').textContent = 'The mpv player window closed.';
    byId('media-error').hidden = false;
    updatePlaybackControls();
    return;
  }

  if (name === 'file-loaded') {
    mpvState.loaded = true;
    window.syncwatch.getMpvState().then((state) => {
      if (state) applyMpvState(state);
      if (roomState && !roomState.isHost && lastHostState) applyHostEvent('force-sync', lastHostState);
    }).catch((error) => showToast(error.message));
    updatePlaybackControls();
    return;
  }

  if (name === 'time-pos' && Number.isFinite(value)) mpvState.position = value;
  else if (name === 'duration' && Number.isFinite(value)) mpvState.duration = value;
  else if (name === 'pause' && typeof value === 'boolean') mpvState.paused = value;
  else if (name === 'speed' && Number.isFinite(value)) {
    mpvState.speed = value;
    if ([...speedSelect.options].some((option) => Number(option.value) === value)) speedSelect.value = String(value);
  } else if (name === 'volume' && Number.isFinite(value)) {
    mpvState.volume = value;
    byId('volume').value = String(Math.round(value));
  } else if (name === 'mute' && typeof value === 'boolean') mpvState.muted = value;
  else if (name === 'track-list' && Array.isArray(value)) mpvState.trackList = value;

  if (name === 'track-list') {
    updateAudioTracks();
    updateSubtitleTracks();
  }
  if (name === 'volume' || name === 'mute') updateMuteButton();
  if (name === 'time-pos' || name === 'duration') updateTime();
  updatePlaybackControls();
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
  byId('room-settings-button').disabled = !inRoom;
  byId('apply-settings').disabled = !roomState?.isHost;
  byId('drift-tolerance').value = String(roomState?.driftTolerance ?? 3);
  byId('drift-tolerance-value').textContent = `${(roomState?.driftTolerance ?? 3).toFixed(1)} s`;
  byId('settings-note').textContent = roomState?.isHost
    ? 'Changes apply to everyone in this room.'
    : 'Only the room host can change this threshold.';
  byId('sync-readout').textContent = inRoom
    ? roomState.isHost ? 'You are hosting' : 'Shared playback'
    : 'Local playback';
  byId('participant-count').textContent = `${inRoom ? peers.size + 1 : 0}/4`;
  updatePlaybackControls();
}

async function openVideo() {
  byId('media-error').hidden = true;
  try {
    const selectedVideo = await window.syncwatch.openVideo();
    if (!selectedVideo) return;

    playerEngine = selectedVideo.engine;
    byId('empty-state').hidden = true;
    byId('mpv-status').hidden = playerEngine !== 'mpv';
    video.hidden = playerEngine === 'mpv';
    byId('media-title').textContent = selectedVideo.name;

    if (playerEngine === 'mpv') {
      video.pause();
      video.removeAttribute('src');
      video.load();
      mpvState.loaded = true;
      mpvState.position = 0;
      mpvState.paused = true;
      byId('mpv-status-title').textContent = `${selectedVideo.name} is playing in mpv`;
      byId('playback-status').textContent = 'Playing in mpv';
      await window.syncwatch.mpvCommand('volume', Number(byId('volume').value));
      mpvState.trackList = await window.syncwatch.mpvCommand('refresh-tracks');
      const state = await window.syncwatch.getMpvState();
      if (state) applyMpvState(state);
      if (roomState && !roomState.isHost && lastHostState) {
        applyHostEvent('force-sync', lastHostState);
      }
    } else {
      mpvState.loaded = false;
      video.src = selectedVideo.url;
      video.load();
      byId('playback-status').textContent = selectedVideo.mpvUnavailable
        ? 'Browser fallback · install mpv for full format support'
        : 'Loading local video';
      if (selectedVideo.mpvUnavailable) showToast('mpv was not found. Using the limited browser player.');
    }
    updatePlaybackControls();
    updateAudioTracks();
    updateSubtitleTracks();
    updateTime();
    queueMpvViewportUpdate();
  } catch (error) {
    byId('media-error').textContent = error instanceof Error ? error.message : 'The video could not be opened.';
    byId('media-error').hidden = false;
  }
}

function sendHostEvent(type, payload = {}) {
  if (roomState && (type !== 'heartbeat' || roomState.isHost)) {
    window.syncwatch.emit('sync-event', { type, payload }).catch((error) => showToast(error.message));
  }
}

function hostSnapshot() {
  return {
    seconds: Number.isFinite(playerPosition()) ? playerPosition() : 0,
    playing: !playerPaused(),
    speed: playerSpeed() || 1,
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

  if (!hasLoadedVideo()) {
    byId('playback-status').textContent = 'Open your local copy to sync';
    return;
  }

  if (playerEngine === 'mpv') {
    if (Number.isFinite(payload.speed)) setMpvProperty('speed', payload.speed);
    if (Number.isFinite(payload.seconds) && Math.abs(mpvState.position - payload.seconds) > 0.8) {
      setMpvProperty('seek', payload.seconds);
    }
    if (type === 'seek' && Number.isFinite(payload.seconds)) setMpvProperty('seek', payload.seconds);
    if (type === 'play' || type === 'force-sync' || (type === 'heartbeat' && payload.playing)) {
      setMpvProperty('play');
    } else if (type === 'pause' || type === 'force-sync' || (type === 'heartbeat' && payload.playing === false)) {
      setMpvProperty('pause');
    }
    updatePlaybackControls();
    updateTime();
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
    if (!roomState || roomState.isHost || !lastHostState || !hasLoadedVideo()) return;
    const elapsed = Math.max(0, (Date.now() - lastHostState.receivedAt) / 1000);
    const expected = lastHostState.seconds + (lastHostState.playing ? elapsed * lastHostState.speed : 0);
    const drift = Math.abs(playerPosition() - expected);
    byId('sync-readout').textContent = `Drift ${drift.toFixed(1)}s`;
    if (drift > (roomState.driftTolerance ?? 3)) {
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
      driftTolerance: response.settings?.driftTolerance ?? 3,
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
    if (roomState && payload.from !== roomState.socketId) {
      applyHostEvent(payload.type, payload.payload, payload.serverTime);
    }
  } else if (event === 'sync-settings') {
    if (!roomState) return;
    roomState.driftTolerance = payload.driftTolerance;
    updateRoomUi();
    if (payload.from !== roomState.socketId) showToast(`Room sync tolerance set to ${payload.driftTolerance.toFixed(1)} seconds.`);
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
    queueMpvViewportUpdate();
  });
});

document.querySelectorAll('#open-video, #open-empty').forEach((button) => button.addEventListener('click', openVideo));
byId('create-room').addEventListener('click', createRoom);
byId('join-room').addEventListener('click', () => joinRoom(roomCodeInput.value.trim()));
byId('leave-room').addEventListener('click', leaveRoom);
byId('room-settings-button').addEventListener('click', () => {
  byId('room-settings-dialog').showModal();
});
byId('close-settings').addEventListener('click', () => byId('room-settings-dialog').close());
byId('cancel-settings').addEventListener('click', () => {
  updateRoomUi();
  byId('room-settings-dialog').close();
});
byId('drift-tolerance').addEventListener('input', (event) => {
  byId('drift-tolerance-value').textContent = `${Number(event.currentTarget.value).toFixed(1)} s`;
});
byId('apply-settings').addEventListener('click', () => {
  if (!roomState?.isHost) return;
  const driftTolerance = Number(byId('drift-tolerance').value);
  roomState.driftTolerance = driftTolerance;
  updateRoomUi();
  window.syncwatch.emit('sync-settings', { driftTolerance }).catch((error) => showToast(error.message));
  byId('room-settings-dialog').close();
  showToast(`Room sync tolerance set to ${driftTolerance.toFixed(1)} seconds.`);
});
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
  if (playerPaused()) {
    try {
      if (playerEngine === 'mpv') await window.syncwatch.mpvCommand('play');
      else await video.play();
      sendHostEvent('play');
    } catch {
      byId('media-error').textContent = 'This file may use a format the current player cannot decode.';
      byId('media-error').hidden = false;
    }
  } else {
    if (playerEngine === 'mpv') setMpvProperty('pause');
    else video.pause();
    sendHostEvent('pause');
  }
  updatePlaybackControls();
});

byId('backward').addEventListener('click', () => {
  const seconds = Math.max(0, playerPosition() - 10);
  if (playerEngine === 'mpv') setMpvProperty('seek', seconds);
  else video.currentTime = seconds;
  sendHostEvent('seek', { seconds });
});
byId('forward').addEventListener('click', () => {
  const seconds = Math.min(playerDuration() || Infinity, playerPosition() + 10);
  if (playerEngine === 'mpv') setMpvProperty('seek', seconds);
  else video.currentTime = seconds;
  sendHostEvent('seek', { seconds });
});
seek.addEventListener('input', () => {
  if (playerEngine === 'browser' && Number.isFinite(video.duration)) {
    video.currentTime = (Number(seek.value) / 1000) * video.duration;
  }
});
seek.addEventListener('change', () => {
  const seconds = (Number(seek.value) / 1000) * playerDuration();
  if (!Number.isFinite(seconds)) return;
  if (playerEngine === 'mpv') setMpvProperty('seek', seconds);
  else video.currentTime = seconds;
  sendHostEvent('seek', { seconds });
});
speedSelect.addEventListener('change', () => {
  const speed = Number(speedSelect.value);
  if (playerEngine === 'mpv') setMpvProperty('speed', speed);
  else video.playbackRate = speed;
  sendHostEvent('speed', { speed });
});
byId('volume').addEventListener('input', (event) => {
  const volume = Number(event.currentTarget.value);
  if (playerEngine === 'mpv') {
    mpvState.volume = volume;
    setMpvProperty('volume', volume);
    if (volume > 0 && mpvState.muted) {
      mpvState.muted = false;
      setMpvProperty('mute', false);
    }
  } else {
    video.volume = volume / 100;
    if (video.volume > 0) video.muted = false;
  }
  updateMuteButton();
});
byId('toggle-mute').addEventListener('click', () => {
  if (playerEngine === 'mpv') {
    mpvState.muted = !mpvState.muted;
    setMpvProperty('mute', mpvState.muted);
  } else {
    video.muted = !video.muted;
  }
  updateMuteButton();
});
audioTrackSelect.addEventListener('change', () => {
  if (playerEngine === 'mpv') {
    setMpvProperty('audio-track', audioTrackSelect.value === 'auto' ? 'auto' : Number(audioTrackSelect.value));
    return;
  }
  const tracks = video.audioTracks;
  if (!tracks || audioTrackSelect.value === 'default') return;
  const selectedIndex = Number(audioTrackSelect.value);
  for (let index = 0; index < tracks.length; index += 1) {
    tracks[index].enabled = index === selectedIndex;
  }
});
subtitleTrackSelect.addEventListener('change', () => {
  if (playerEngine === 'mpv') {
    setMpvProperty('subtitle-track', subtitleTrackSelect.value === 'off' ? 'off' : Number(subtitleTrackSelect.value));
    return;
  }
  const selectedIndex = subtitleTrackSelect.value === 'off' ? -1 : Number(subtitleTrackSelect.value);
  Array.from(video.textTracks ?? []).forEach((track, index) => {
    track.mode = index === selectedIndex ? 'showing' : 'disabled';
  });
});
byId('load-subtitles').addEventListener('click', loadSubtitleFile);
aspectRatioSelect.addEventListener('change', updateAspectRatio);
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
  video.muted = false;
  updateMuteButton();
  video.playbackRate = Number(speedSelect.value);
  aspectRatioSelect.value = 'auto';
  updateAspectRatio();
  updateAudioTracks();
  updateSubtitleTracks();
  updatePlaybackControls();
  if (roomState && !roomState.isHost && lastHostState) {
    applyHostEvent('force-sync', lastHostState);
  }
});
video.addEventListener('loadeddata', updateAudioTracks);
video.addEventListener('addtrack', updateAudioTracks);
video.textTracks?.addEventListener('addtrack', updateSubtitleTracks);
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
window.syncwatch.onMpvEvent(handleMpvEvent);
window.syncwatch.getConfig().then((config) => {
  signalingServerUrl = config.signalingServerUrl;
  iceServers = config.iceServers ?? iceServers;
}).catch(() => {});
usernameInput.value = localStorage.getItem('syncwatch-username') ?? '';
updateRoomUi();
updateTime();
updateMuteButton();

playerColumn.addEventListener('pointerenter', showPlaybackControls);
playerColumn.addEventListener('pointermove', showPlaybackControls);
playerColumn.addEventListener('pointerleave', hidePlaybackControls);
playerColumn.addEventListener('focusin', showPlaybackControls);
playerColumn.addEventListener('focusout', (event) => {
  if (!playerColumn.contains(event.relatedTarget)) hidePlaybackControls();
});

new ResizeObserver(queueMpvViewportUpdate).observe(playerFrame);
window.addEventListener('resize', queueMpvViewportUpdate);

function showPlaybackControls() {
  if (document.body.dataset.mode !== 'theater') return;
  playerColumn.classList.add('controls-visible');
  clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(hidePlaybackControls, 3000);
}

function hidePlaybackControls() {
  clearTimeout(controlsHideTimer);
  playerColumn.classList.remove('controls-visible');
}