import { sessionId, messageId, partId } from "./ids";
import { fromV2, toV2 } from "./v2";
import { mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.OCEDIT_PORT ?? 17654);
const DESKTOP = process.env.OCEDIT_DESKTOP === "1";
const TOKEN = process.env.OCEDIT_TOKEN;
const OPENCODE = process.env.OCEDIT_OPENCODE || "opencode";
const INDEX_HTML = import.meta.dir + "/index.html";

function openBrowser(url: string) {
  const command = process.platform === "win32"
    ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
    : [process.platform === "darwin" ? "open" : "xdg-open", url];
  try {
    Bun.spawn({ cmd: command, stdout: "ignore", stderr: "ignore", windowsHide: true });
  } catch {}
}

function parseArgs(): { sessionId?: string } {
  const args = process.argv.slice(2);
  for (const a of args) {
    if (!a.startsWith("-") && /^ses_/.test(a)) return { sessionId: a };
  }
  return {};
}

let server: ReturnType<typeof Bun.serve> | null = null;

let detected: { v2: boolean; path: string } | undefined;
function runtime(): { v2: boolean; path: string } {
  if (detected) return detected;
  const version = Bun.spawnSync({ cmd: [OPENCODE, "--version"], stdin: "ignore", windowsHide: true });
  const match = version.stdout.toString().match(/(?:^|\s)v?(\d+)\./);
  if (version.exitCode !== 0 || !match) throw new Error(`无法检测 OpenCode 版本：${version.stderr.toString().slice(0, 500)}`);
  const major = Number(match[1]);
  if (major !== 1 && major !== 2) throw new Error(`暂不支持 OpenCode ${major}`);
  const v2 = major === 2;
  const r = Bun.spawnSync({ cmd: [OPENCODE, ...(v2 ? ["debug", "paths"] : ["db", "path"])], stdin: "ignore", windowsHide: true });
  const output = r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, "");
  const path = v2 ? output.match(/^db\s+(.+)$/m)?.[1]?.trim() : output.trim();
  if (r.exitCode !== 0 || !path) throw new Error(`无法读取 OpenCode 数据库路径：${r.stderr.toString().slice(0, 500)}`);
  return detected = { v2, path };
}

function dbPath(): string { return runtime().path; }
function sessionTable(): string { return runtime().v2 ? "session_v2" : "session"; }
function transferCommand(command: string): string[] {
  return [OPENCODE, ...(runtime().v2 ? ["session", command] : [command])];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function listSessions(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() || "";
    const dir = url.searchParams.get("dir")?.trim() || "";
    const includeSub = url.searchParams.get("includeSub") === "1";
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0") || 0);
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20") || 20));

    const path = dbPath();
    const db = await sqlite(path);

    const v2 = runtime().v2;
    const table = sessionTable();
    const messages = v2 ? "session_message" : "part";
    const order = v2 ? "seq" : "time_created";
    const textExpr = (alias: string) => v2
      ? `COALESCE(json_extract(${alias}.data, '$.text'), (SELECT json_extract(value, '$.text') FROM json_each(${alias}.data, '$.content') WHERE json_extract(value, '$.type') = 'text' LIMIT 1))`
      : `json_extract(${alias}.data, '$.text')`;
    const conditions: string[] = [];
    const whereParams: string[] = [];
    if (q) {
      conditions.push(`(s.title LIKE ? OR EXISTS (SELECT 1 FROM ${messages} p WHERE p.session_id = s.id AND p.data LIKE ?))`);
      whereParams.push(`%${q}%`, `%${q}%`);
    }
    if (dir) {
      // OpenCode v2 stores forward slashes; the Windows folder picker returns backslashes.
      conditions.push(process.platform === 'win32' ? `replace(s.directory, char(92), '/') = ? COLLATE NOCASE` : `s.directory = ?`);
      whereParams.push(process.platform === 'win32' ? dir.replaceAll('\\', '/') : dir);
    }
    if (!includeSub) {
      conditions.push(`s.parent_id IS NULL`);
    }
    const whereSql = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM ${table} s${whereSql}`).get(...whereParams) as Record<string, unknown>;
    const total = (countRow?.cnt as number) || 0;

    const snippetExpr = `COALESCE(
      ${q ? `(SELECT substr(${textExpr("p2")}, 1, 300) FROM ${messages} p2 WHERE p2.session_id = s.id AND ${textExpr("p2")} LIKE ? ORDER BY p2.${order} LIMIT 1),` : ""}
      (SELECT substr(${textExpr("p3")}, 1, 300) FROM ${messages} p3 WHERE p3.session_id = s.id AND ${textExpr("p3")} IS NOT NULL ORDER BY p3.${order} LIMIT 1), '')`;
    const snippetParams = q ? [`%${q}%`] : [];

    const dataSql = `SELECT s.id, s.title, s.time_created, s.time_updated, s.directory, s.model, s.agent, s.parent_id,
      ${snippetExpr} as snippet
      FROM ${table} s${whereSql}
      ORDER BY s.time_updated DESC LIMIT ${limit} OFFSET ${offset}`;

    const rows = db.prepare(dataSql).all(...snippetParams, ...whereParams);
    const sessions = rows.map((r: Record<string, unknown>) => {
      let modelId = "";
      try { modelId = JSON.parse(r.model as string)?.id || ""; } catch {}
      return {
        id: r.id,
        title: r.title,
        time: { created: r.time_created, updated: r.time_updated },
        directory: r.directory,
        model: modelId,
        agent: r.agent,
        snippet: r.snippet || "",
        ...(r.parent_id ? { sub: true } : {}),
      };
    });
    return json({ sessions, total });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

async function listDirs(): Promise<Response> {
  try {
    const path = dbPath();
    const db = await sqlite(path);
    const rows = db.prepare(
      `SELECT DISTINCT directory FROM ${sessionTable()} ORDER BY directory;`,
    ).all() as Record<string, unknown>[];
    return json({ home: homedir(), dirs: rows.map((r) => r.directory) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

async function getSession(id: string): Promise<Response> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "oc-export-"));
    const filename = join(directory, "session.json");
    const output = await open(filename, "wx", 0o600);
    let r: ReturnType<typeof Bun.spawnSync>;
    try {
      // OpenCode exits before large asynchronous pipe writes finish. A regular
      // file descriptor makes stdout writes synchronous and preserves all JSON.
      r = Bun.spawnSync({ cmd: [...transferCommand("export"), id], stdout: output.fd, stderr: "pipe", stdin: "ignore", windowsHide: true });
    } finally {
      await output.close();
    }
    if (r.exitCode !== 0) {
      return json({ error: `export failed: ${r.stderr.toString().slice(0, 500)}` }, 404);
    }
    const text = await readFile(filename, "utf8");
    if (text.trim().length === 0) {
      return json({ error: "session not found" }, 404);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return json({ error: "export produced invalid JSON" }, 500);
    }
    return json(runtime().v2 ? fromV2(data) : data);
  } catch (e) {
    return json({ error: String(e) }, 500);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function rewriteClone(data: any): void {
  let seq = 0;
  const newSes = sessionId(seq++);
  const oldMsg2new = new Map<string, string>();
  for (const m of data.messages ?? []) {
    const oldId = m?.info?.id;
    let newId: string | undefined;
    if (typeof oldId === "string") {
      newId = messageId(seq++);
      oldMsg2new.set(oldId, newId);
      m.info.id = newId;
    }
    if (m?.info) {
      m.info.sessionID = newSes;
      if (typeof m.info.parentID === "string") {
        const mapped = oldMsg2new.get(m.info.parentID);
        if (mapped) m.info.parentID = mapped;
      }
    }
    for (const p of m?.parts ?? []) {
      p.id = partId(seq++);
      p.sessionID = newSes;
      if (newId) p.messageID = newId;
    }
  }
  data.info = data.info ?? {};
  data.info.id = newSes;
}

async function cloneSession(id: string, req: Request): Promise<Response> {
  let tmp = "";
  try {
    const body = await req.text();
    let data: any;
    try {
      data = JSON.parse(body);
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!data || typeof data !== "object" || !data.info || !Array.isArray(data.messages)) {
      return json({ error: "body must be { info, messages }" }, 400);
    }
    const v2 = runtime().v2;
    if (v2) {
      if (data.info._format !== 2) return json({ error: "请重新打开 v2 会话后再保存" }, 400);
      data = toV2(data);
      data.info.id = sessionId(0);
      for (const message of data.messages) message.id = messageId(0);
      // Export materializes fork history. The clone is independent of the
      // source's parent, fork boundary and undo state.
      delete data.info.parentID;
      delete data.info.fork;
      delete data.info.revert;
      delete data.info.time.archived;
    } else rewriteClone(data);

    for (const msg of data.messages ?? []) {
      for (const part of msg.parts ?? []) {
        if (part.type === "reasoning" && part.metadata) {
          delete part.metadata.anthropic;
        }
      }
    }

    const newId = data.info.id;

    tmp = join(tmpdir(), `oc-import-${crypto.randomUUID()}.json`);
    await Bun.write(tmp, JSON.stringify(data), { mode: 0o600 });

    let cwd: string | undefined;
    try {
      const db = await sqlite(dbPath());
      const row = db.prepare(`SELECT directory FROM ${sessionTable()} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      const dir = row?.directory;
      if (typeof dir === "string" && dir.length > 0) cwd = dir;
    } catch (e) { throw new Error(`无法定位原会话目录：${e}`); }
    if (!cwd) return json({ error: "原会话不存在，无法确定保存目录" }, 404);

    const r = Bun.spawnSync({
      cmd: [...transferCommand("import"), tmp, ...(v2 ? ["--directory", cwd] : [])],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      windowsHide: true,
    });
    if (r.exitCode !== 0 || (v2 && !r.stdout.toString().includes(`Imported session: ${newId}`))) {
      const err = (r.stderr?.toString() ?? "") + (r.stdout?.toString() ?? "");
      return json({ error: `import failed: ${err.slice(0, 500)}` }, 500);
    }
    return json({ id: newId, title: data.info.title ?? "" });
  } catch (e) {
    return json({ error: String(e) }, 500);
  } finally {
    if (tmp) {
      try {
        await unlink(tmp);
      } catch {}
    }
  }
}

async function serveIndex(): Promise<Response> {
  try {
    const f = Bun.file(INDEX_HTML);
    if (await f.exists()) {
      return new Response(f, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }
    return new Response("index.html not found", { status: 404 });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}

async function serveStatic(filename: string, mime: string): Promise<Response> {
  try {
    const f = Bun.file(import.meta.dir + "/" + filename);
    if (await f.exists()) {
      return new Response(f, {
        headers: { "Content-Type": `${mime}; charset=utf-8`, "Cache-Control": "no-cache" },
      });
    }
    return new Response(filename + " not found", { status: 404 });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}

async function router(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (TOKEN && req.headers.get("X-Ocedit-Token") !== TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (path === "/api/sessions" && method === "GET") return listSessions(req);
  if (path === "/api/dirs" && method === "GET") return listDirs();

  const m = path.match(/^\/api\/session\/([^/]+)$/);
  if (m && method === "GET") return getSession(m[1]);

  const mc = path.match(/^\/api\/session\/([^/]+)\/clone$/);
  if (mc && method === "POST") return cloneSession(mc[1], req);

  if (path === "/" && method === "GET") return serveIndex();
  if (path === "/app.js" && method === "GET") return serveStatic("app.js", "application/javascript");

  return json({ error: "not found", path }, 404);
}

let _dbCache: { path: string; db: any } | null = null;
async function sqlite(path: string): Promise<any> {
  if (_dbCache && _dbCache.path === path) return _dbCache.db;
  const mod: any = await import("bun:sqlite");
  const Database = mod.Database ?? mod.default?.Database;
  const db = new Database(path, { readonly: true });
  _dbCache = { path, db };
  return db;
}

export function startServer(port: number = PORT): ReturnType<typeof Bun.serve> {
  if (server) return server;
  server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      try {
        return await router(req);
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    },
  });
  console.log(`Session editor server running at http://127.0.0.1:${server.port}`);
  return server;
}

export function stopServer(): void {
  if (server) {
    server.stop(true);
    server = null;
  }
}

if (import.meta.main) {
  if (DESKTOP && !TOKEN) throw new Error("Desktop mode requires OCEDIT_TOKEN");
  const { sessionId: sid } = parseArgs();
  const s = startServer(PORT);
  const url = sid ? `http://127.0.0.1:${s.port}/?session=${encodeURIComponent(sid)}` : `http://127.0.0.1:${s.port}/`;
  console.log(`Session editor running at ${url}`);
  if (sid) console.log(`Editing session: ${sid}`);
  if (DESKTOP) {
    console.log(`OCEDIT_READY http://127.0.0.1:${s.port}`);
    // Electron owns this pipe. Also exit if the desktop process crashes.
    process.stdin.resume();
    process.stdin.on("end", () => { stopServer(); process.exit(0); });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => { stopServer(); process.exit(0); });
    }
  } else {
    openBrowser(url);
  }
}
