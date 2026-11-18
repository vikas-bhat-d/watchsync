const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { MpvBridge, resolveMpvExecutable } = require('./mpv-bridge');
const GW_CHILD = 5;
const mpvExecutable = resolveMpvExecutable();
const testVideoPath = process.env.SYNCWATCH_TEST_VIDEO;

test('creates and positions a native child video surface on Windows', {
  skip: process.platform !== 'win32',
}, () => {
  const { Win32VideoHost, getDesktopWindow } = require('./win32-video-host');
  const parent = new Win32VideoHost(getDesktopWindow());
  const host = new Win32VideoHost(parent.handle);
  const sibling = new Win32VideoHost(parent.handle);
  try {
    assert.ok(host.mpvWindowId > 0);
    host.setBounds({ x: 0, y: 0, width: 32, height: 24, visible: false });
    assert.equal(host.api.getWindow(parent.handle, GW_CHILD), host.handle);
    assert.equal(host.findChildWindowForProcess(0xffffffff), null);
  } finally {
    sibling.destroy();
    host.destroy();
    parent.destroy();
  }
});

test('mpv attaches its video window to the child surface instead of creating a top-level window', {
  skip: process.platform !== 'win32' || !require('node:fs').existsSync(mpvExecutable),
  timeout: 15000,
}, async (t) => {
  const { Win32VideoHost, findTopLevelWindowForProcess, getDesktopWindow } = require('./win32-video-host');
  const host = new Win32VideoHost(getDesktopWindow());
  host.setBounds({ x: 0, y: 0, width: 64, height: 48, visible: false });
  const mpv = new MpvBridge({ executable: mpvExecutable, showWindow: false, windowId: host.mpvWindowId });
  mpv.on('error', () => {});
  t.after(async () => {
    await mpv.stop();
    host.destroy();
  });

  await mpv.start();
  let attachedWindow = null;
  const deadline = Date.now() + 2000;
  while (!attachedWindow && Date.now() < deadline) {
    attachedWindow = host.findChildWindowForProcess(mpv.child.pid);
    if (!attachedWindow) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(attachedWindow, 'mpv should create its video output as a child of the player surface');
  assert.equal(findTopLevelWindowForProcess(mpv.child.pid), null, 'mpv should not create a second top-level window');
});

test('loads video and audio tracks inside the embedded surface', {
  skip: process.platform !== 'win32' ||
    !require('node:fs').existsSync(mpvExecutable) ||
    !testVideoPath || !require('node:fs').existsSync(testVideoPath),
  timeout: 20000,
}, async (t) => {
  const { Win32VideoHost, findTopLevelWindowForProcess, getDesktopWindow } = require('./win32-video-host');
  const host = new Win32VideoHost(getDesktopWindow());
  host.setBounds({ x: 16, y: 16, width: 640, height: 360, visible: true });
  const mpv = new MpvBridge({ executable: mpvExecutable, showWindow: false, windowId: host.mpvWindowId });
  mpv.on('error', () => {});
  t.after(async () => {
    await mpv.stop();
    host.destroy();
  });

  await mpv.start();
  const fileLoaded = once(mpv, 'file-loaded');
  await mpv.loadFile(testVideoPath);
  await Promise.race([
    fileLoaded,
    new Promise((_, reject) => setTimeout(() => reject(new Error('mpv did not load the test video')), 10000)),
  ]);

  const tracks = await mpv.getProperty('track-list');
  assert.ok(tracks.some((track) => track.type === 'video'));
  assert.ok(tracks.some((track) => track.type === 'audio'));
  assert.equal(findTopLevelWindowForProcess(mpv.child.pid), null, 'playing mpv should remain embedded');
});