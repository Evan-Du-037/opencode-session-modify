import { expect, test } from 'bun:test';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createV2Fixture } from './v2-fixture';
const { startBackend, runtimeEnv } = require('../electron/runtime.cjs');

test.skipIf(!process.env.OCEDIT_REAL_OPENCODE)('installed OpenCode v2: list/search, export, edit, clone and re-export with source unchanged', async () => {
  const fixture = await createV2Fixture();
  let backend: any;
  try {
    await mkdir(join(fixture.root, 'tmp'));
    backend = await startBackend({ bun: process.execPath, sourceDir: resolve('src'), opencode: fixture.opencode,
      token: 'v2-test', env: { ...runtimeEnv(), TMPDIR: join(fixture.root, 'tmp') } });
    const headers = { 'X-Ocedit-Token': 'v2-test' };
    const get = async (path: string) => {
      const res = await fetch(backend.url + path, { headers });
      const data = await res.json();
      expect(res.status, JSON.stringify(data.error)).toBe(200);
      return data;
    };
    const list = await get('/api/sessions?q=' + encodeURIComponent('测试回答'));
    expect(list.total).toBe(1);
    expect(list.sessions[0].snippet).toBe('测试回答');
    expect((await get('/api/sessions?dir=/missing')).total).toBe(0);
    expect((await get('/api/dirs')).dirs.map((dir: string) => resolve(dir))).toEqual([resolve(fixture.directory)]);
    expect((await get('/api/sessions?dir=' + encodeURIComponent(fixture.directory))).total).toBe(1);
    const path = '/api/session/' + fixture.session.info.id;
    const source = await get(path);
    const edited = structuredClone(source);
    edited.info.title = 'v2 edited';
    edited.messages[0].parts[0].text = 'edited question';
    edited.messages[1].parts[2].state.input = { path: 'changed' };
    edited.messages[1].parts[2].state.content[0].text = 'changed output';
    edited.messages[1].parts[3].state.error.message = 'changed error';
    edited.messages.push({ info: { id: 'msg_added', role: 'assistant' }, parts: [{ type: 'text', text: 'added answer' }] });
    const response = await fetch(backend.url + path + '/clone', { method: 'POST', headers, body: JSON.stringify(edited) });
    const saved = await response.json();
    expect(response.status, JSON.stringify(saved)).toBe(200);
    expect(saved.id).not.toBe(fixture.session.info.id);
    const clone = await get('/api/session/' + saved.id);
    expect(clone.info.title).toBe('v2 edited');
    expect(clone.messages).toHaveLength(3);
    expect(clone.messages[0].parts[0].text).toBe('edited question');
    expect(clone.messages[1].parts[2].state.input).toEqual({ path: 'changed' });
    expect(clone.messages[1].parts[2].state.content[0].text).toBe('changed output');
    expect(clone.messages[1].parts[3].state.error.message).toBe('changed error');
    expect(clone.messages[2].parts[0].text).toBe('added answer');
    expect(await get(path)).toEqual(source);
    expect(new Set(clone.messages.map((m: any) => m.info.id)).size).toBe(3);
    expect(clone.messages.every((m: any) => !source.messages.some((s: any) => s.info.id === m.info.id))).toBe(true);
    const record = JSON.parse(await readFile(join(fixture.root, 'import.json'), 'utf8'));
    expect(record.cwd).toBe(fixture.directory);
    expect(record.payload.messages[1].content[2].id).toBe('call_fixture');
    expect((await readdir(join(fixture.root, 'tmp'))).filter(name => /^oc-(import|export)-/.test(name))).toEqual([]);
  } finally {
    await backend?.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 60000);
