const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { existsSync, readdirSync, unlinkSync } = require('node:fs');
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
  constructor({ executable = resolveMpvExecutable(), showWindow = true } = {}) {
    super();
    this.executable = executable;
    this.showWindow = showWindow;
    this.ipcPath = process.platform === 'win32'
      ? String.raw`\\.\pipe\syncwatch-mpv-${process.pid}-${randomUUID()}`
      : path.join(os.tmpdir(), `syncwatch-mpv-${process.pid}-${randomUUID()}.sock`);
    this.child = null;
    this.socket = null;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pending = new Map();
    this.startPromise = null;
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
      `--force-window=${this.showWindow ? 'yes' : 'no'}`,
      `--input-ipc-server=${this.ipcPath}`,
      '--title=SyncWatch',
    ];
    this.child = spawn(this.executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr?.on('data', (data) => this.emit('log', data.toString().trim()));
    this.child.on('error', (error) => this.emit('process-error', error));
    this.child.on('exit', (code, signal) => {
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

  async stop() {
    if (!this.child) return;
    try {
      await this.command(['quit']);
    } catch {
      this.child.kill();
    }
    this.socket?.destroy();
    this.socket = null;
    this.child = null;
  }
}

module.exports = { MpvBridge, resolveMpvExecutable };