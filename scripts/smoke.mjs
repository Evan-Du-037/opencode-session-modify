// Exercise the packaged app against disposable data, never the user's database.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const appDir = process.argv[2] || path.join(root, 'dist', `OpenCode Session Editor-darwin-${process.arch}`, 'OpenCode Session Editor.app');
const binary = path.join(appDir, 'Contents', 'MacOS', 'OpenCode Session Editor');
const fixture = JSON.parse(execFileSync('bun', ['run', path.join(root, 'tests', 'fixture.ts')], { encoding: 'utf8' }));
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
  assert.equal(payload.messages[1].parts[1].text, 'Electron 打包应用保存测试');
  assert.notEqual(payload.info.id, 'ses_fixture');
  assert.equal(await evaluate('hasChanges()'), false);
  await assert.rejects(readFile(tmp));
  await checkEditorScroll();
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
  console.log('PASS: packaged window, editor scroll retention (8 operations), fresh-view scroll reset, clone save, single instance, exit and backend cleanup.');
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill('SIGTERM');
  for (const callback of pending.values()) clearTimeout(callback.timer);
  await rm(fixture.root, { recursive: true, force: true });
}
