const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

const MAX_ROOM_SIZE = 4;
const MAX_MESSAGE_LENGTH = 500;
const DEFAULT_DRIFT_TOLERANCE = 3;
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

function writeLog(logger, level, event, details = {}) {
  const write = logger?.[level];
  if (typeof write !== 'function') return;
  write.call(logger, JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
  }));
}

function createSignalingServer({ host = '127.0.0.1', port = 3000, corsOrigin = '*', logger = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e6,
  });
  const rooms = new Map();

  io.engine.on('connection_error', (error) => {
    writeLog(logger, 'warn', 'transport.connection_error', {
      code: error.code,
      message: error.message,
      transport: error.context?.transport?.name ?? null,
    });
  });

  function leaveRoom(socket, reason = 'leave') {
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
    writeLog(logger, 'info', 'room.member_left', {
      socketId: socket.id,
      roomRef: room.logId.slice(0, 8),
      reason,
      memberCount: room.members.size,
    });

    if (room.hostId === socket.id) {
      room.hostId = room.members.keys().next().value ?? null;
      io.to(roomId).emit('host-changed', { hostId: room.hostId });
      writeLog(logger, 'info', 'room.host_changed', {
        roomRef: room.logId.slice(0, 8),
        hasHost: room.hostId !== null,
      });
    }

    if (room.members.size === 0) {
      rooms.delete(roomId);
    }
  }

  function relayToRoomMember(socket, event, payload, field) {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const targetId = payload?.to;
    if (!room) {
      return;
    }
    if (typeof targetId !== 'string' || !room.members.has(targetId)) {
      writeLog(logger, 'warn', 'webrtc.relay_rejected', {
        socketId: socket.id,
        roomRef: room.logId.slice(0, 8),
        event,
      });
      return;
    }

    io.to(targetId).emit(event, { from: socket.id, [field]: payload[field] });
    writeLog(logger, 'info', 'webrtc.relayed', {
      socketId: socket.id,
      roomRef: room.logId.slice(0, 8),
      event,
    });
  }

  io.on('connection', (socket) => {
    socket.data.roomId = null;
    writeLog(logger, 'info', 'client.connected', {
      socketId: socket.id,
      transport: socket.conn.transport.name,
    });
    socket.on('error', (error) => {
      writeLog(logger, 'error', 'client.error', {
        socketId: socket.id,
        message: error.message,
      });
    });

    socket.on('join-room', (payload, acknowledge = () => {}) => {
      const roomId = normalizeRoomId(payload?.roomId);
      const username = normalizeText(payload?.username, 24);
      if (!roomId || !username) {
        writeLog(logger, 'warn', 'room.join_rejected', {
          socketId: socket.id,
          reason: 'invalid_room_or_username',
        });
        acknowledge({ ok: false, error: 'Enter a valid room code and display name.' });
        return;
      }

      leaveRoom(socket, 'switch_room');
      let room = rooms.get(roomId);
      if (room && room.members.size >= MAX_ROOM_SIZE) {
        writeLog(logger, 'warn', 'room.join_rejected', {
          socketId: socket.id,
          roomRef: room.logId.slice(0, 8),
          reason: 'room_full',
          memberCount: room.members.size,
        });
        acknowledge({ ok: false, error: `Rooms are limited to ${MAX_ROOM_SIZE} people.` });
        return;
      }

      if (!room) {
        room = {
          logId: randomUUID(),
          hostId: null,
          members: new Map(),
          playbackState: null,
          driftTolerance: DEFAULT_DRIFT_TOLERANCE,
        };
        rooms.set(roomId, room);
      }

      const peers = [...room.members].map(([id, member]) => ({ id, username: member.username }));
      room.members.set(socket.id, { username });
      room.hostId ??= socket.id;
      socket.data.roomId = roomId;
      socket.data.username = username;
      socket.join(roomId);
      writeLog(logger, 'info', 'room.member_joined', {
        socketId: socket.id,
        roomRef: room.logId.slice(0, 8),
        isHost: room.hostId === socket.id,
        memberCount: room.members.size,
      });

      acknowledge({
        ok: true,
        roomId,
        username,
        hostId: room.hostId,
        isHost: room.hostId === socket.id,
        peers,
        playbackState: room.playbackState,
        settings: { driftTolerance: room.driftTolerance },
      });
      socket.to(roomId).emit('peer-joined', { id: socket.id, username });
    });

    socket.on('leave-room', (_payload, acknowledge = () => {}) => {
      leaveRoom(socket, 'leave_room');
      acknowledge({ ok: true });
    });

    socket.on('sync-event', ({ type, payload } = {}) => {
      const roomId = socket.data.roomId;
      const room = roomId && rooms.get(roomId);
      const isHostOnlyEvent = type === 'heartbeat' || type === 'force-sync';
      if (
        !room || !room.members.has(socket.id) || !SYNC_TYPES.has(type) ||
        (isHostOnlyEvent && room.hostId !== socket.id)
      ) {
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

      if (type !== 'heartbeat') {
        writeLog(logger, 'info', 'room.playback_event', {
          socketId: socket.id,
          roomRef: room.logId.slice(0, 8),
          type,
        });
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

      writeLog(logger, 'info', 'room.sync_requested', {
        socketId: socket.id,
        roomRef: room.logId.slice(0, 8),
      });
      io.to(room.hostId).emit('sync-request', {
        from: socket.id,
        username: socket.data.username,
      });
    });

    socket.on('sync-settings', (payload = {}) => {
      const roomId = socket.data.roomId;
      const room = roomId && rooms.get(roomId);
      const driftTolerance = Number(payload.driftTolerance);
      if (
        !room || room.hostId !== socket.id ||
        !Number.isFinite(driftTolerance) || driftTolerance < 0.2 || driftTolerance > 5
      ) {
        return;
      }

      room.driftTolerance = Math.round(driftTolerance * 10) / 10;
      writeLog(logger, 'info', 'room.sync_settings_changed', {
        socketId: socket.id,
        roomRef: room.logId.slice(0, 8),
        driftTolerance: room.driftTolerance,
      });
      io.to(roomId).emit('sync-settings', {
        driftTolerance: room.driftTolerance,
        from: socket.id,
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
      writeLog(logger, 'info', 'room.chat_message', {
        socketId: socket.id,
        roomRef: rooms.get(roomId)?.logId.slice(0, 8),
        characters: text.length,
      });
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
      writeLog(logger, 'info', 'room.reaction', {
        socketId: socket.id,
        roomRef: rooms.get(roomId)?.logId.slice(0, 8),
      });
      io.to(roomId).emit('reaction', { emoji, senderId: socket.id, ts: now });
    });

    socket.on('webrtc-offer', (payload) => relayToRoomMember(socket, 'webrtc-offer', payload, 'description'));
    socket.on('webrtc-answer', (payload) => relayToRoomMember(socket, 'webrtc-answer', payload, 'description'));
    socket.on('webrtc-ice', (payload) => relayToRoomMember(socket, 'webrtc-ice', payload, 'candidate'));
    socket.on('disconnect', (reason) => {
      writeLog(logger, 'info', 'client.disconnected', { socketId: socket.id, reason });
      leaveRoom(socket, 'disconnect');
    });
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