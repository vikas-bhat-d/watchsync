const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const test = require('node:test');
const { MpvBridge, resolveMpvExecutable } = require('./mpv-bridge');

const mpvPath = resolveMpvExecutable();

test('mpv bridge sends and receives JSON IPC property commands', {
  skip: !existsSync(mpvPath),
  timeout: 15000,
}, async (t) => {
  const mpv = new MpvBridge({ executable: mpvPath, showWindow: false });
  mpv.on('error', () => {});
  t.after(() => mpv.stop());

  await mpv.start();
  await mpv.setProperty('volume', 37);
  assert.equal(await mpv.getProperty('volume'), 37);
  assert.deepEqual(await mpv.getProperty('track-list'), []);
});