const { accessSync, constants } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

function runtimeEnv(env = process.env, home = homedir()) {
  const paths = [
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ];
  return { ...env, PATH: [...new Set([...(env.PATH || '').split(path.delimiter), ...paths].filter(Boolean))].join(path.delimiter) };
}

function findExecutable(name, env, override) {
  const candidates = override ? [override] : env.PATH.split(path.delimiter).map(dir => path.join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return path.resolve(candidate);
    } catch {}
  }
  throw new Error(`找不到 ${name}。请先安装，或通过 OCEDIT_${name.toUpperCase()} 指定可执行文件路径。`);
}

function startBackend({ bun, sourceDir, opencode, token, env = runtimeEnv(), onExit = () => {}, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bun, ['run', path.join(sourceDir, 'server.ts')], {
      cwd: sourceDir,
      env: { ...env, OCEDIT_DESKTOP: '1', OCEDIT_PORT: '0', OCEDIT_TOKEN: token, OCEDIT_OPENCODE: opencode },
      // An isolated process group lets us clean up CLI subprocesses too.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let ready = false;
    let stopping = false;
    let exited = false;
    let stopPromise;
    let errors = '';
    let resolveExit;
    const exitPromise = new Promise(resolve => { resolveExit = resolve; });
    const lines = createInterface({ input: child.stdout });
    function signalGroup(signal) {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    function stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      clearTimeout(timer);
      stopPromise = (async () => {
        signalGroup('SIGTERM');
        if (!exited) {
          let killTimer;
          await Promise.race([
            exitPromise,
            new Promise(resolve => { killTimer = setTimeout(resolve, 2000); }),
          ]);
          clearTimeout(killTimer);
        }
        signalGroup('SIGKILL');
        lines.close();
        child.stdin.destroy();
      })();
      return stopPromise;
    }
    const timer = setTimeout(() => {
      reject(new Error(`后台服务启动超时。${errors ? '\n' + errors : ''}`));
      void stop();
    }, timeout);
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
    child.on('error', error => {
      clearTimeout(timer);
      lines.close();
      resolveExit();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      exited = true;
      clearTimeout(timer);
      resolveExit();
      if (!ready) reject(new Error(`后台服务未能启动（${code ?? signal}）。\n${errors}`));
      else if (!stopping) onExit(new Error(`后台服务意外退出（${code ?? signal}）。\n${errors}`));
    });
    lines.on('line', line => {
      if (ready || stopping || !line.startsWith('OCEDIT_READY ')) return;
      try {
        const url = new URL(line.slice('OCEDIT_READY '.length));
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Invalid backend URL');
        ready = true;
        clearTimeout(timer);
        resolve({ url: url.origin, child, stop });
      } catch (error) {
        reject(error);
        void stop();
      }
    });
  });
}

module.exports = { runtimeEnv, findExecutable, startBackend };
