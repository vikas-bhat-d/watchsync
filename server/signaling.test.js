const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { createSignalingServer } = require('./signaling');

async function setup(t) {
  const server = createSignalingServer({ host: '127.0.0.1', port: 0 });
  const address = await server.listen();
  const clients = [];
  t.after(async () => {
    clients.forEach((client) => client.disconnect());
    await server.close();
  });

  return {
    server,
    clients,
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

test('room host relays playback and speed, while guest sync commands are ignored', async (t) => {
  const { connect, server } = await setup(t);
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

  guest.emit('sync-event', { type: 'pause', payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(server.rooms.get('movie-night-42').playbackState, {
    seconds: 0,
    playing: false,
    speed: 1.5,
  });
  const state = once(guest, 'sync-event');
  host.emit('sync-event', {
    type: 'heartbeat',
    payload: { seconds: 42, playing: true, speed: 1.5 },
  });
  assert.equal((await state)[0].type, 'heartbeat');
  assert.deepEqual(server.rooms.get('movie-night-42').playbackState, {
    seconds: 42,
    playing: true,
    speed: 1.5,
  });
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