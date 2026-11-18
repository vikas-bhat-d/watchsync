const assert = require('node:assert/strict');
const test = require('node:test');
const { getSignalingServerUrl } = require('./config');

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