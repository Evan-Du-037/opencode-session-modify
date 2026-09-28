import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createFixture } from "./fixture";
const { startBackend, runtimeEnv, findExecutable } = require("../electron/runtime.cjs");

let fixture: Awaited<ReturnType<typeof createFixture>>;
let backend: any;
const token = "desktop-test-token";
const headers = { "X-Ocedit-Token": token };

beforeAll(async () => {
  fixture = await createFixture();
  await mkdir(join(fixture.root, "tmp"));
  backend = await startBackend({
    bun: process.execPath, sourceDir: resolve("src"), opencode: fixture.opencode, token,
    env: { ...runtimeEnv(), TMPDIR: join(fixture.root, "tmp") },
  });
});
afterAll(async () => {
  await backend?.stop();
  if (fixture) await rm(fixture.root, { recursive: true, force: true });
});

test("desktop backend binds loopback, chooses a port and authenticates requests", async () => {
  expect(new URL(backend.url).hostname).toBe("127.0.0.1");
  expect((await fetch(backend.url)).status).toBe(401);
  const page = await fetch(backend.url, { headers });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('/app.js');
});

test("Finder environment can discover OpenCode and explicit paths with spaces", () => {
  const env = runtimeEnv({ PATH: "/usr/bin:/bin" }, "/example/home");
  expect(env.PATH).toContain("/example/home/.opencode/bin");
  expect(env.PATH).toContain("/opt/homebrew/bin");
  expect(findExecutable("opencode", env, fixture.opencode)).toBe(fixture.opencode);
  expect(() => findExecutable("opencode", env, "/nonexistent/ocedit-fixture")).toThrow("找不到 opencode");
});

test("list, directory filters and export work through the configured OpenCode executable", async () => {
  const list = await (await fetch(backend.url + "/api/sessions?q=" + encodeURIComponent("测试"), { headers })).json();
  expect(list.sessions[0].id).toBe("ses_fixture");
  const dirs = await (await fetch(backend.url + "/api/dirs", { headers })).json();
  expect(dirs.dirs).toContain(fixture.directory);
  const empty = await (await fetch(backend.url + "/api/sessions?dir=/not-this-project", { headers })).json();
  expect(empty.total).toBe(0);
  const data = await (await fetch(backend.url + "/api/session/ses_fixture", { headers })).json();
  expect(data).toEqual(fixture.session);
});

test("large exports remain complete when the OpenCode CLI exits immediately", async () => {
  const large = structuredClone(fixture.session);
  large.messages[1].parts[1].text = "大体积会话 🧪\n".repeat(250000);
  const file = join(fixture.root, "session.json");
  await writeFile(file, JSON.stringify(large));
  try {
    const response = await fetch(backend.url + "/api/session/ses_fixture", { headers });
    expect(response.status).toBe(200);
    const exported = await response.json();
    expect(exported.messages[1].parts[1].text).toBe(large.messages[1].parts[1].text);
    expect(await readdir(join(fixture.root, "tmp"))).toEqual([]);
  } finally {
    await writeFile(file, JSON.stringify(fixture.session));
  }
});

test("failed exports remove their temporary directory", async () => {
  const response = await fetch(backend.url + "/api/session/ses_missing", { headers });
  expect(response.status).toBe(404);
  expect(await readdir(join(fixture.root, "tmp"))).toEqual([]);
});

test("clone keeps the source intact, remaps IDs, uses its project directory and removes temporary files", async () => {
  const edited = structuredClone(fixture.session);
  edited.info.title = "已编辑";
  const result = await fetch(backend.url + "/api/session/ses_fixture/clone", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(edited),
  });
  expect(result.status).toBe(200);
  const saved = await result.json();
  expect(saved.id).not.toBe("ses_fixture");
  const { payload, cwd, tmp } = JSON.parse(await readFile(join(fixture.root, "import.json"), "utf8"));
  expect(cwd).toBe(fixture.directory);
  expect(payload.messages[1].info.parentID).toBe(payload.messages[0].info.id);
  expect(payload.messages[1].parts[0].metadata).toEqual({ other: true });
  for (const m of payload.messages) for (const p of m.parts) {
    expect(p.sessionID).toBe(saved.id);
    expect(p.messageID).toBe(m.info.id);
  }
  expect(existsSync(tmp)).toBe(false);
  expect(JSON.parse(await readFile(join(fixture.root, "session.json"), "utf8"))).toEqual(fixture.session);
});

test("failed imports report an error and still clean up their temporary file", async () => {
  await writeFile(join(fixture.root, "fail-import"), "1");
  const result = await fetch(backend.url + "/api/session/ses_fixture/clone", {
    method: "POST", headers, body: JSON.stringify(fixture.session),
  });
  expect(result.status).toBe(500);
  const { tmp } = JSON.parse(await readFile(join(fixture.root, "import.json"), "utf8"));
  expect(existsSync(tmp)).toBe(false);
});

test("losing the desktop parent pipe terminates the background service", async () => {
  const other = await startBackend({ bun: process.execPath, sourceDir: resolve("src"), opencode: fixture.opencode, token });
  const exited = new Promise(resolve => other.child.once("exit", resolve));
  other.child.stdin.end();
  await exited;
  expect(other.child.exitCode).toBe(0);
  await other.stop();
});

test("explicit app shutdown stops the background process and closes its port", async () => {
  await backend.stop();
  expect(backend.child.exitCode !== null || backend.child.signalCode !== null).toBe(true);
  await expect(fetch(backend.url, { headers })).rejects.toThrow();
});
