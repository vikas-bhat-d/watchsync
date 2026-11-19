const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { createSignalingServer } = require('./signaling');

async function setup(t) {
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [
    level,
    (line) => logs.push(JSON.parse(line)),
  ]));
  const server = createSignalingServer({ host: '127.0.0.1', port: 0, logger });
  const address = await server.listen();
  const clients = [];
  t.after(async () => {
    clients.forEach((client) => client.disconnect());
    await server.close();
  });

  return {
    server,
    clients,
    logs,
    connect: async () => {
      const client = createClient(`http://127.0.0.1:${address.port}`, {
        transports: ['websocket'],
        reconnection: false,
      });
      clients.push(client);
      await once(client, 'connect');
      return client;
    },
  };
}

function join(client, roomId, username) {
  return new Promise((resolve) => {
    client.emit('join-room', { roomId, username }, resolve);
  });
}

test('all members can control playback while heartbeat and force-sync remain host-only', async (t) => {
  const { connect, server, logs } = await setup(t);
  const host = await connect();
  const guest = await connect();

  const hostRoom = await join(host, 'movie-night-42', 'Host');
  const peerJoined = once(host, 'peer-joined');
  const guestRoom = await join(guest, 'movie-night-42', 'Guest');
  assert.equal(hostRoom.isHost, true);
  assert.equal(guestRoom.isHost, false);
  assert.equal((await peerJoined)[0].username, 'Guest');

  const speedEvent = once(guest, 'sync-event');
  host.emit('sync-event', { type: 'speed', payload: { speed: 1.5 } });
  assert.deepEqual((await speedEvent)[0].payload, { speed: 1.5 });

  const guestPlaybackEvent = once(host, 'sync-event');
  guest.emit('sync-event', { type: 'play', payload: {} });
  const [relayedEvent] = await guestPlaybackEvent;
  assert.equal(relayedEvent.type, 'play');
  assert.equal(relayedEvent.from, guest.id);
  assert.deepEqual(server.rooms.get('movie-night-42').playbackState, {
    seconds: 0,
    playing: true,
    speed: 1.5,
  });

  const seekRelay = once(host, 'sync-event');
  guest.emit('sync-event', { type: 'seek', payload: { seconds: 83 } });
  assert.deepEqual((await seekRelay)[0].payload, { seconds: 83 });

  const speedRelay = once(host, 'sync-event');
  guest.emit('sync-event', { type: 'speed', payload: { speed: 1.25 } });
  assert.deepEqual((await speedRelay)[0].payload, { speed: 1.25 });

  const pauseRelay = once(host, 'sync-event');
  guest.emit('sync-event', { type: 'pause', payload: {} });
  assert.equal((await pauseRelay)[0].type, 'pause');
  assert.deepEqual(server.rooms.get('movie-night-42').playbackState, {
    seconds: 83,
    playing: false,
    speed: 1.25,
  });

  guest.emit('sync-event', {
    type: 'heartbeat',
    payload: { seconds: 900, playing: true, speed: 3 },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(server.rooms.get('movie-night-42').playbackState.seconds, 83);
  const state = once(guest, 'sync-event');
  host.emit('sync-event', {
    type: 'heartbeat',
    payload: { seconds: 42, playing: true, speed: 1.5 },
  });
  assert.equal((await state)[0].type, 'heartbeat');
  assert.deepEqual(
    logs.filter((entry) => entry.event === 'room.heartbeat_received').map(({ socketId, seconds, playing, speed }) => (
      { socketId, seconds, playing, speed }
    )),
    [{ socketId: host.id, seconds: 42, playing: true, speed: 1.5 }],
  );
  assert.deepEqual(server.rooms.get('movie-night-42').playbackState, {
    seconds: 42,
    playing: true,
    speed: 1.5,
  });
});

test('a disconnected host can rejoin with a new socket and recover room playback state', async (t) => {
  const { connect } = await setup(t);
  const host = await connect();
  const guest = await connect();
  await join(host, 'resume-room', 'Host');
  await join(guest, 'resume-room', 'Guest');

  const playbackEvent = once(guest, 'sync-event');
  host.emit('sync-event', {
    type: 'heartbeat',
    payload: { seconds: 37, playing: true, speed: 1.25 },
  });
  await playbackEvent;

  const peerLeft = once(guest, 'peer-left');
  host.disconnect();
  await peerLeft;

  const reconnectedHost = await connect();
  assert.notEqual(reconnectedHost.id, host.id);
  const response = await join(reconnectedHost, 'resume-room', 'Host');
  assert.equal(response.ok, true);
  assert.equal(response.isHost, false);
  assert.equal(response.peers.length, 1);
  assert.deepEqual(response.playbackState, { seconds: 37, playing: true, speed: 1.25 });
});

test('chat messages are relayed with server-assigned identity and trimmed text', async (t) => {
  const { connect } = await setup(t);
  const host = await connect();
  const guest = await connect();
  await join(host, 'chat-room', 'Host');
  await join(guest, 'chat-room', 'Guest');

  const message = once(host, 'chat-message');
  guest.emit('chat-message', { username: 'Impostor', text: '  hello room  ' });
  const [data] = await message;
  assert.equal(data.username, 'Guest');
  assert.equal(data.text, 'hello room');
});

test('server logs useful room activity without room codes, usernames, or chat contents', async (t) => {
  const { connect, logs } = await setup(t);
  const client = await connect();
  await join(client, 'private-room-42', 'Private User');

  const chatReceived = once(client, 'chat-message');
  client.emit('chat-message', { text: 'do not write this to logs' });
  await chatReceived;

  await client.timeout(1000).emitWithAck('leave-room', null);

  const events = logs.map((entry) => entry.event);
  assert.ok(events.includes('client.connected'));
  assert.ok(events.includes('room.member_joined'));
  assert.ok(events.includes('room.chat_message'));
  assert.ok(events.includes('room.member_left'));
  assert.doesNotMatch(JSON.stringify(logs), /private-room-42|Private User|do not write this to logs/);
});

test('WebRTC signaling is relayed only to a room member', async (t) => {
  const { connect, server } = await setup(t);
  const host = await connect();
  const guest = await connect();
  await join(host, 'rtc-room', 'Host');
  await join(guest, 'rtc-room', 'Guest');

  const offer = once(guest, 'webrtc-offer');
  host.emit('webrtc-offer', { to: guest.id, description: { type: 'offer', sdp: 'test' } });
  assert.deepEqual((await offer)[0].description, { type: 'offer', sdp: 'test' });

  host.emit('webrtc-offer', { to: 'not-in-room', description: { type: 'offer' } });
  assert.equal(server.rooms.get('rtc-room').members.size, 2);
});

test('rooms enforce the four-person limit', async (t) => {
  const { connect } = await setup(t);
  const members = await Promise.all(Array.from({ length: 5 }, connect));
  const results = await Promise.all(members.map((client, index) => join(client, 'small-room', `Guest ${index}`)));
  assert.equal(results.filter((result) => result.ok).length, 4);
  assert.equal(results.at(-1).ok, false);
});

test('leaving acknowledges and transfers host to a remaining participant', async (t) => {
  const { connect } = await setup(t);
  const host = await connect();
  const guest = await connect();
  await join(host, 'handoff-room', 'Host');
  await join(guest, 'handoff-room', 'Guest');

  const hostChanged = once(guest, 'host-changed');
  const leaveResult = await host.timeout(1000).emitWithAck('leave-room', null);
  assert.deepEqual(leaveResult, { ok: true });
  assert.deepEqual((await hostChanged)[0], { hostId: guest.id });
});

test('host can configure room drift tolerance and guests cannot overwrite it', async (t) => {
  const { connect, server } = await setup(t);
  const host = await connect();
  const guest = await connect();
  await join(host, 'settings-room', 'Host');
  const guestRoom = await join(guest, 'settings-room', 'Guest');
  assert.equal(guestRoom.settings.driftTolerance, 3);

  const guestUpdate = once(guest, 'sync-settings');
  host.emit('sync-settings', { driftTolerance: 1.4 });
  assert.equal((await guestUpdate)[0].driftTolerance, 1.4);
  assert.equal(server.rooms.get('settings-room').driftTolerance, 1.4);

  guest.emit('sync-settings', { driftTolerance: 4.5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(server.rooms.get('settings-room').driftTolerance, 1.4);
});