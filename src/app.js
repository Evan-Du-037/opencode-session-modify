"use strict";

/* ========== Config ========== */
const MOCK = false;
const PAGE_SIZE = 20;

const AGENT_STYLES = {
  build:    { letter: "B", color: "#4a9eff" },
  plan:     { letter: "P", color: "#b480d4" },
  general:  { letter: "G", color: "#d4a04a" },
  research: { letter: "R", color: "#4ec9a8" },
};

/* ========== State ========== */
const state = {
  view: "list",
  sessions: [],
  session: null,
  originalMessages: null,
  originalTitle: "",
  clonedId: null,
  loading: false,
  loadingMore: false,
  total: 0,
  page: 0,
  filter: { q: "", dir: "", includeSub: false },
  dirs: [],
};

let HOME_DIR = "";
let listContainer = null;
let scrollObserver = null;
let searchTimer = null;
// Keep tool drafts and disclosure state outside the exported session data.
const toolDrafts = new WeakMap();
const toolViews = new WeakMap();

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

/* ========== DOM helpers ========== */
let toastTimer = null;
function toast(msg, kind) {
  toastEl.textContent = msg;
  toastEl.className = "show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ""; }, 3500);
}

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) { for (const k of kid) { if (k) e.appendChild(k); } continue; }
    if (typeof kid === "string" || typeof kid === "number") e.appendChild(document.createTextNode(String(kid)));
    else e.appendChild(kid);
  }
  return e;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function highlight(text, keyword) {
  if (!keyword || !text) return esc(text);
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase();
  const parts = [];
  let lastIdx = 0;
  let idx = lower.indexOf(kw);
  while (idx !== -1) {
    if (idx > lastIdx) parts.push(esc(text.slice(lastIdx, idx)));
    parts.push("<mark>" + esc(text.slice(idx, idx + kw.length)) + "</mark>");
    lastIdx = idx + kw.length;
    idx = lower.indexOf(kw, lastIdx);
  }
  if (lastIdx < text.length) parts.push(esc(text.slice(lastIdx)));
  return parts.join("");
}

/* ========== Format helpers ========== */
function shortDir(d) {
  if (!d) return "";
  if (HOME_DIR && d.startsWith(HOME_DIR)) return "~" + d.slice(HOME_DIR.length);
  const parts = d.split("/");
  if (parts.length > 4) return "…/" + parts.slice(-3).join("/");
  return d;
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function fmtRelative(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + "分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "小时前";
  const d = Math.floor(h / 24);
  if (d < 30) return d + "天前";
  return fmtTime(ts).slice(0, 10);
}

function agentIcon(agent) {
  const s = AGENT_STYLES[agent];
  if (s) return s;
  return { letter: (agent || "?")[0].toUpperCase(), color: "#888" };
}

function ulid() {
  const ENCODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = Date.now(), time = "";
  for (let i = 0; i < 10; i++) { time = ENCODE[t % 32] + time; t = Math.floor(t / 32); }
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ENCODE[arr[i] % 32];
  return time + rand;
}

/* ========== API ========== */
async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body != null) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch (_) {}
    throw new Error("HTTP " + res.status + " " + (detail || res.statusText));
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  return await res.text();
}

function buildFilterParams(offset) {
  const p = new URLSearchParams();
  if (state.filter.q) p.set("q", state.filter.q);
  if (state.filter.dir) p.set("dir", state.filter.dir);
  if (state.filter.includeSub) p.set("includeSub", "1");
  p.set("limit", String(PAGE_SIZE));
  if (offset) p.set("offset", String(offset));
  return p.toString();
}

async function loadSessions() {
  state.loading = true;
  state.sessions = [];
  state.page = 0;
  updateSessionList();
  try {
    let data;
    if (MOCK) {
      data = { sessions: mockSessionList(), total: 2 };
    } else {
      data = await api("GET", "/api/sessions?" + buildFilterParams(0));
    }
    state.sessions = data.sessions || [];
    state.total = data.total || 0;
  } catch (e) {
    toast("加载失败: " + e.message, "err");
    state.sessions = [];
  }
  state.loading = false;
  updateSessionList();
}

async function loadMore() {
  if (state.loadingMore || state.sessions.length >= state.total) return;
  if (state.view !== "list") return;
  state.loadingMore = true;
  updateLoadMoreIndicator();
  const offset = state.sessions.length;
  try {
    const data = await api("GET", "/api/sessions?" + buildFilterParams(offset));
    state.sessions.push(...(data.sessions || []));
    state.total = data.total || state.total;
  } catch (e) {
    toast("加载更多失败: " + e.message, "err");
  }
  state.loadingMore = false;
  appendSessionItems();
}

async function loadDirs() {
  try {
    const data = await api("GET", "/api/dirs");
    if (data && Array.isArray(data.dirs)) {
      state.dirs = data.dirs;
      HOME_DIR = data.home || "";
    }
  } catch {}
}

/* ========== Render ========== */
function render({ preserveEditorScroll = false } = {}) {
  const scrollPosition = preserveEditorScroll ? captureEditorScroll() : null;
  app.innerHTML = "";
  const editorMode = state.view === "editor";
  app.style.maxWidth = editorMode ? "100%" : "900px";
  app.style.padding = editorMode ? "0" : "16px";
  if (state.view === "list") renderList();
  else renderEditor(scrollPosition);
}

function renderList() {
  app.innerHTML = "";
  const h1 = el("h1", { text: "opencode Session Editor" });
  const refresh = el("button", { onclick: () => loadSessions(), text: "刷新" });
  app.appendChild(el("div", { class: "topbar" }, h1, refresh));
  app.appendChild(buildFilterBar());

  listContainer = el("div", { class: "session-list" });
  app.appendChild(listContainer);
  updateSessionList();
}

function buildFilterBar() {
  const searchInput = el("input", {
    type: "search", placeholder: "搜索标题和内容…",
    value: state.filter.q,
  });
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filter.q = searchInput.value.trim();
      loadSessions();
    }, 350);
  });

  const dirBtn = el("button", {
    class: "dir-btn",
    onclick: () => openDirPicker(),
  }, el("span", { text: state.filter.dir ? shortDir(state.filter.dir) : "所有目录" }));

  const subCb = el("input", { type: "checkbox" });
  subCb.checked = state.filter.includeSub;
  subCb.addEventListener("change", () => {
    state.filter.includeSub = subCb.checked;
    loadSessions();
  });

  return el("div", { class: "filter-bar" }, searchInput, dirBtn,
    el("label", {}, subCb, "包含子对话"));
}

function renderSessionItem(s) {
  const kw = state.filter.q;
  const icon = agentIcon(s.agent);

  const iconEl = el("div", {
    class: "agent-icon",
    text: icon.letter,
    style: { color: icon.color, borderColor: icon.color, backgroundColor: icon.color + "22" },
  });

  const titleHtml = highlight(s.title || "(未命名)", kw);

  const metaParts = [];
  if (s.directory) metaParts.push(el("span", { class: "s-dir", text: shortDir(s.directory) }));
  if (s.model) metaParts.push(el("span", { class: "s-model", text: s.model }));
  if (s.sub) metaParts.push(el("span", { class: "s-sub-tag", text: "sub" }));
  metaParts.push(el("span", { text: fmtRelative(s.time.updated || s.time.created) }));

  const snippetHtml = s.snippet ? highlight(s.snippet, kw) : "";

  return el("div", {
    class: "session-item",
    onclick: () => openSession(s.id),
  }, iconEl,
    el("div", { class: "s-content" },
      el("div", { class: "s-header" },
        el("div", { class: "s-title", html: titleHtml }),
        el("div", { class: "s-meta" }, ...metaParts),
      ),
      snippetHtml ? el("div", { class: "s-snippet", html: snippetHtml }) : null,
    ),
  );
}

function updateSessionList() {
  if (!listContainer) return;
  listContainer.innerHTML = "";

  if (state.loading) {
    listContainer.appendChild(el("div", { class: "loading" },
      el("span", { class: "spinner" }), " 加载中…"));
    return;
  }
  if (!state.sessions.length) {
    listContainer.appendChild(el("div", { class: "empty" }, "无匹配会话"));
    return;
  }
  for (const s of state.sessions) {
    listContainer.appendChild(renderSessionItem(s));
  }
  appendLoadMoreZone();
}

function appendSessionItems() {
  if (state.view !== "list" || !listContainer || !document.body.contains(listContainer)) return;
  const zone = document.getElementById("load-more-zone");
  if (zone) zone.remove();
  const startIdx = listContainer.children.length;
  const newCount = state.sessions.length - startIdx;
  for (let i = startIdx; i < state.sessions.length; i++) {
    listContainer.appendChild(renderSessionItem(state.sessions[i]));
  }
  appendLoadMoreZone();
}

function appendLoadMoreZone() {
  const zone = el("div", { id: "load-more-zone" });
  if (state.sessions.length >= state.total) {
    if (state.total > 0) {
      zone.appendChild(el("div", { class: "no-more", text: `共 ${state.total} 条，已全部加载` }));
    }
  } else {
    if (state.loadingMore) {
      zone.appendChild(el("div", { class: "load-more-spin" },
        el("span", { class: "spinner" }), " 加载更多…"));
    } else {
      const sentinel = el("div", { id: "scroll-sentinel", style: { height: "1px" } });
      zone.appendChild(sentinel);
      setupInfiniteScroll(sentinel);
    }
  }
  listContainer.appendChild(zone);
}

function updateLoadMoreIndicator() {
  const zone = document.getElementById("load-more-zone");
  if (!zone) return;
  zone.innerHTML = "";
  if (state.loadingMore) {
    zone.appendChild(el("div", { class: "load-more-spin" },
      el("span", { class: "spinner" }), " 加载更多…"));
  }
}

function setupInfiniteScroll(sentinel) {
  if (scrollObserver) scrollObserver.disconnect();
  scrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !state.loadingMore && state.sessions.length < state.total) {
      loadMore();
    }
  }, { rootMargin: "300px" });
  scrollObserver.observe(sentinel);
}

/* ========== Directory picker ========== */
function openDirPicker() {
  const existing = document.getElementById("modal-overlay");
  if (existing) existing.remove();

  const overlay = el("div", { id: "modal-overlay", class: "modal-overlay" });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = el("div", { class: "modal" });
  modal.appendChild(el("div", { class: "modal-title", text: "选择目录" }));

  const input = el("input", {
    type: "text",
    placeholder: "输入目录路径，Tab 补全…",
    class: "dir-input",
    value: state.filter.dir,
  });

  const suggestionsBox = el("div", { class: "dir-suggestions" });
  let selectedIdx = -1;
  let currentMatches = [];

  function updateSuggestions() {
    const val = input.value.toLowerCase().trim();
    currentMatches = state.dirs.filter(d => d.toLowerCase().includes(val));
    selectedIdx = -1;
    suggestionsBox.innerHTML = "";
    if (!currentMatches.length) {
      suggestionsBox.style.display = "none";
      return;
    }
    suggestionsBox.style.display = "block";
    currentMatches.slice(0, 50).forEach((d, i) => {
      const item = el("div", {
        class: "dir-suggestion",
        text: shortDir(d),
        title: d,
      });
      item.addEventListener("click", () => {
        input.value = d;
        updateSuggestions();
        input.focus();
      });
      suggestionsBox.appendChild(item);
    });
  }

  input.addEventListener("input", updateSuggestions);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      if (currentMatches.length) {
        const match = currentMatches[0];
        input.value = match;
        updateSuggestions();
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, currentMatches.length - 1);
      highlightSuggestion();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      highlightSuggestion();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = selectedIdx >= 0 ? currentMatches[selectedIdx] : input.value.trim();
      confirmDir(chosen);
    } else if (e.key === "Escape") {
      overlay.remove();
    }
  });

  function highlightSuggestion() {
    [...suggestionsBox.children].forEach((c, i) => {
      c.classList.toggle("selected", i === selectedIdx);
    });
    const sel = suggestionsBox.children[selectedIdx];
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function confirmDir(dir) {
    state.filter.dir = dir;
    overlay.remove();
    render();
    loadSessions();
  }

  modal.appendChild(input);
  modal.appendChild(suggestionsBox);

  const btnRow = el("div", { class: "modal-actions" });
  btnRow.appendChild(el("button", {
    onclick: async () => {
      const dir = await browseSystemDir();
      if (dir) { input.value = dir; updateSuggestions(); input.focus(); }
    },
    text: "浏览…",
  }));
  btnRow.appendChild(el("button", {
    onclick: () => { input.value = ""; updateSuggestions(); input.focus(); },
    text: "清除",
  }));
  btnRow.appendChild(el("div", { style: { flex: "1" } }));
  btnRow.appendChild(el("button", {
    onclick: () => overlay.remove(),
    text: "取消",
  }));
  btnRow.appendChild(el("button", {
    class: "primary",
    onclick: () => confirmDir(input.value.trim()),
    text: "确定",
  }));
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  input.focus();
  updateSuggestions();
}

async function browseSystemDir() {
  if (window.desktop) return window.desktop.pickDirectory();
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const handle = await window.showDirectoryPicker();
      return matchDirName(handle.name);
    } catch (e) { return null; }
  }
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.addEventListener("change", () => {
      if (input.files.length > 0) {
        const rel = input.files[0].webkitRelativePath || "";
        const folderName = rel.split("/")[0];
        resolve(matchDirName(folderName));
      } else { resolve(null); }
    });
    input.click();
  });
}

function matchDirName(name) {
  const matches = state.dirs.filter(d => d === name || d.endsWith("/" + name));
  if (matches.length === 1) return matches[0];
  return name;
}

/* ========== Session open / save ========== */
async function openSession(id) {
  state.loading = true;
  state.view = "editor";
  render();
  try {
    const data = MOCK ? mockSession() : await api("GET", "/api/session/" + encodeURIComponent(id));
    state.session = data;
    state.originalMessages = JSON.parse(JSON.stringify(data.messages || []));
    state.originalTitle = (data.info && data.info.title) || "";
  } catch (e) {
    toast("加载会话失败: " + e.message, "err");
    state.session = null;
    state.originalMessages = null;
    state.view = "list";
    state.loading = false;
    render();
    return;
  }
  state.loading = false;
  try {
    render();
  } catch (e) {
    console.error("渲染会话失败:", e);
    app.innerHTML = "";
    app.appendChild(el("div", { class: "empty" },
      "渲染错误: " + e.message + "\n请打开控制台查看详情"));
  }
}

/* ========== Diff computation ========== */
function hashMessage(msg) {
  const role = (msg.info && msg.info.role) || "?";
  const text = (msg.parts || []).map(p => {
    if (p.type === "tool") return "\x01tool:" + (p.tool || "") + JSON.stringify(p.state || {});
    if (p.type === "reasoning") return "\x01reasoning:" + (p.text || "");
    return p.text || "";
  }).join("\n");
  return role + "\n" + text;
}

function computeLCS(a, b, eq) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (eq(a[i], b[j])) { out.push({ t: 0, a: a[i], b: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 1, a: a[i] }); i++; }
    else { out.push({ t: 2, b: b[j] }); j++; }
  }
  while (i < m) out.push({ t: 1, a: a[i++] });
  while (j < n) out.push({ t: 2, b: b[j++] });
  return out;
}

function diffMessages(original, current) {
  if (!original) original = [];
  if (!current) current = [];
  // Tool outputs can be large: serialize each message once, not per LCS cell.
  const originalHashes = new Map(original.map(msg => [msg, hashMessage(msg)]));
  const currentHashes = new Map(current.map(msg => [msg, hashMessage(msg)]));
  const raw = computeLCS(original, current, (a, b) => originalHashes.get(a) === currentHashes.get(b));
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].t === 1 && i + 1 < raw.length && raw[i + 1].t === 2) {
      const oR = (raw[i].a.info && raw[i].a.info.role) || "";
      const cR = (raw[i + 1].b.info && raw[i + 1].b.info.role) || "";
      if (oR === cR) { out.push({ type: "modified", original: raw[i].a, current: raw[i + 1].b }); i++; continue; }
    }
    if (raw[i].t === 0) out.push({ type: "equal", original: raw[i].a, current: raw[i].b });
    else if (raw[i].t === 1) out.push({ type: "removed", original: raw[i].a, current: null });
    else out.push({ type: "added", original: null, current: raw[i].b });
  }
  return out;
}

function diffTextLines(origText, currText) {
  const ol = (origText || "").split("\n");
  const cl = (currText || "").split("\n");
  const raw = computeLCS(ol, cl, (a, b) => a === b);
  return raw.map(r => {
    if (r.t === 0) return { type: "equal", orig: r.a, curr: r.b };
    if (r.t === 1) return { type: "removed", orig: r.a, curr: null };
    return { type: "added", orig: null, curr: r.b };
  });
}

/* ========== Diff editor ========== */
const GUTTER_COLORS = { user: "#4a9eff", assistant: "#d4a04a" };

function autoResize(ta) {
  if (ta.classList.contains("tool-edit") && !ta.getClientRects().length) return;
  ta.style.height = "auto";
  ta.style.height = Math.max(ta.scrollHeight, 20) + "px";
}

function toolSummary(p) {
  const s = p.state && p.state.status;
  const icon = s === "completed" ? "\u2713" : s === "error" ? "\u2715" : s === "running" ? "\u21bb" : "\u00b7";
  return "\u2699 " + (p.tool || "?") + " " + icon;
}

function toolErrors() {
  return (state.session?.messages || []).flatMap(msg => (msg.parts || [])
    .flatMap(part => [...(toolDrafts.get(part)?.values() || [])].filter(draft => draft.error)));
}

let minimapFrame = null;
function refreshMinimap() {
  cancelAnimationFrame(minimapFrame);
  minimapFrame = requestAnimationFrame(() => {
    const container = document.getElementById("diff-scroll");
    const minimap = document.getElementById("diff-minimap");
    if (container && minimap) buildMinimap(container, minimap);
  });
}

function renderTool(part, msg, original, side) {
  const data = part.state || {};
  let views = toolViews.get(part);
  if (!views) { views = {}; toolViews.set(part, views); }
  const view = views[side] ||= { open: false, fields: {} };
  const tool = el("details", { class: "tool-block" });
  tool.dataset.partId = part.id || "";
  tool.open = view.open;
  tool.appendChild(el("summary", { class: "tool-line", text: toolSummary(part) }));
  const body = el("div", { class: "tool-body" });
  let populated = false;

  function addField(key, label) {
    const value = data[key];
    const json = key === "input" || (value != null && typeof value !== "string");
    const field = el("details", { class: "tool-field" });
    field.dataset.field = key;
    field.open = !!view.fields[key];
    const summary = el("summary", { text: label + (json ? " · JSON" : " · 文本") });
    field.appendChild(summary);
    let area;
    function populateField() {
      if (area) return;
      const draft = side === "right" ? toolDrafts.get(part)?.get(key) : null;
      area = el("textarea", {
        class: "tool-edit", "aria-label": label + (side === "left" ? "（原始，只读）" : "（修改）"),
        spellcheck: "false",
      });
      area.dataset.field = key;
      area.readOnly = side === "left";
      let text = json ? JSON.stringify(value, null, 2) : (value ?? "");
      // JSON returned as text remains a string in the saved tool result.
      if (!json && typeof text === "string") {
        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
      }
      area.value = draft ? draft.text : (text ?? "{}");
      const error = el("div", { class: "tool-error", role: "alert" });
      function showError(message) {
        area.classList.toggle("err", !!message);
        area.setAttribute("aria-invalid", String(!!message));
        error.textContent = message || "";
        error.hidden = !message;
        summary.classList.toggle("invalid", !!message);
      }
      showError(draft?.error);
      if (side === "right") {
        area.addEventListener("input", () => {
          let drafts = toolDrafts.get(part);
          if (!drafts) { drafts = new Map(); toolDrafts.set(part, drafts); }
          const draft = { text: area.value, error: "" };
          try {
            const parsed = json ? JSON.parse(area.value) : area.value;
            if (key === "input" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
              throw new Error("工具输入必须是 JSON 对象");
            }
            data[key] = parsed;
          } catch (e) {
            draft.error = "格式错误：" + e.message;
          }
          drafts.set(key, draft);
          showError(draft.error);
          autoResize(area);
          refreshRow(tool, original, msg);
          refreshMinimap();
        });
      }
      field.appendChild(area);
      field.appendChild(error);
    }
    field.addEventListener("toggle", () => {
      view.fields[key] = field.open;
      if (field.open) { populateField(); autoResize(area); }
      refreshMinimap();
    });
    if (field.open) populateField();
    body.appendChild(field);
  }

  function populate() {
    if (populated) return;
    populated = true;
    if (Object.hasOwn(data, "input")) addField("input", "工具输入");
    if (Object.hasOwn(data, "output") || data.status === "completed") addField("output", "工具输出");
    if (Object.hasOwn(data, "error")) addField("error", "工具错误（输出）");
    if (!body.children.length) body.appendChild(el("div", { class: "other-line", text: "尚无工具输入或输出" }));
  }
  tool.addEventListener("toggle", () => {
    view.open = tool.open;
    if (tool.open) {
      populate();
      body.querySelectorAll("textarea").forEach(autoResize);
    }
    refreshMinimap();
  });
  if (tool.open) populate();
  tool.appendChild(body);
  return tool;
}

function hasChanges() {
  if (!state.session || !state.originalMessages) return false;
  if (toolErrors().length) return true;
  const title = (state.session.info && state.session.info.title) || "";
  if (title !== state.originalTitle) return true;
  return JSON.stringify(state.session.messages || []) !== JSON.stringify(state.originalMessages);
}

function updateSaveBtn() {
  const btn = document.getElementById("save-btn");
  if (btn) btn.disabled = !hasChanges();
}

function captureEditorScroll() {
  const container = document.getElementById("diff-scroll");
  if (!container) return null;
  const top = container.getBoundingClientRect().top;
  const headerHeight = container.querySelector(".diff-header").offsetHeight;
  // Keep nearby messages at the same screen position even if earlier rows
  // change height. The next row is a fallback if a newly added row is deleted.
  const anchors = [...container.querySelectorAll(".diff-row")]
    .filter(row => row.getBoundingClientRect().bottom > top + headerHeight)
    .slice(0, 2)
    .map(row => ({
      id: row.dataset.messageId,
      current: row.dataset.current === "true",
      offset: row.getBoundingClientRect().top - top,
    }));
  return { scrollTop: container.scrollTop, anchors };
}

function restoreEditorScroll(container, position) {
  if (!position) return;
  const rows = [...container.querySelectorAll(".diff-row")];
  const top = container.getBoundingClientRect().top;
  const headerHeight = container.querySelector(".diff-header").offsetHeight;
  for (const anchor of position.anchors) {
    const matches = rows.filter(row => anchor.id && row.dataset.messageId === anchor.id);
    const row = matches.find(row => (row.dataset.current === "true") === anchor.current) || matches[0];
    if (!row) continue;
    // If a tall message shrinks, keep its remaining content in view.
    const offset = Math.max(anchor.offset, headerHeight - row.offsetHeight + 1);
    container.scrollTop += row.getBoundingClientRect().top - top - offset;
    return;
  }
  container.scrollTop = position.scrollTop;
}

function renderEditor(scrollPosition = null) {
  if (state.loading) {
    app.appendChild(el("div", { class: "loading" },
      el("span", { class: "spinner" }), " \u52a0\u8f7d\u4e2d\u2026"));
    return;
  }
  if (!state.session) {
    app.appendChild(el("div", { class: "empty" }, "\u65e0\u6570\u636e"));
    return;
  }
  const info = state.session.info || {};
  const layout = el("div", { class: "diff-layout" });

  const back = el("button", {
    onclick: () => { state.session = null; state.originalMessages = null; state.view = "list"; render(); },
  }, "\u2190 \u8fd4\u56de");
  const titleInput = el("input", { class: "title", value: info.title || "", placeholder: "\u4f1a\u8bdd\u6807\u9898" });
  titleInput.addEventListener("input", () => { info.title = titleInput.value; updateSaveBtn(); });
  const copyLatestBtn = el("button", { id: "copy-latest-btn", onclick: copyLatestTurn }, "\u590d\u5236\u6700\u8fd1\u4e00\u8f6e");
  const copyAllBtn = el("button", { id: "copy-all-btn", onclick: copySession }, "\u590d\u5236\u5168\u90e8");
  const saveBtn = el("button", { id: "save-btn", class: "primary", onclick: saveAs }, "\u53e6\u5b58\u4e3a\u65b0\u4f1a\u8bdd");
  saveBtn.disabled = !hasChanges();
  layout.appendChild(el("div", { class: "diff-topbar" }, back, titleInput,
    el("div", { style: { flex: "1" } }), copyLatestBtn, copyAllBtn, saveBtn));

  const msgs = state.session.messages || [];
  const diff = diffMessages(state.originalMessages, msgs);
  const container = el("div", { class: "diff-container", id: "diff-scroll" });
  container.appendChild(el("div", { class: "diff-header" },
    el("div", { class: "diff-gutter-spacer" }),
    el("div", { class: "diff-col-label", text: "\u539f\u59cb\uff08\u53ea\u8bfb\uff09" }),
    el("div", { class: "diff-col-label", text: "\u4fee\u6539" }),
    el("div", { class: "diff-gutter-spacer" }),
  ));
  for (const entry of diff) container.appendChild(renderDiffRow(entry));
  container.appendChild(el("div", { class: "diff-add-zone" },
    el("button", { onclick: () => addMessageAt(msgs.length) }, "+ \u6dfb\u52a0\u6d88\u606f")));

  const minimap = el("div", { class: "diff-minimap", id: "diff-minimap" });
  const body = el("div", { class: "diff-body" }, container, minimap);
  layout.appendChild(body);
  app.appendChild(layout);

  requestAnimationFrame(() => {
    if (!container.isConnected) return;
    container.querySelectorAll("textarea").forEach(autoResize);
    restoreEditorScroll(container, scrollPosition);
    buildMinimap(container, minimap);
    setupMinimapInteraction(container, minimap);
    container.addEventListener("scroll", () => {
      const vp = minimap.querySelector(".minimap-viewport");
      if (vp) updateMinimapViewport(container, minimap, vp);
    });
  });
}

function renderDiffRow(entry) {
  const { type, original, current } = entry;
  const msg = current || original;
  const role = (msg && msg.info && msg.info.role) || "user";
  const gutterColor = GUTTER_COLORS[role] || "#888";
  const row = el("div", { class: "diff-row " + type });
  row.dataset.messageId = msg.info?.id || "";
  row.dataset.current = String(!!current);

  const gutter = el("div", { class: "diff-gutter", style: { background: gutterColor } });
  if (current) {
    gutter.title = role + " \u2014 \u70b9\u51fb\u5207\u6362";
    gutter.style.cursor = "pointer";
    gutter.addEventListener("click", () => toggleRole(current));
  }

  const leftCell = el("div", { class: "diff-cell left" });
  if (original) renderCellSegments(leftCell, original, current, "left");
  else leftCell.appendChild(el("div", { class: "diff-placeholder" }));

  const rightCell = el("div", { class: "diff-cell right" });
  if (current) {
    renderCellSegments(rightCell, current, original, "right");
  } else rightCell.appendChild(el("div", { class: "diff-placeholder" }));

  const delGutter = el("div", { class: "diff-delete-gutter" });
  if (current) {
    delGutter.classList.add("clickable");
    delGutter.title = "删除此消息";
    delGutter.addEventListener("click", () => deleteMessage(current));
  }

  row.appendChild(gutter);
  row.appendChild(leftCell);
  row.appendChild(rightCell);
  row.appendChild(delGutter);
  return row;
}

function renderCellSegments(cell, myMsg, otherMsg, side) {
  const myParts = myMsg.parts || [];
  const otherParts = otherMsg ? (otherMsg.parts || []) : [];
  const otherMap = new Map();
  for (const op of otherParts) if (op.id) otherMap.set(op.id, op);

  for (let i = 0; i < myParts.length; i++) {
    const p = myParts[i];
    if (p.type === "step-start" || p.type === "step-finish") continue;
    const op = p.id ? otherMap.get(p.id) : otherParts[i];
    if (p.type === "text" || !p.type) {
      const myText = p.text || "";
      const otherText = op ? (op.text || "") : "";
      if (side === "left") {
        const lineDiff = diffTextLines(myText, otherText);
        const block = el("div", { class: "text-diff-block" });
        for (const ld of lineDiff) {
          if (ld.type === "equal") block.appendChild(el("div", { class: "diff-line equal", text: ld.orig }));
          else if (ld.type === "removed") block.appendChild(el("div", { class: "diff-line removed", text: ld.orig }));
          else block.appendChild(el("div", { class: "diff-line placeholder" }));
        }
        cell.appendChild(block);
      } else {
        const ta = el("textarea", { class: "text-edit", placeholder: "（空）" });
        ta.value = myText;
        ta.addEventListener("input", () => { p.text = ta.value; autoResize(ta); updateSaveBtn(); });
        ta.addEventListener("blur", () => refreshRow(cell, otherMsg, myMsg));
        cell.appendChild(ta);
      }
    } else if (p.type === "tool") {
      cell.appendChild(renderTool(p, myMsg, otherMsg, side));
    } else if (p.type === "reasoning") {
      if (side === "right") {
        const wrap = el("div", { class: "reasoning-wrap" });
        const ta = el("textarea", { class: "text-edit reasoning", placeholder: "推理内容" });
        ta.value = p.text || "";
        ta.addEventListener("input", () => { p.text = ta.value; autoResize(ta); updateSaveBtn(); });
        ta.addEventListener("blur", () => refreshRow(cell, otherMsg, myMsg));
        wrap.appendChild(ta);
        wrap.appendChild(el("button", {
          class: "del-reasoning-btn",
          title: "删除此推理",
          onclick: (e) => { e.stopPropagation(); deletePart(myMsg, i); },
        }, "− think"));
        cell.appendChild(wrap);
      } else {
        cell.appendChild(el("div", { class: "reasoning-line", text: p.text || "" }));
      }
    } else {
      cell.appendChild(el("div", { class: "other-line", text: "[" + (p.type || "?") + "]" }));
    }
  }

  if (side === "right") {
    cell.appendChild(el("button", {
      class: "add-reasoning-btn",
      title: "添加推理部分",
      onclick: () => addReasoning(myMsg),
    }, "+ think"));
  }
}

/* ========== Editor operations ========== */
function refreshRow(cell, original, current) {
  const row = cell.closest(".diff-row");
  if (!row) return;
  let newType;
  if (!original) newType = "added";
  else if (!current) newType = "removed";
  else newType = hashMessage(original) === hashMessage(current) ? "equal" : "modified";
  row.className = "diff-row " + newType;
  const leftCell = row.querySelector(".diff-cell.left");
  if (leftCell) {
    leftCell.innerHTML = "";
    if (original) renderCellSegments(leftCell, original, current, "left");
    else leftCell.appendChild(el("div", { class: "diff-placeholder" }));
  }
  const gutter = row.querySelector(".diff-gutter");
  const msg = current || original;
  const role = (msg && msg.info && msg.info.role) || "user";
  if (gutter) gutter.style.background = GUTTER_COLORS[role] || "#888";
  updateSaveBtn();
}

/* ========== Minimap ========== */
let mmDragHandler = null;
let mmUpHandler = null;

function buildMinimap(container, minimap) {
  minimap.innerHTML = "";
  const rows = [...container.querySelectorAll(".diff-row")];
  if (!rows.length) { minimap.style.display = "none"; return; }
  minimap.style.display = "";
  const heights = rows.map(r => r.offsetHeight);
  const totalH = container.scrollHeight;
  const mmH = minimap.clientHeight || 400;
  const scale = mmH / totalH;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const bar = el("div", { class: "minimap-bar" });
    bar.style.height = Math.max(2, heights[i] * scale) + "px";
    const gutter = row.querySelector(".diff-gutter");
    if (gutter && gutter.style.background) bar.style.borderLeftColor = gutter.style.background;
    if (row.classList.contains("modified")) bar.classList.add("mm-modified");
    else if (row.classList.contains("added")) bar.classList.add("mm-added");
    else if (row.classList.contains("removed")) bar.classList.add("mm-removed");
    minimap.appendChild(bar);
  }
  const vp = el("div", { class: "minimap-viewport" });
  minimap.appendChild(vp);
  updateMinimapViewport(container, minimap, vp);
}

function updateMinimapViewport(container, minimap, vp) {
  const totalH = container.scrollHeight;
  const visH = container.clientHeight;
  if (totalH <= 0) return;
  const mmH = minimap.clientHeight;
  const scale = mmH / totalH;
  vp.style.top = (container.scrollTop * scale) + "px";
  vp.style.height = Math.max(10, visH * scale) + "px";
}

function setupMinimapInteraction(container, minimap) {
  if (mmDragHandler) document.removeEventListener("mousemove", mmDragHandler);
  if (mmUpHandler) document.removeEventListener("mouseup", mmUpHandler);
  let dragging = false;
  function scrollToY(clientY) {
    const rect = minimap.getBoundingClientRect();
    if (rect.height <= 0) return;
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const pct = y / rect.height;
    container.scrollTop = pct * container.scrollHeight - container.clientHeight / 2;
  }
  minimap.onmousedown = (e) => {
    e.preventDefault();
    dragging = true;
    scrollToY(e.clientY);
  };
  mmDragHandler = (e) => { if (dragging) scrollToY(e.clientY); };
  mmUpHandler = () => { dragging = false; };
  document.addEventListener("mousemove", mmDragHandler);
  document.addEventListener("mouseup", mmUpHandler);
}

function deleteMessage(msg) {
  const msgs = state.session.messages || [];
  const idx = msgs.indexOf(msg);
  if (idx < 0) return;
  msgs.splice(idx, 1);
  render({ preserveEditorScroll: true });
}

function _tmplInfo(role) {
  const msgs = state.session.messages || [];
  const existing = msgs.findLast(m => m.info?.role === role);
  if (existing) return { ...existing.info, id: "msg_" + ulid() };
  const now = Date.now();
  const sm = state.session.info?.model;
  const model = sm
    ? { providerID: sm.providerID, modelID: sm.id, ...(sm.variant ? { variant: sm.variant } : {}) }
    : { providerID: "zai-coding-plan", modelID: "glm-5.2" };
  if (role === "user") {
    return { id: "msg_" + ulid(), role: "user", time: { created: now }, agent: "build", model };
  }
  const lastUser = msgs.findLast(m => m.info?.role === "user");
  return {
    id: "msg_" + ulid(), role: "assistant",
    time: { created: now },
    parentID: lastUser?.info?.id || "",
    modelID: model.modelID, providerID: model.providerID,
    mode: "primary", agent: "build",
    path: { cwd: state.session.info?.directory || "", root: state.session.info?.directory || "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function addMessageAt(idx) {
  const msgs = state.session.messages || (state.session.messages = []);
  const info = _tmplInfo("user");
  msgs.splice(idx, 0, {
    info,
    parts: [{ id: "prt_" + ulid(), type: "text", text: "" }],
  });
  render({ preserveEditorScroll: true });
}

function toggleRole(msg) {
  const oldRole = msg.info?.role || "user";
  const newRole = oldRole === "user" ? "assistant" : "user";
  const tmpl = _tmplInfo(newRole);
  msg.info = { ...tmpl, id: msg.info?.id };
  render({ preserveEditorScroll: true });
}

function deletePart(msg, partIdx) {
  const parts = msg.parts || [];
  parts.splice(partIdx, 1);
  render({ preserveEditorScroll: true });
}

function addReasoning(msg) {
  const parts = msg.parts || (msg.parts = []);
  parts.unshift({ id: "prt_" + ulid(), type: "reasoning", text: "", time: { start: Date.now(), end: Date.now() } });
  render({ preserveEditorScroll: true });
}

function formatForCopy(messages) {
  const groups = [];
  for (const msg of messages) {
    const role = (msg.info && msg.info.role) || "user";
    const parts = msg.parts || [];
    const reasoning = parts
      .filter(p => p.type === "reasoning")
      .map(p => (p.text || "").trim())
      .filter(Boolean);
    const text = parts
      .filter(p => p.type === "text" || !p.type)
      .map(p => (p.text || "").trim())
      .filter(Boolean);
    const last = groups[groups.length - 1];
    if (last && last.role === role) {
      last.reasoning.push(...reasoning);
      last.text.push(...text);
    } else {
      groups.push({ role, reasoning, text });
    }
  }
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const reasoning = g.reasoning.join(" ");
    const text = g.text.join("\n");
    if (!reasoning && !text) continue;
    const prevRole = i > 0 ? groups[i - 1].role : null;
    if (out.length && !(prevRole === "user" && g.role === "assistant")) out.push("");
    if (g.role === "assistant") {
      if (reasoning && text) out.push(`assistant: (think: ${reasoning})\n${text}`);
      else if (reasoning) out.push(`assistant: (think: ${reasoning})`);
      else out.push(`assistant: ${text}`);
    } else {
      out.push(`user: ${text}`);
    }
  }
  return out.join("\n\n---------------------\n\n");
}

function latestTurnMessages(messages) {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (((messages[i].info || {}).role) === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return [];
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i > lastUserIdx; i--) {
    if (((messages[i].info || {}).role) === "assistant") { lastAssistantIdx = i; break; }
  }
  if (lastAssistantIdx === -1) return messages.slice(lastUserIdx, lastUserIdx + 1);
  return messages.slice(lastUserIdx, lastAssistantIdx + 1);
}

async function copyLatestTurn() {
  if (!state.session) return;
  const turn = latestTurnMessages(state.session.messages || []);
  if (!turn.length) { toast("没有找到最近一轮对话", "err"); return; }
  const text = formatForCopy(turn);
  if (!text) { toast("没有可复制的内容", "err"); return; }
  try {
    await copyText(text);
    toast("已复制最近一轮到剪贴板", "ok");
  } catch (e) {
    toast("复制失败: " + e.message, "err");
  }
}

async function copySession() {
  if (!state.session) return;
  const text = formatForCopy(state.session.messages || []);
  if (!text) { toast("没有可复制的内容", "err"); return; }
  try {
    await copyText(text);
    toast("已复制到剪贴板", "ok");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
    if (ok) toast("已复制到剪贴板", "ok");
    else toast("复制失败: " + e.message, "err");
  }
}

async function copyText(text) {
  if (window.desktop) return window.desktop.copyText(text);
  return navigator.clipboard.writeText(text);
}

async function saveAs() {
  if (!state.session) return null;
  if (toolErrors().length) {
    toast("工具内容存在格式错误，请修正后再保存", "err");
    for (const msg of state.session.messages || []) for (const part of msg.parts || []) {
      const invalid = [...(toolDrafts.get(part)?.entries() || [])].find(([, draft]) => draft.error);
      if (!invalid) continue;
      const tool = [...document.querySelectorAll(".diff-cell.right .tool-block")]
        .find(node => node.dataset.partId === (part.id || ""));
      if (tool) {
        tool.open = true;
        tool.dispatchEvent(new Event("toggle"));
        const field = [...tool.querySelectorAll(".tool-field")].find(node => node.dataset.field === invalid[0]);
        if (field) {
          field.open = true;
          field.dispatchEvent(new Event("toggle"));
          field.querySelector("textarea")?.focus();
        }
      }
      return null;
    }
    return null;
  }
  if (!hasChanges()) return state.clonedId;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + " " + pad(now.getHours()) + ":" + pad(now.getMinutes()) +  ":" + pad(now.getSeconds());
  const origTitle = (state.session.info && state.session.info.title) || "(未命名)";
  let newTitle = origTitle;
  const regex = /\s*\[编辑于\s*\d{2}-\d{2}\s*\d{2}:\d{2}:\d{2}\]/g;
  newTitle = newTitle.replace(regex, '').trim();
  const newInfo = { ...state.session.info, time: { created: state.session.info.time.created, updated: Date.now() }, title: newTitle + " [编辑于 " + ts + "]" };
  const payload = { info: newInfo, messages: state.session.messages };
  if (MOCK) { toast("已保存（mock）", "ok"); return "mock"; }
  const origId = (state.session.info && state.session.info.id) || "";
  try {
    const res = await api("POST", "/api/session/" + encodeURIComponent(origId) + "/clone", payload);
    state.clonedId = res.id;
    state.originalMessages = JSON.parse(JSON.stringify(state.session.messages || []));
    state.originalTitle = (state.session.info && state.session.info.title) || "";
    updateSaveBtn();
    toast("已保存为新会话：" + (res.title || res.id || ""), "ok");
    return res.id;
  } catch (e) {
    toast("保存失败: " + e.message, "err");
    return null;
  }
}

/* ========== Mock data ========== */
function mockSessionList() {
  const now = Date.now();
  return [
    { id: "ses_m1", title: "调试 read 工具", time: { created: now - 3600000, updated: now - 1800000 },
      directory: "/Users/evan/Tools/opencode-session-modify", model: "glm-5.2", agent: "build",
      snippet: "帮我读一下 src/index.ts 文件，看看里面的导出结构" },
    { id: "ses_m2", title: "重构 parser", time: { created: now - 86400000, updated: now - 80000000 },
      directory: "/Users/evan/Code/projects/my-ai", model: "glm-5.2", agent: "research", sub: true,
      snippet: "我需要重构一下 parser 模块，目前的实现太慢了" },
  ];
}
function mockSession() {
  return {
    info: { id: "ses_m1", title: "调试 read 工具", time: { created: new Date(Date.now() - 3600000).toISOString(), updated: new Date(Date.now() - 1800000).toISOString() }, model: { providerID: "zai", modelID: "glm-5.2" }, agent: "build" },
    messages: [
      { info: { id: "msg_1", role: "user", sessionID: "ses_m1", time: { created: new Date(Date.now() - 3500000).toISOString() } },
        parts: [{ id: "prt_u1", type: "text", text: "帮我读一下 src/index.ts" }] },
      { info: { id: "msg_2", role: "assistant", sessionID: "ses_m1", time: { created: new Date(Date.now() - 3400000).toISOString() } },
        parts: [
          { id: "prt_r1", type: "reasoning", text: "用户要读文件，调用 read 工具。" },
          { id: "prt_t1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/tmp/x.ts" }, output: "export function hello() { return 'world'; }" } },
          { id: "prt_a1", type: "text", text: "已读取文件。" },
        ] },
    ],
  };
}

/* ========== Boot ========== */
window.addEventListener("beforeunload", event => {
  if (!hasChanges()) return;
  event.preventDefault();
  event.returnValue = "";
});

if (MOCK) {
  state.sessions = mockSessionList();
  state.total = state.sessions.length;
  render();
} else {
  const params = new URLSearchParams(location.search);
  const deepSession = params.get("session");
  if (deepSession) {
    openSession(deepSession);
  } else {
    loadDirs().then(() => { state.view = "list"; render(); loadSessions(); });
  }
}
