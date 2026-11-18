const { createServer } = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const MAX_ROOM_SIZE = 4;
const MAX_MESSAGE_LENGTH = 500;
const REACTIONS = new Set(['❤️', '😂', '👏', '😮', '🔥', '😭', '🎉']);
const SYNC_TYPES = new Set(['play', 'pause', 'seek', 'speed', 'heartbeat', 'force-sync']);

function normalizeText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeRoomId(value) {
  const roomId = normalizeText(value, 32).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,31}$/.test(roomId) ? roomId : null;
}

function normalizePlayback(type, value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (type === 'seek') {
    return Number.isFinite(value.seconds) && value.seconds >= 0
      ? { seconds: value.seconds }
      : null;
  }

  if (type === 'speed') {
    return Number.isFinite(value.speed) && value.speed >= 0.25 && value.speed <= 3
      ? { speed: value.speed }
      : null;
  }

  if (type === 'heartbeat' || type === 'force-sync') {
    if (
      !Number.isFinite(value.seconds) || value.seconds < 0 ||
      typeof value.playing !== 'boolean' ||
      !Number.isFinite(value.speed) || value.speed < 0.25 || value.speed > 3
    ) {
      return null;
    }

    return {
      seconds: value.seconds,
      playing: value.playing,
      speed: value.speed,
    };
  }

  return {};
}

function createSignalingServer({ host = '127.0.0.1', port = 3000, corsOrigin = '*' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e6,
  });
  const rooms = new Map();

  function leaveRoom(socket) {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room) {
      socket.data.roomId = null;
      return;
    }

    const member = room.members.get(socket.id);
    room.members.delete(socket.id);
    socket.leave(roomId);
    socket.data.roomId = null;
    io.to(roomId).emit('peer-left', { id: socket.id, username: member?.username ?? 'Guest' });

    if (room.hostId === socket.id) {
      room.hostId = room.members.keys().next().value ?? null;
      io.to(roomId).emit('host-changed', { hostId: room.hostId });
    }

    if (room.members.size === 0) {
      rooms.delete(roomId);
    }
  }

  function relayToRoomMember(socket, event, payload, field) {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const targetId = payload?.to;
    if (!room || typeof targetId !== 'string' || !room.members.has(targetId)) {
      return;
    }

    io.to(targetId).emit(event, { from: socket.id, [field]: payload[field] });
  }

  io.on('connection', (socket) => {
    socket.data.roomId = null;

    socket.on('join-room', (payload, acknowledge = () => {}) => {
      const roomId = normalizeRoomId(payload?.roomId);
      const username = normalizeText(payload?.username, 24);
      if (!roomId || !username) {
        acknowledge({ ok: false, error: 'Enter a valid room code and display name.' });
        return;
      }

      leaveRoom(socket);
      let room = rooms.get(roomId);
      if (room && room.members.size >= MAX_ROOM_SIZE) {
        acknowledge({ ok: false, error: `Rooms are limited to ${MAX_ROOM_SIZE} people.` });
        return;
      }

      if (!room) {
        room = { hostId: null, members: new Map(), playbackState: null };
        rooms.set(roomId, room);
      }

      const peers = [...room.members].map(([id, member]) => ({ id, username: member.username }));
      room.members.set(socket.id, { username });
      room.hostId ??= socket.id;
      socket.data.roomId = roomId;
      socket.data.username = username;
      socket.join(roomId);

      acknowledge({
        ok: true,
        roomId,
        username,
        hostId: room.hostId,
        isHost: room.hostId === socket.id,
        peers,
        playbackState: room.playbackState,
      });
      socket.to(roomId).emit('peer-joined', { id: socket.id, username });
    });

    socket.on('leave-room', (_payload, acknowledge = () => {}) => {
      leaveRoom(socket);
      acknowledge({ ok: true });
    });

    socket.on('sync-event', ({ type, payload } = {}) => {
      const roomId = socket.data.roomId;
      const room = roomId && rooms.get(roomId);
      if (!room || room.hostId !== socket.id || !SYNC_TYPES.has(type)) {
        return;
      }

      const normalizedPayload = normalizePlayback(type, payload);
      if (!normalizedPayload) {
        return;
      }

      if (type === 'heartbeat' || type === 'force-sync') {
        room.playbackState = normalizedPayload;
      } else {
        room.playbackState = {
          ...(room.playbackState ?? { seconds: 0, playing: false, speed: 1 }),
          ...(type === 'play' ? { playing: true } : {}),
          ...(type === 'pause' ? { playing: false } : {}),
          ...normalizedPayload,
        };
      }

      socket.to(roomId).emit('sync-event', {
        type,
        payload: normalizedPayload,
        from: socket.id,
        serverTime: Date.now(),
      });
    });

    socket.on('request-sync', () => {
      const roomId = socket.data.roomId;
      const room = roomId && rooms.get(roomId);
      if (!room || room.hostId === socket.id) {
        return;
      }

      io.to(room.hostId).emit('sync-request', {
        from: socket.id,
        username: socket.data.username,
      });
    });

    socket.on('chat-message', (payload) => {
      const roomId = socket.data.roomId;
      const text = normalizeText(payload?.text, MAX_MESSAGE_LENGTH);
      const now = Date.now();
      if (!roomId || !text || now - (socket.data.lastChatAt ?? 0) < 300) {
        return;
      }

      socket.data.lastChatAt = now;
      io.to(roomId).emit('chat-message', {
        id: `${socket.id}-${now}`,
        senderId: socket.id,
        username: socket.data.username,
        text,
        ts: now,
      });
    });

    socket.on('reaction', (payload) => {
      const roomId = socket.data.roomId;
      const emoji = payload?.emoji;
      const now = Date.now();
      if (!roomId || !REACTIONS.has(emoji) || now - (socket.data.lastReactionAt ?? 0) < 500) {
        return;
      }

      socket.data.lastReactionAt = now;
      io.to(roomId).emit('reaction', { emoji, senderId: socket.id, ts: now });
    });

    socket.on('webrtc-offer', (payload) => relayToRoomMember(socket, 'webrtc-offer', payload, 'description'));
    socket.on('webrtc-answer', (payload) => relayToRoomMember(socket, 'webrtc-answer', payload, 'description'));
    socket.on('webrtc-ice', (payload) => relayToRoomMember(socket, 'webrtc-ice', payload, 'candidate'));
    socket.on('disconnect', () => leaveRoom(socket));
  });

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        resolve(httpServer.address());
      };

      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(port, host);
    });
  }

  function close() {
    return new Promise((resolve) => {
      if (!httpServer.listening) {
        resolve();
        return;
      }
      io.close(resolve);
    });
  }

  return { app, httpServer, io, listen, close, rooms };
}

module.exports = { createSignalingServer };