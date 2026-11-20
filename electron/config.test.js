const assert = require('node:assert/strict');
const test = require('node:test');
const { getSignalingServerUrl, resolveSignalingServerUrl } = require('./config');

test('reads the server URL from separate command-line arguments', () => {
  assert.equal(
    getSignalingServerUrl(['SyncWatch.exe', '--server-url', 'https://watch.example.com'], {}),
    'https://watch.example.com/',
  );
});

test('reads the server URL from an equals-form argument', () => {
  assert.equal(
    getSignalingServerUrl(['SyncWatch.exe', '--server-url=http://192.168.1.20:3000'], {}),
    'http://192.168.1.20:3000/',
  );
});

test('command-line URL takes precedence over the environment variable', () => {
  assert.equal(
    getSignalingServerUrl(
      ['SyncWatch.exe', '--server-url', 'https://shortcut.example.com'],
      { SYNCWATCH_SERVER_URL: 'https://environment.example.com' },
    ),
    'https://shortcut.example.com/',
  );
});

test('uses the environment variable when no command-line URL is supplied', () => {
  assert.equal(
    getSignalingServerUrl(['SyncWatch.exe'], { SYNCWATCH_SERVER_URL: 'http://localhost:3000' }),
    'http://localhost:3000/',
  );
});

test('rejects a missing or invalid command-line URL', () => {
  assert.throws(
    () => getSignalingServerUrl(['SyncWatch.exe', '--server-url'], {}),
    /Provide a URL after --server-url/,
  );
  assert.throws(
    () => getSignalingServerUrl(['SyncWatch.exe', '--server-url', 'file:///tmp/server'], {}),
    /valid HTTP or HTTPS URL/,
  );
});

test('command-line URL takes priority over the remote server file', async () => {
  let fetchCalled = false;
  const result = await resolveSignalingServerUrl({
    argv: ['SyncWatch.exe', '--server-url=https://cli.example.com'],
    env: { SYNCWATCH_SERVER_URL: 'https://environment.example.com' },
    fetchImpl: async () => {
      fetchCalled = true;
      return { ok: true, text: async () => 'https://remote.example.com' };
    },
  });

  assert.equal(result, 'https://cli.example.com/');
  assert.equal(fetchCalled, false);
});

test('uses the remote server file before the environment fallback', async () => {
  const result = await resolveSignalingServerUrl({
    argv: ['SyncWatch.exe'],
    env: { SYNCWATCH_SERVER_URL: 'https://environment.example.com' },
    fetchImpl: async () => ({ ok: true, text: async () => 'https://remote.example.com\n' }),
  });

  assert.equal(result, 'https://remote.example.com/');
});

test('falls back to existing environment or local-server behavior if remote config is unavailable', async () => {
  const envResult = await resolveSignalingServerUrl({
    argv: ['SyncWatch.exe'],
    env: { SYNCWATCH_SERVER_URL: 'https://environment.example.com' },
    fetchImpl: async () => ({ ok: false, text: async () => '' }),
  });
  const localResult = await resolveSignalingServerUrl({
    argv: ['SyncWatch.exe'],
    env: {},
    fetchImpl: async () => { throw new Error('offline'); },
  });

  assert.equal(envResult, 'https://environment.example.com/');
  assert.equal(localResult, null);
});

test('reports a missing remote server file while preserving local-server fallback', async () => {
  let fetchError;
  const result = await resolveSignalingServerUrl({
    argv: ['SyncWatch.exe'],
    env: {},
    fetchImpl: async () => ({ ok: false, status: 404 }),
    onRemoteConfigError: (error) => { fetchError = error; },
  });

  assert.equal(result, null);
  assert.match(fetchError.message, /HTTP 404/);
});