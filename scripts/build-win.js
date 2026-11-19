'use strict';

const { spawnSync } = require('node:child_process');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const stagingDirectory = path.join(projectRoot, 'dist', 'mpv-runtime');

function findMpvExecutable() {
  const pathCandidates = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((directory) => path.join(directory, 'mpv.exe'));
  const winGetPackages = process.env.LOCALAPPDATA && path.join(
    process.env.LOCALAPPDATA,
    'Microsoft',
    'WinGet',
    'Packages',
  );
  let winGetCandidates = [];

  if (winGetPackages && existsSync(winGetPackages)) {
    winGetCandidates = readdirSync(winGetPackages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes('mpv'))
      .map((entry) => path.join(winGetPackages, entry.name, 'mpv.exe'));
  }

  return [process.env.MPV_PATH, ...pathCandidates, ...winGetCandidates]
    .filter((candidate) => candidate && existsSync(candidate) && statSync(candidate).isFile())
    .find((candidate) => path.basename(candidate).toLowerCase().endsWith('.exe'));
}

if (process.platform !== 'win32') {
  console.error('The configured Windows installer must be built on Windows.');
  process.exit(1);
}

const mpvExecutable = findMpvExecutable();
if (!mpvExecutable) {
  console.error('mpv.exe was not found. Install a Windows x64 mpv build or set MPV_PATH before building.');
  process.exit(1);
}

rmSync(stagingDirectory, { recursive: true, force: true });
mkdirSync(stagingDirectory, { recursive: true });
copyFileSync(mpvExecutable, path.join(stagingDirectory, 'mpv.exe'));

for (const entry of readdirSync(path.dirname(mpvExecutable), { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(?:com|dll)$/i.test(entry.name)) continue;
  copyFileSync(
    path.join(path.dirname(mpvExecutable), entry.name),
    path.join(stagingDirectory, entry.name),
  );
}

const buildId = `${Date.now()}-${process.pid}`;
const outputDirectory = path.join('dist', `win-build-${buildId}`);
const electronBuilderCli = require.resolve('electron-builder/cli.js');

console.log(`Bundling mpv from ${mpvExecutable}`);
console.log(`Building installer into ${outputDirectory}`);

const result = spawnSync(process.execPath, [
  electronBuilderCli,
  '--win',
  'nsis',
  '--x64',
  `--config.directories.output=${outputDirectory}`,
], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error('Could not start electron-builder:', result.error.message);
  process.exitCode = 1;
} else if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  console.log(`Installer created under ${outputDirectory}`);
}