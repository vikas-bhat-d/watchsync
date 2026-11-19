const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createUserPreferences } = require('./user-preferences');

test('persists username and reuses the most recently opened folder', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncwatch-preferences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const downloadsPath = path.join(root, 'Downloads');
  const moviesPath = path.join(root, 'Movies');
  await Promise.all([mkdir(downloadsPath), mkdir(moviesPath)]);

  const preferences = createUserPreferences(userDataPath, downloadsPath);
  assert.equal((await preferences.load()).username, '');
  assert.equal(await preferences.getDialogDefaultPath(), downloadsPath);

  await preferences.saveUsername('  temp user  ');
  await preferences.rememberOpenedFile(path.join(moviesPath, 'movie.mkv'));

  const reloaded = createUserPreferences(userDataPath, downloadsPath);
  assert.equal((await reloaded.load()).username, 'temp user');
  assert.equal(await reloaded.getDialogDefaultPath(), moviesPath);
});

test('falls back to Downloads when the remembered directory is unavailable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncwatch-preferences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const downloadsPath = path.join(root, 'Downloads');
  const oldFolder = path.join(root, 'Old folder');
  await Promise.all([mkdir(downloadsPath), mkdir(oldFolder)]);

  const preferences = createUserPreferences(userDataPath, downloadsPath);
  await preferences.rememberOpenedFile(path.join(oldFolder, 'movie.mkv'));
  await rm(oldFolder, { recursive: true });

  assert.equal(await preferences.getDialogDefaultPath(), downloadsPath);
});

test('stores independent playback positions for each local video', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncwatch-preferences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const firstVideo = path.join(root, 'first.mkv');
  const secondVideo = path.join(root, 'second.mp4');
  const preferences = createUserPreferences(userDataPath, root);

  await preferences.saveVideoPosition(firstVideo, 83.25);
  await preferences.saveVideoPosition(secondVideo, 12.5);

  const reloaded = createUserPreferences(userDataPath, root);
  assert.equal(await reloaded.getVideoPosition(firstVideo), 83.25);
  assert.equal(await reloaded.getVideoPosition(secondVideo), 12.5);
  assert.equal(await reloaded.getVideoPosition(path.join(root, 'missing.mkv')), null);
});