#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const LABEL = 'local.codex-sound-watcher';
const INSTALL_PATH = `${homedir()}/Library/LaunchAgents/${LABEL}.plist`;
const HERE = dirname(fileURLToPath(import.meta.url));
const WATCHER_PATH = resolve(HERE, 'CodexSoundWatcher.mjs');
const OUT_LOG = resolve(HERE, 'CodexSoundWatcher.out.log');
const ERR_LOG = resolve(HERE, 'CodexSoundWatcher.err.log');

function execFilePromise(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function plistXml(nodePath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${WATCHER_PATH}</string>
    <string>--watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>
  <key>WorkingDirectory</key>
  <string>${HERE}</string>
</dict>
</plist>
`;
}

function parseArgs(argv) {
  const args = {
    nodePath: process.execPath,
    uninstall: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--node') {
      args.nodePath = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--uninstall') {
      args.uninstall = true;
    }
  }
  return args;
}

async function bootoutIfLoaded(uid) {
  try {
    await execFilePromise('/bin/launchctl', ['bootout', `gui/${uid}`, INSTALL_PATH]);
  } catch {
    // Not loaded yet.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uid = process.getuid();

  if (args.uninstall) {
    await bootoutIfLoaded(uid);
    await fsPromises.rm(INSTALL_PATH, { force: true });
    console.log(`Uninstalled ${LABEL}`);
    return;
  }

  await fsPromises.mkdir(dirname(INSTALL_PATH), { recursive: true });
  await fsPromises.mkdir(HERE, { recursive: true });
  await fsPromises.writeFile(INSTALL_PATH, plistXml(args.nodePath), 'utf8');
  await bootoutIfLoaded(uid);
  await execFilePromise('/bin/launchctl', ['bootstrap', `gui/${uid}`, INSTALL_PATH]);
  await execFilePromise('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`]);
  console.log(`Installed and started ${LABEL}`);
  console.log(INSTALL_PATH);
}

main().catch((error) => {
  console.error(error.stderr || error.stack || error.message);
  process.exitCode = 1;
});
