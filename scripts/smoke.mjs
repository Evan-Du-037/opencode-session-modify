// Exercise the packaged app against disposable data, never the user's database.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const appDir = process.argv[2] || path.join(root, 'dist', `OpenCode Session Editor-darwin-${process.arch}`, 'OpenCode Session Editor.app');
const binary = path.join(appDir, 'Contents', 'MacOS', 'OpenCode Session Editor');
const v2 = process.env.OCEDIT_TEST_V2 === '1';
const fixture = JSON.parse(execFileSync('bun', ['run', path.join(root, 'tests', v2 ? 'v2-fixture.ts' : 'fixture.ts')], { encoding: 'utf8' }));
const appEnv = { ...process.env, OCEDIT_OPENCODE: fixture.opencode };
delete appEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(binary, ['--remote-debugging-port=0', `--user-data-dir=${path.join(fixture.root, 'profile')}`], {
  env: appEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); });
child.stdout.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); });
let socket;
let nextId = 0;
const pending = new Map();
const errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out: ${description}\n${diagnostics}`);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function afterLayout() {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
}

async function checkToolEditing() {
  const select = key => `document.querySelector('.diff-cell.right .tool-block[data-part-id="prt_tool"] .tool-edit[data-field="${key}"]')`;
  async function edit(key, value) {
    await evaluate(`(() => {
      const field = ${select(key)};
      field.value = ${JSON.stringify(value)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await afterLayout();
  }
  assert.equal(await evaluate("[...document.querySelectorAll('.tool-block')].every(tool => !tool.open)"), true, 'tools start collapsed');
  assert.equal(await evaluate("document.querySelectorAll('.tool-edit').length"), 0, 'collapsed tools load their contents lazily');
  await evaluate("document.querySelector('.diff-cell.right .tool-block').open = true");
  await afterLayout();
  assert.equal(await evaluate("[...document.querySelectorAll('.diff-cell.right .tool-field')].every(field => !field.open)"), true, 'input and output start collapsed');
  await evaluate("document.querySelectorAll('.diff-cell.right .tool-field').forEach(field => field.open = true)");
  await afterLayout();
  assert.ok(await evaluate(`${select('input')}.value.includes('\\n')`), 'JSON input is formatted');
  assert.equal(await evaluate(`${select('output')}.value`), JSON.stringify({ content: '长工具输出\n'.repeat(300) }, null, 2));
  assert.ok(await evaluate(`${select('input')}.clientHeight <= 320 && ${select('input')}.scrollHeight > ${select('input')}.clientHeight`), 'long input scrolls inside a bounded editor');
  assert.equal(await evaluate('hasChanges()'), false, 'expanding and formatting do not change tool data');

  const editedInput = { filePath: '/tmp/edited.json', nested: { count: 2 } };
  await edit('input', JSON.stringify(editedInput, null, 2));
  assert.equal(await evaluate('hasChanges()'), true, 'tool-only edits enable save');
  assert.equal(await evaluate("document.querySelector('.diff-cell.right .tool-block').closest('.diff-row').classList.contains('modified')"), true, 'tool edits appear in the diff');
  assert.equal(await evaluate("state.originalMessages[1].parts[2].state.input.filePath"), '/tmp/example.json', 'original tool is unchanged');
  await edit('input', '{"filePath":');
  assert.equal(await evaluate('toolErrors().length'), 1);
  assert.equal(await evaluate('saveAs()'), null, 'invalid JSON blocks saving');
  await assert.rejects(readFile(path.join(fixture.root, 'import.json')));
  await evaluate("addReasoning(state.session.messages[1])");
  await afterLayout();
  assert.equal(await evaluate(`${select('input')}.value`), '{"filePath":', 'invalid draft survives rerender');
  await evaluate("document.querySelector('.diff-cell.right .tool-block').open = false");
  await afterLayout();
  await evaluate("document.querySelector('.diff-cell.right .tool-block').open = true");
  await afterLayout();
  assert.equal(await evaluate(`${select('input')}.value`), '{"filePath":', 'draft survives collapse');
  await edit('input', '[]');
  assert.equal(await evaluate('toolErrors().length'), 1, 'tool input must remain an object');
  await edit('input', JSON.stringify(editedInput, null, 2));
  assert.equal(await evaluate('toolErrors().length'), 0);
  await edit('output', '{"ok":true,"message":"edited"}');
  assert.equal(await evaluate("typeof state.session.messages[1].parts.find(p => p.id === 'prt_tool').state.output"), 'string', 'JSON tool output remains a string');
  await edit('output', '修改后的普通文本输出\n第二行');

  await evaluate("document.querySelector('.diff-cell.left .tool-block').open = true");
  await afterLayout();
  await evaluate("document.querySelector('.diff-cell.left .tool-field').open = true");
  await afterLayout();
  assert.equal(await evaluate("document.querySelector('.diff-cell.left .tool-edit').readOnly"), true);

  await evaluate("document.querySelector('.diff-cell.right .tool-block[data-part-id=\"prt_tool_error\"]').open = true");
  await afterLayout();
  await evaluate("document.querySelector('.diff-cell.right .tool-field[data-field=\"error\"]').open = true");
  await afterLayout();
  await evaluate(`(() => {
    const field = document.querySelector('.diff-cell.right .tool-edit[data-field="error"]');
    field.value = '修改后的错误输出';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    deletePart(state.session.messages[1], 0);
  })()`);
  await afterLayout();
  assert.equal(await evaluate(`${select('output')}.value`), '修改后的普通文本输出\n第二行', 'valid edits and expansion survive rerender');
}

async function checkV2Editing() {
  assert.equal(await evaluate("[...document.querySelectorAll('.tool-block')].every(tool => !tool.open)"), true);
  await evaluate("document.querySelectorAll('.diff-cell.right .tool-block').forEach(tool => tool.open = true)");
  await afterLayout();
  await evaluate("document.querySelectorAll('.diff-cell.right .tool-field').forEach(field => field.open = true)");
  await afterLayout();
  async function edit(key, value) {
    await evaluate(`(() => {
      const field = document.querySelector('.diff-cell.right .tool-edit[data-field="${key}"]');
      field.value = ${JSON.stringify(value)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await afterLayout();
  }
  assert.equal(await evaluate('hasChanges()'), false);
  await edit('input', '{');
  assert.equal(await evaluate('toolErrors().length'), 1);
  assert.equal(await evaluate('saveAs()'), null);
  await edit('input', JSON.stringify({ path: '/tmp/v2-edited.json' }));
  await edit('content', '[]');
  assert.equal(await evaluate('toolErrors().length'), 1);
  await edit('content', JSON.stringify([{ type: 'text', text: 'v2 修改后的工具输出' }]));
  await edit('error', JSON.stringify({ type: 'unknown', message: 'v2 修改后的错误输出' }));
  await evaluate("deletePart(state.session.messages[1], 0); addMessageAt(state.session.messages.length); toggleRole(state.session.messages.at(-1)); state.session.messages.at(-1).parts[0].text = 'v2 新增回答'; render({ preserveEditorScroll: true })");
  await afterLayout();
  assert.equal(await evaluate('toolErrors().length'), 0);
}

async function checkEditorScroll() {
  await evaluate(`(() => {
    window.scrollTest = {
      savedMessages: structuredClone(state.session.messages),
      row(index) {
        const marker = 'scroll-message-' + index + ':';
        const rows = [...document.querySelectorAll('.diff-row')];
        return rows.find(row => row.querySelector('.left').textContent.startsWith(marker))
          || rows.find(row => row.querySelector('.right .text-edit:not(.reasoning)')?.value.startsWith(marker));
      },
    };
    state.session.messages = Array.from({ length: 40 }, (_, index) => ({
      info: { id: 'msg_scroll_' + index, role: index % 2 ? 'assistant' : 'user' },
      parts: [
        { id: 'prt_scroll_text_' + index, type: 'text', text: 'scroll-message-' + index + ':\\n' + ('正文行 ' + index + '\\n').repeat(16) },
        { id: 'prt_scroll_reason_' + index, type: 'reasoning', text: ('推理行 ' + index + '\\n').repeat(8) },
      ],
    }));
    state.originalMessages = structuredClone(state.session.messages);
    render();
  })()`);
  await afterLayout();

  async function check(label, action, index = 18) {
    const before = await evaluate(`(() => {
      const row = scrollTest.row(${index});
      const container = document.getElementById('diff-scroll');
      container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - 180;
      return { top: row.getBoundingClientRect().top, scroll: container.scrollTop };
    })()`);
    assert.ok(before.scroll > 1000, `${label}: test must start well below the top`);
    await evaluate(action);
    await afterLayout();
    const after = await evaluate(`({ top: scrollTest.row(${index}).getBoundingClientRect().top, scroll: document.getElementById('diff-scroll').scrollTop })`);
    assert.ok(after.scroll > 1000, `${label}: jumped to the top`);
    assert.ok(Math.abs(after.top - before.top) <= 2, `${label}: visible message moved by ${after.top - before.top}px`);
  }

  await check('add thinking', "scrollTest.row(18).querySelector('.add-reasoning-btn').click()");
  await check('delete added thinking', "scrollTest.row(18).querySelector('.del-reasoning-btn').click()");
  await check('delete original thinking', "scrollTest.row(18).querySelector('.del-reasoning-btn').click()");
  await check('delete message', "scrollTest.row(18).querySelector('.diff-delete-gutter').click()");
  await check('change role', "scrollTest.row(20).querySelector('.diff-gutter').click()", 20);
  await check('add thinking near the bottom', "scrollTest.row(38).querySelector('.add-reasoning-btn').click()", 38);
  await check('append message', "document.querySelector('.diff-add-zone button').click()", 38);
  await check('delete newly appended message', "[...document.querySelectorAll('.diff-delete-gutter.clickable')].at(-1).click()", 38);

  await evaluate(`state.session.messages = scrollTest.savedMessages; state.originalMessages = structuredClone(scrollTest.savedMessages); render();`);
  await afterLayout();
  assert.equal(await evaluate('document.getElementById("diff-scroll").scrollTop'), 0, 'fresh renders must reset scroll');
}

try {
  const port = await until(() => diagnostics.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1], 'DevTools startup');
  const target = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:'));
  }, 'application window');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
    const callback = pending.get(message.id);
    if (!callback) return;
    clearTimeout(callback.timer);
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
    else callback.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  await send('Runtime.enable');
  await until(() => evaluate('document.querySelectorAll(".session-item").length === 1'), 'session list');
  assert.equal(await evaluate('typeof require'), 'undefined');
  assert.equal(await evaluate('typeof window.desktop.pickDirectory'), 'function');
  assert.equal(await evaluate('typeof window.desktop.copyText'), 'function');
  await evaluate('document.querySelector(".session-item").click()');
  await until(() => evaluate('!!document.querySelector(".text-edit")'), 'editor');
  assert.equal(await evaluate('document.querySelectorAll(".diff-row").length'), 2);
  if (v2) await checkV2Editing();
  else await checkToolEditing();
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  await mkdir(path.join(root, '.build'), { recursive: true });
  await writeFile(path.join(root, '.build', 'desktop-smoke.png'), Buffer.from(screenshot.data, 'base64'));
  await evaluate(`(() => {
    const field = [...document.querySelectorAll('.text-edit')].find(el => el.value === '测试回答');
    field.value = 'Electron 打包应用保存测试';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(await evaluate('document.getElementById("save-btn").disabled'), false);
  await evaluate('document.getElementById("save-btn").click()');
  await until(() => evaluate('document.getElementById("toast").textContent.includes("已保存为新会话")'), 'save clone');
  const { payload, cwd, tmp } = JSON.parse(await readFile(path.join(fixture.root, 'import.json'), 'utf8'));
  assert.equal(cwd, fixture.directory);
  if (v2) {
    const content = payload.messages[1].content;
    assert.equal(content.find(p => p.type === 'text').text, 'Electron 打包应用保存测试');
    const tool = content.find(p => p.type === 'tool' && p.name === 'read');
    assert.deepEqual(tool.state.input, { path: '/tmp/v2-edited.json' });
    assert.equal(tool.state.content[0].text, 'v2 修改后的工具输出');
    assert.equal(tool.state.metadata.preserved, true);
    assert.equal(tool.id, 'call_fixture');
    assert.equal(content.find(p => p.name === 'bash').state.error.message, 'v2 修改后的错误输出');
    assert.ok(!content.some(p => p.type === 'reasoning'));
    assert.equal(payload.messages.length, 3);
    assert.equal(payload.messages[2].type, 'assistant');
    assert.equal(payload.messages[2].content[0].text, 'v2 新增回答');
    const native = JSON.parse(execFileSync(fixture.opencode, ['session', 'export', payload.info.id], { cwd: fixture.directory, encoding: 'utf8' }));
    assert.deepEqual(native.messages, payload.messages);
  } else {
  assert.equal(payload.messages[1].parts[1].text, 'Electron 打包应用保存测试');
  const tool = payload.messages[1].parts.find(part => part.type === 'tool' && part.tool === 'read');
  assert.deepEqual(tool.state.input, { filePath: '/tmp/edited.json', nested: { count: 2 } });
  assert.equal(tool.state.output, '修改后的普通文本输出\n第二行');
  assert.deepEqual(tool.state.metadata, { preserved: true });
  assert.equal(tool.callID, 'call_fixture');
  assert.equal(payload.messages[1].parts.find(part => part.tool === 'bash').state.error, '修改后的错误输出');
  }
  assert.notEqual(payload.info.id, 'ses_fixture');
  assert.equal(await evaluate('hasChanges()'), false);
  await assert.rejects(readFile(tmp));
  if (!v2) await checkEditorScroll();
  assert.deepEqual(errors, []);

  const second = spawn(binary, [`--user-data-dir=${path.join(fixture.root, 'profile')}`], { env: appEnv, stdio: 'ignore' });
  await until(() => second.exitCode !== null, 'second instance exits', 10000);
  assert.equal(second.exitCode, 0);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.equal(pages.filter(page => page.type === 'page').length, 1);

  await send('Browser.close').catch(() => {});
  await until(() => child.exitCode !== null, 'app exit', 10000);
  assert.equal(child.exitCode, 0);
  await assert.rejects(fetch(target.url));
  console.log(v2
    ? 'PASS V2: packaged window, real CLI, collapsed tool editing, JSON validation, reasoning deletion, assistant insertion, clone save and native re-export, single instance, exit and backend cleanup.'
    : 'PASS V1: packaged window, collapsed tool editing, JSON validation and draft retention, clone save, scroll retention (8 operations), fresh-view reset, single instance, exit and backend cleanup.');
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill('SIGTERM');
  for (const callback of pending.values()) clearTimeout(callback.timer);
  await rm(fixture.root, { recursive: true, force: true });
}
