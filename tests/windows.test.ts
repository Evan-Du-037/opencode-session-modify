import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
const { runtimeEnv, findExecutable, startBackend } = require('../electron/runtime.cjs');

async function cleanup(root: string) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

test.skipIf(process.platform !== 'win32')('Windows discovers native npm CLI and normalizes Path without executing cmd shims', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocedit-windows-'));
  try {
    const npm = join(root, 'npm with spaces');
    const native = join(npm, 'node_modules', '@opencode', 'cli', 'bin');
    await mkdir(native, { recursive: true });
    await writeFile(join(npm, 'opencode.cmd'), '@echo should not run');
    await writeFile(join(native, 'opencode.exe'), 'discovery fixture');
    const env = runtimeEnv({ Path: npm }, root);
    expect(Object.keys(env).filter(key => key.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(findExecutable('opencode', env)).toBe(join(native, 'opencode.exe'));
    expect(() => findExecutable('opencode', env, join(npm, 'opencode.cmd'))).toThrow('.exe');
    expect(() => findExecutable('opencode', env, native)).toThrow();
    await writeFile(join(npm, 'bun.exe'), 'discovery fixture');
    expect(findExecutable('bun', env)).toBe(join(npm, 'bun.exe'));
  } finally { await cleanup(root); }
});

test.skipIf(process.platform !== 'win32')('Windows shutdown terminates an unresponsive owned backend and its child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocedit-process-'));
  let backend: any;
  try {
    await writeFile(join(root, 'server.ts'), `
import { writeFileSync } from 'node:fs';
const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true });
writeFileSync(${JSON.stringify(join(root, 'child.pid'))}, String(child.pid));
process.stdin.resume();
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);
console.log('OCEDIT_READY http://127.0.0.1:12345');
`);
    backend = await startBackend({ bun: process.execPath, sourceDir: root, opencode: 'unused', token: 'test' });
    const pid = Number(await readFile(join(root, 'child.pid'), 'utf8'));
    await backend.stop();
    expect(backend.child.exitCode !== null || backend.child.signalCode !== null).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    await backend.stop();
  } finally { await backend?.stop(); await cleanup(root); }
});
