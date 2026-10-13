import { mkdtemp, mkdir, chmod, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function v2Session(directory: string) {
  const now = Date.now();
  return {
    info: { id: 'ses_v2_fixture', projectID: 'global', title: '桌面应用测试会话', location: { directory },
      agent: 'build', model: { providerID: 'test', id: 'fixture-model' }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now, updated: now } },
    messages: [
      { id: 'msg_user', type: 'user', text: '测试问题', time: { created: now } },
      { id: 'msg_assistant', type: 'assistant', agent: 'build', model: { providerID: 'test', id: 'fixture-model' },
        time: { created: now, completed: now }, content: [
          { type: 'reasoning', text: '测试推理', state: { anthropic: { signature: 'fixture' }, other: true } },
          { type: 'text', text: '测试回答' },
          { type: 'tool', id: 'call_fixture', name: 'read', time: { created: now, completed: now }, state: {
            status: 'completed', input: { filePath: '/tmp/example.json', options: { lines: Array.from({ length: 80 }, (_, i) => i) } },
            content: [{ type: 'text', text: '长工具输出\n'.repeat(300) }], metadata: { preserved: true },
          } },
          { type: 'tool', id: 'call_error', name: 'bash', time: { created: now, completed: now }, state: {
            status: 'error', input: { command: 'false' }, error: { type: 'unknown', message: 'command failed' },
          } },
        ] },
    ],
  };
}

// This wrapper uses the installed CLI, with private XDG directories and a
// short-lived server. It never connects to the user's background service.
export async function createV2Fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ocedit-v2-test-')));
  const directory = join(root, 'project with spaces');
  await mkdir(directory);
  const session = v2Session(directory);
  const executable = process.env.OCEDIT_REAL_OPENCODE || join(process.env.HOME!, '.opencode/bin/opencode');
  const env = { ...process.env, XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'),
    OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG_DIR: '' };
  const opencode = join(root, 'opencode with spaces');
  await writeFile(opencode, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'session' && args[1] === 'import') {
  writeFileSync(${JSON.stringify(join(root, 'import.json'))}, JSON.stringify({ payload: JSON.parse(readFileSync(args[2], 'utf8')), tmp: args[2], cwd: process.cwd() }));
}
const command = args[0] === 'session' ? [...args, '--standalone'] : args;
const result = Bun.spawnSync({ cmd: [${JSON.stringify(executable)}, ...command], env: ${JSON.stringify(Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('XDG_') || key.startsWith('OPENCODE_CONFIG'))))} , stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
process.exit(result.exitCode);
`);
  // Keep normal environment (PATH, HOME) as well as isolated config in wrapper.
  let wrapper = await Bun.file(opencode).text();
  wrapper = wrapper.replace('env: {', 'env: { ...process.env,');
  await writeFile(opencode, wrapper);
  await chmod(opencode, 0o755);
  const file = join(root, 'session.json');
  await writeFile(file, JSON.stringify(session));
  const imported = Bun.spawnSync({ cmd: [opencode, 'session', 'import', file, '--directory', directory], cwd: root });
  if (imported.exitCode !== 0 || !imported.stdout.toString().includes('Imported session:')) throw new Error(imported.stderr.toString());
  return { root, directory, opencode, session };
}
if (import.meta.main) console.log(JSON.stringify(await createV2Fixture()));
