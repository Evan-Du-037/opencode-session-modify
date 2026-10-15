import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureExecutable } from './executable';

export async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ocedit-test-")));
  const directory = join(root, "project with spaces");
  await mkdir(directory);
  const dbPath = join(root, "opencode.db");
  const now = Date.now();
  const session = {
    info: { id: "ses_fixture", title: "桌面应用测试会话", directory, time: { created: now, updated: now }, model: { providerID: "test", id: "fixture-model" } },
    messages: [
      { info: { id: "msg_user", sessionID: "ses_fixture", role: "user", time: { created: now } }, parts: [{ id: "prt_user", messageID: "msg_user", sessionID: "ses_fixture", type: "text", text: "测试问题" }] },
      { info: { id: "msg_assistant", sessionID: "ses_fixture", parentID: "msg_user", role: "assistant", time: { created: now } }, parts: [
        { id: "prt_reasoning", messageID: "msg_assistant", sessionID: "ses_fixture", type: "reasoning", text: "测试推理", time: { start: now, end: now }, metadata: { anthropic: { signature: "fixture" }, other: true } },
        { id: "prt_answer", messageID: "msg_assistant", sessionID: "ses_fixture", type: "text", text: "测试回答" },
        { id: "prt_tool", messageID: "msg_assistant", sessionID: "ses_fixture", type: "tool", tool: "read", callID: "call_fixture", state: {
          status: "completed", input: { filePath: "/tmp/example.json", options: { lines: Array.from({ length: 80 }, (_, i) => i) } },
          output: JSON.stringify({ content: "长工具输出\n".repeat(300) }), title: "example.json", metadata: { preserved: true }, time: { start: now, end: now },
        } },
        { id: "prt_tool_error", messageID: "msg_assistant", sessionID: "ses_fixture", type: "tool", tool: "bash", callID: "call_error", state: {
          status: "error", input: { command: "false" }, error: "command failed", time: { start: now, end: now },
        } },
      ] },
    ],
  };
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER, directory TEXT, model TEXT, agent TEXT, parent_id TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);`);
  db.query("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(session.info.id, session.info.title, now, now, directory, JSON.stringify(session.info.model), "build");
  for (const m of session.messages) for (const p of m.parts) {
    db.query("INSERT INTO part VALUES (?, ?, ?, ?)").run(p.id, session.info.id, now, JSON.stringify(p));
  }
  db.close();
  await writeFile(join(root, "session.json"), JSON.stringify(session));
  const opencode = await fixtureExecutable(join(root, "opencode with spaces"), `
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('1.18.34');
else if (args[0] === 'db' && args[1] === 'path') console.log(root + '/opencode.db');
else if (args[0] === 'export') {
  const data = JSON.parse(readFileSync(root + '/session.json', 'utf8'));
  if (args[1] !== data.info.id) process.exit(1);
  process.stdout.write(JSON.stringify(data));
  // The real CLI exits explicitly; a large pipe write may still be buffered.
  process.exit(0);
} else if (args[0] === 'import') {
  const payload = JSON.parse(readFileSync(args[1], 'utf8'));
  writeFileSync(root + '/import.json', JSON.stringify({ payload, cwd: process.cwd(), tmp: args[1] }));
  if (existsSync(root + '/fail-import')) process.exit(2);
  const db = new Database(root + '/opencode.db');
  db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(payload.info.id, payload.info.title, payload.info.time.created, payload.info.time.updated, process.cwd(), JSON.stringify(payload.info.model), 'build');
  db.close();
  console.log('Imported');
} else process.exit(1);
`);
  return { root, opencode, session, directory };
}

if (import.meta.main) console.log(JSON.stringify(await createFixture()));
