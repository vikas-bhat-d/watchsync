const { mkdir, readFile, stat, writeFile } = require('node:fs/promises');
const path = require('node:path');

function createUserPreferences(userDataPath, downloadsPath) {
  const filePath = path.join(userDataPath, 'preferences.json');
  let preferences = { username: '', lastOpenedDirectory: '', videoPositions: {} };
  let loadPromise;
  let writeQueue = Promise.resolve();

  function load() {
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const stored = JSON.parse(await readFile(filePath, 'utf8'));
          if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            preferences = {
              username: typeof stored.username === 'string' ? stored.username.trim().slice(0, 24) : '',
              lastOpenedDirectory: typeof stored.lastOpenedDirectory === 'string' ? stored.lastOpenedDirectory : '',
              videoPositions: stored.videoPositions && typeof stored.videoPositions === 'object' && !Array.isArray(stored.videoPositions)
                ? Object.fromEntries(Object.entries(stored.videoPositions).filter(([, seconds]) => (
                  Number.isFinite(seconds) && seconds >= 0
                )))
                : {},
            };
          }
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        return { ...preferences };
      })();
    }
    return loadPromise;
  }

  function persist() {
    const snapshot = { ...preferences };
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await mkdir(userDataPath, { recursive: true });
      await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
    });
    return writeQueue;
  }

  async function saveUsername(username) {
    if (typeof username !== 'string') throw new TypeError('Display name must be text.');
    await load();
    preferences.username = username.trim().slice(0, 24);
    await persist();
    return preferences.username;
  }

  async function getDialogDefaultPath() {
    const { lastOpenedDirectory } = await load();
    for (const directory of [lastOpenedDirectory, downloadsPath]) {
      if (!directory) continue;
      try {
        if ((await stat(directory)).isDirectory()) return directory;
      } catch {
        // Fall back to the next existing directory.
      }
    }
    return userDataPath;
  }

  async function rememberOpenedFile(filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('Selected file path is invalid.');
    await load();
    preferences.lastOpenedDirectory = path.dirname(filePath);
    await persist();
  }

  function videoPositionKey(filePath) {
    const resolvedPath = path.resolve(filePath);
    return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  }

  async function getVideoPosition(filePath) {
    if (typeof filePath !== 'string' || !filePath) return null;
    await load();
    const seconds = preferences.videoPositions[videoPositionKey(filePath)];
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  async function saveVideoPosition(filePath, seconds) {
    if (typeof filePath !== 'string' || !filePath || !Number.isFinite(seconds) || seconds < 0) {
      throw new TypeError('Video path and playback position are required.');
    }
    await load();
    const key = videoPositionKey(filePath);
    delete preferences.videoPositions[key];
    preferences.videoPositions[key] = seconds;
    const oldestKeys = Object.keys(preferences.videoPositions).slice(0, -50);
    for (const oldestKey of oldestKeys) delete preferences.videoPositions[oldestKey];
    await persist();
  }

  return { load, saveUsername, getDialogDefaultPath, rememberOpenedFile, getVideoPosition, saveVideoPosition };
}

module.exports = { createUserPreferences };