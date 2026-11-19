const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { existsSync, readdirSync, unlinkSync } = require('node:fs');
const { unlink, writeFile } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function resolveMpvExecutable() {
  const winGetPackages = process.env.LOCALAPPDATA && path.join(
    process.env.LOCALAPPDATA,
    'Microsoft',
    'WinGet',
    'Packages',
  );
  let winGetMpvExecutables = [];
  if (winGetPackages && existsSync(winGetPackages)) {
    try {
      winGetMpvExecutables = readdirSync(winGetPackages, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes('mpv'))
        .map((entry) => path.join(winGetPackages, entry.name, 'mpv.exe'));
    } catch {
      winGetMpvExecutables = [];
    }
  }

  const candidates = [
    process.env.MPV_PATH,
    process.resourcesPath && path.join(process.resourcesPath, 'mpv', process.platform === 'win32' ? 'mpv.exe' : 'mpv'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'mpv.exe'),
    ...winGetMpvExecutables,
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? 'mpv';
}

class MpvBridge extends EventEmitter {
  constructor({ executable = resolveMpvExecutable(), showWindow = true, windowId = null } = {}) {
    super();
    this.executable = executable;
    this.showWindow = showWindow;
    this.windowId = windowId;
    this.ipcPath = process.platform === 'win32'
      ? String.raw`\\.\pipe\syncwatch-mpv-${process.pid}-${randomUUID()}`
      : path.join(os.tmpdir(), `syncwatch-mpv-${process.pid}-${randomUUID()}.sock`);
    this.child = null;
    this.socket = null;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.nextOverlayId = 0;
    this.reactionTimers = new Map();
  }

  async start() {
    if (this.socket?.writable) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    if (process.platform !== 'win32' && existsSync(this.ipcPath)) {
      unlinkSync(this.ipcPath);
    }

    const args = [
      '--idle=yes',
      '--keep-open=yes',
      '--osc=no',
      '--media-controls=no',
      '--input-cursor-passthrough=yes',
      `--force-window=${this.showWindow || this.windowId ? 'yes' : 'no'}`,
      ...(this.windowId ? ['--input-vo-keyboard=no', `--wid=${this.windowId}`] : []),
      `--input-ipc-server=${this.ipcPath}`,
      '--title=SyncWatch',
    ];
    this.child = spawn(this.executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr?.on('data', (data) => this.emit('log', data.toString().trim()));
    this.child.on('error', (error) => this.emit('process-error', error));
    this.child.on('exit', (code, signal) => {
      this.clearReactionTimers();
      this.socket?.destroy();
      this.socket = null;
      this.rejectPending(new Error(`mpv exited (${signal ?? code ?? 'unknown'}).`));
      this.emit('exit', { code, signal });
    });

    await this.connectIpc();
    const properties = ['time-pos', 'duration', 'pause', 'speed', 'volume', 'mute', 'track-list', 'video-params'];
    await Promise.all(properties.map((property, index) => (
      this.command(['observe_property', index + 1, property]).catch(() => undefined)
    )));
    this.emit('ready');
  }

  connectIpc() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Timed out connecting to mpv IPC.')), 10000);
      const finish = (error, socket) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          socket?.destroy();
          this.child?.kill();
          reject(error);
          return;
        }

        this.socket = socket;
        this.attachSocket(socket);
        resolve();
      };

      const attempt = () => {
        if (settled) return;
        if (!this.child || this.child.exitCode !== null) {
          finish(new Error('mpv exited before its IPC socket became available.'));
          return;
        }
        const socket = net.createConnection(this.ipcPath);
        socket.once('connect', () => finish(null, socket));
        socket.once('error', () => {
          socket.destroy();
          if (Date.now() >= deadline) {
            finish(new Error('Could not connect to the mpv IPC socket.'));
          } else {
            setTimeout(attempt, 50);
          }
        });
      };

      this.child?.once('error', (error) => finish(error));

      attempt();
    });
  }

  attachSocket(socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        this.handleMessage(line);
        newlineIndex = this.buffer.indexOf('\n');
      }
    });
    socket.on('error', (error) => {
      this.emit('error', error);
      this.rejectPending(error);
    });
  }

  handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (Number.isInteger(message.request_id)) {
      const pending = this.pending.get(message.request_id);
      if (!pending) return;
      this.pending.delete(message.request_id);
      clearTimeout(pending.timeout);
      if (message.error !== 'success') {
        pending.reject(new Error(`mpv command failed: ${message.error}`));
      } else {
        pending.resolve(message.data);
      }
      return;
    }

    if (message.event === 'property-change') {
      this.emit('property-change', { name: message.name, value: message.data });
    } else if (message.event === 'file-loaded') {
      this.emit('file-loaded');
    } else if (message.event === 'end-file') {
      this.emit('end-file', message.reason);
    }
  }

  command(command) {
    if (!this.socket?.writable) {
      return Promise.reject(new Error('mpv is not connected.'));
    }

    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('mpv did not respond to a command.'));
      }, 5000);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  getProperty(name) {
    return this.command(['get_property', name]);
  }

  setProperty(name, value) {
    return this.command(['set_property', name, value]);
  }

  loadFile(filePath) {
    return this.command(['loadfile', filePath, 'replace']);
  }

  async showReactionBitmap({ width, height, pixels }) {
    if (width !== 128 || height !== 128 || !(pixels instanceof Uint8Array) || pixels.byteLength !== width * height * 4) {
      throw new Error('Invalid reaction bitmap.');
    }

    const [rawWidth, rawHeight] = await Promise.all([this.getProperty('osd-width'), this.getProperty('osd-height')]);
    const osdWidth = Number(rawWidth) > 0 ? Math.round(Number(rawWidth)) : 1280;
    const osdHeight = Number(rawHeight) > 0 ? Math.round(Number(rawHeight)) : 720;
    const lanes = [0.12, 0.24, 0.38, 0.51, 0.64, 0.76, 0.87];
    const x = Math.round(osdWidth * lanes[Math.floor(Math.random() * lanes.length)]);
    const displaySize = Math.round(osdHeight * 0.08);
    const startY = Math.round(osdHeight * 0.83 - (displaySize * 0.5));
    const rise = Math.round(osdHeight * 0.46);
    const id = this.nextOverlayId;
    this.nextOverlayId = (this.nextOverlayId + 1) % 64;
    const imagePath = path.join(os.tmpdir(), `syncwatch-reaction-${process.pid}-${id}.bgra`);
    const startedAt = Date.now();
    const duration = 2400;
    await writeFile(imagePath, Buffer.from(pixels));

    const removeOverlay = async () => {
      this.reactionTimers.delete(id);
      await this.command(['overlay-remove', id]).catch(() => {});
      await unlink(imagePath).catch(() => {});
    };
    const drawFrame = (progress) => {
      const eased = 1 - ((1 - progress) ** 3);
      const y = Math.round(startY - (rise * eased));
      const size = Math.max(1, Math.round(displaySize * (0.75 + (0.45 * eased))));
      const fadeIn = Math.min(1, progress / 0.12);
      const fadeOut = progress < 0.72 ? 1 : Math.max(0, (1 - progress) / 0.28);
      const alpha = Math.min(fadeIn, fadeOut);
      return this.command(['overlay-add', id, x, y, imagePath, 0, 'bgra', width, height, width * 4,
        Math.max(1, Math.round(size * alpha)), Math.max(1, Math.round(size * alpha))]);
    };

    const animate = async () => {
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      if (progress >= 1) {
        await removeOverlay();
        return;
      }

      await drawFrame(progress);
      const timer = setTimeout(() => {
        animate().catch(() => removeOverlay());
      }, 50);
      this.reactionTimers.set(id, { timer, imagePath });
    };

    try {
      await animate();
    } catch (error) {
      await unlink(imagePath).catch(() => {});
      throw error;
    }
  }

  seek(seconds) {
    return this.command(['seek', seconds, 'absolute+exact']);
  }

  addSubtitle(filePath) {
    return this.command(['sub-add', filePath, 'select']);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  clearReactionTimers() {
    for (const { timer, imagePath } of this.reactionTimers.values()) {
      clearTimeout(timer);
      unlink(imagePath).catch(() => {});
    }
    this.reactionTimers.clear();
  }

  async stop() {
    if (!this.child) return;
    this.clearReactionTimers();
    const child = this.child;
    try {
      await this.command(['quit']);
    } catch {
      child.kill();
    }
    this.socket?.destroy();
    this.socket = null;
    this.child = null;
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      if (child.exitCode === null) child.kill();
    }
  }
}

module.exports = { MpvBridge, resolveMpvExecutable };