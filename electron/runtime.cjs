const { accessSync, constants, statSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { createInterface } = require('node:readline');

function runtimeEnv(env = process.env, home = homedir()) {
  const originalPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const paths = [
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.local', 'bin'),
    ...(process.platform === 'win32'
      ? [path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm')]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']),
  ];
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.toUpperCase() === 'PATH') delete result[key];
  result.PATH = [...new Set([...originalPath.split(path.delimiter), ...paths].filter(Boolean))].join(path.delimiter);
  return result;
}

function findExecutable(name, env, override) {
  const win = process.platform === 'win32';
  const candidates = override ? [override] : env.PATH.split(path.delimiter).flatMap(dir => {
    dir = dir.replace(/^"|"$/g, '');
    if (!dir) return [];
    if (!win) return [path.join(dir, name)];
    return [path.join(dir, name + '.exe'), path.join(dir, name + '.com'),
      ...(name === 'opencode' ? [path.join(dir, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')] : [])];
  });
  for (const candidate of candidates) {
    try {
      if (win && !/\.(exe|com)$/i.test(candidate)) continue;
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return path.resolve(candidate);
    } catch {}
  }
  throw new Error(`找不到 ${name}。请先安装，或通过 OCEDIT_${name.toUpperCase()} 指定可执行文件路径${win ? '（需要 .exe 文件，不是 .cmd 启动脚本）' : ''}。`);
}

function startBackend({ bun, sourceDir, opencode, token, env = runtimeEnv(), onExit = () => {}, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bun, ['run', path.join(sourceDir, 'server.ts')], {
      cwd: sourceDir,
      env: { ...env, OCEDIT_DESKTOP: '1', OCEDIT_PORT: '0', OCEDIT_TOKEN: token, OCEDIT_OPENCODE: opencode },
      // An isolated process group lets us clean up CLI subprocesses too.
      detached: process.platform !== 'win32',
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
    async function forceStop() {
      if (!child.pid || exited) return;
      if (process.platform === 'win32') {
        await new Promise((resolve, reject) => {
          execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
              if (error && !exited) reject(error); else resolve();
            });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
    function stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      clearTimeout(timer);
      stopPromise = (async () => {
        // Closing the owner pipe lets Bun stop its server and exit cleanly on both OSes.
        child.stdin.end();
        if (!exited) {
          let killTimer;
          await Promise.race([
            exitPromise,
            new Promise(resolve => { killTimer = setTimeout(resolve, 2000); }),
          ]);
          clearTimeout(killTimer);
        }
        await forceStop();
        await exitPromise;
        lines.close();
        child.stdin.destroy();
      })();
      return stopPromise;
    }
    const timer = setTimeout(() => {
      reject(new Error(`后台服务启动超时。${errors ? '\n' + errors : ''}`));
      void stop().catch(() => {});
    }, timeout);
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
    child.on('error', error => {
      exited = true;
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
        void stop().catch(() => {});
      }
    });
  });
}

module.exports = { runtimeEnv, findExecutable, startBackend };
