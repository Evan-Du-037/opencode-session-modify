import { sessionId, messageId, partId } from "./ids";

const PORT = 17654;
const INDEX_HTML = import.meta.dir + "/index.html";

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn({ cmd: [cmd, url], stdout: "ignore", stderr: "ignore" });
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

function oc(args: string[]): { ok: boolean; stdout: string; stderr: string; exitCode: number } {
  const r = Bun.spawnSync({ cmd: ["opencode", ...args] });
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    exitCode: r.exitCode ?? -1,
  };
}

function ocQuiet(args: string[]): { ok: boolean; exitCode: number; combined: string } {
  const r = Bun.spawnSync({ cmd: ["opencode", ...args], stdout: "pipe", stderr: "pipe" });
  return {
    ok: r.exitCode === 0,
    exitCode: r.exitCode ?? -1,
    combined: (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? ""),
  };
}

function dbPath(): string {
  const r = Bun.spawnSync({ cmd: ["opencode", "db", "path"] });
  return r.stdout.toString().trim();
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

    const conditions: string[] = [];
    const whereParams: string[] = [];
    if (q) {
      conditions.push(`(s.title LIKE ? OR EXISTS (SELECT 1 FROM part p WHERE p.session_id = s.id AND p.data LIKE ?))`);
      whereParams.push(`%${q}%`, `%${q}%`);
    }
    if (dir) {
      conditions.push(`s.directory = ?`);
      whereParams.push(dir);
    }
    if (!includeSub) {
      conditions.push(`s.parent_id IS NULL`);
    }
    const whereSql = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM session s${whereSql}`).get(...whereParams) as Record<string, unknown>;
    const total = (countRow?.cnt as number) || 0;

    const snippetExpr = q
      ? `COALESCE(
          (SELECT substr(json_extract(p2.data, '$.text'), 1, 300) FROM part p2
           WHERE p2.session_id = s.id AND json_extract(p2.data, '$.type') = 'text'
             AND json_extract(p2.data, '$.text') LIKE ?
           ORDER BY p2.time_created LIMIT 1),
          (SELECT substr(json_extract(p3.data, '$.text'), 1, 300) FROM part p3
           WHERE p3.session_id = s.id AND json_extract(p3.data, '$.type') = 'text'
           ORDER BY p3.time_created LIMIT 1),
          '')`
      : `COALESCE(
          (SELECT substr(json_extract(p2.data, '$.text'), 1, 300) FROM part p2
           WHERE p2.session_id = s.id AND json_extract(p2.data, '$.type') = 'text'
           ORDER BY p2.time_created LIMIT 1),
          '')`;
    const snippetParams = q ? [`%${q}%`] : [];

    const dataSql = `SELECT s.id, s.title, s.time_created, s.time_updated, s.directory, s.model, s.agent, s.parent_id,
      ${snippetExpr} as snippet
      FROM session s${whereSql}
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
      "SELECT DISTINCT directory FROM session ORDER BY directory;",
    ).all() as Record<string, unknown>[];
    return json({ home: process.env.HOME || "", dirs: rows.map((r) => r.directory) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

function exportSessionToFile(id: string, outFile: string): { ok: boolean; error?: string } {
  const r = Bun.spawnSync({
    cmd: ["sh", "-c", `opencode export ${shellQuote(id)} > ${shellQuote(outFile)} 2>/dev/null`],
  });
  if (r.exitCode !== 0) {
    return { ok: false, error: `export exited ${r.exitCode}` };
  }
  return { ok: true };
}

async function getSession(id: string): Promise<Response> {
  try {
    const tmp = `/tmp/oc-export-${crypto.randomUUID()}.json`;
    const ex = exportSessionToFile(id, tmp);
    if (!ex.ok) {
      try { Bun.unlinkSync(tmp); } catch {}
      return json({ error: ex.error ?? "export failed" }, 404);
    }
    const f = Bun.file(tmp);
    const exists = await f.exists();
    if (!exists) {
      return json({ error: "session not found" }, 404);
    }
    const text = await f.text();
    await f.unlink?.().catch(() => {});
    try {
      Bun.unlinkSync(tmp);
    } catch {}
    if (text.trim().length === 0) {
      return json({ error: "session not found" }, 404);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return json({ error: "export produced invalid JSON" }, 500);
    }
    return json(data);
  } catch (e) {
    return json({ error: String(e) }, 500);
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
    rewriteClone(data);

    for (const msg of data.messages ?? []) {
      for (const part of msg.parts ?? []) {
        if (part.type === "reasoning" && part.metadata) {
          delete part.metadata.anthropic;
        }
      }
    }

    const newId = data.info.id;

    tmp = `/tmp/oc-import-${crypto.randomUUID()}.json`;
    await Bun.write(tmp, JSON.stringify(data));

    let cwd: string | undefined;
    try {
      const db = await sqlite(dbPath());
      const row = db.prepare("SELECT directory FROM session WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      const dir = row?.directory;
      if (typeof dir === "string" && dir.length > 0) cwd = dir;
    } catch {}

    const r = Bun.spawnSync({
      cmd: ["opencode", "import", tmp],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      const err = (r.stderr?.toString() ?? "") + (r.stdout?.toString() ?? "");
      return json({ error: `import failed: ${err.slice(0, 500)}` }, 500);
    }
    return json({ id: newId, title: data.info.title ?? "" });
  } catch (e) {
    return json({ error: String(e) }, 500);
  } finally {
    if (tmp) {
      try {
        await Bun.unlink(tmp);
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

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
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
  const { sessionId: sid } = parseArgs();
  const s = startServer(PORT);
  const url = sid ? `http://127.0.0.1:${s.port}/?session=${encodeURIComponent(sid)}` : `http://127.0.0.1:${s.port}/`;
  console.log(`Session editor running at ${url}`);
  if (sid) console.log(`Editing session: ${sid}`);
  openBrowser(url);
}
