#!/bin/bash
set -euo pipefail

# ============================================================
# install.sh — Install ocedit + patch opencode
#
# Part 1: Create the `ocedit` command wrapper
# Part 2: Patch opencode binary with /continue endpoint
#         and install /edit, /continue TUI slash commands
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
SERVER_TS="$PROJECT_DIR/src/server.ts"

# --- opencode patch config ---
OPCODE_SRC="$HOME/.opencode/src"
OPCODE_BIN="$HOME/.opencode/bin/opencode"
OPCODE_BACKUP="$HOME/.opencode/bin/opencode.orig"
PLUGIN_DIR="$HOME/.config/opencode/plugins"
PLUGIN_FILE="$PLUGIN_DIR/ocedit.ts"
OPCODE_VERSION="v1.18.4"
OPCODE_REPO="https://github.com/anomalyco/opencode.git"

export PATH="$HOME/.bun/bin:$PATH"

# --- Helpers ---
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BOLD=$'\033[1m'; NC=$'\033[0m'
info()  { echo "${GREEN}==>${NC} $1"; }
warn()  { echo "${YELLOW}!!${NC}  $1"; }
error() { echo "${RED}ERROR:${NC} $1" >&2; }
die()   { error "$1"; exit 1; }

# ============================================================
# _patch_opencode — clone, patch, build, install
# ============================================================
_patch_opencode() {
  # --- Clone source ---
  info "Cloning opencode ${OPCODE_VERSION} ..."
  if [ -d "$OPCODE_SRC/.git" ]; then
    info "Source exists, resetting ..."
    cd "$OPCODE_SRC"
    git checkout -- .
    git checkout "$OPCODE_VERSION" 2>/dev/null || die "Cannot checkout ${OPCODE_VERSION}"
  else
    mkdir -p "$(dirname "$OPCODE_SRC")"
    git clone --branch "$OPCODE_VERSION" "$OPCODE_REPO" "$OPCODE_SRC"
    cd "$OPCODE_SRC"
  fi

  # --- Install deps ---
  info "Installing dependencies ..."
  bun install 2>&1 | tail -3

  # --- Apply patches ---
  info "Patching source code ..."
  bun run - << 'BUN_PATCH_EOF'
import fs from "fs"
import path from "path"

const SRC = process.env.HOME + "/.opencode/src"
const GROUPS   = "packages/opencode/src/server/routes/instance/httpapi/groups/session.ts"
const HANDLERS = "packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts"

function patch(relPath: string, anchor: string, insertion: string, label: string) {
  const full = path.join(SRC, relPath)
  let content = fs.readFileSync(full, "utf8")
  const marker = insertion.trim().split("\n")[0]!.trim()
  if (content.includes(marker)) { console.log(`  [SKIP] ${label} — already patched`); return }
  let idx = content.indexOf(anchor)
  if (idx === -1) throw new Error(`Anchor not found for ${label}`)
  let count = 1
  while (content.indexOf(anchor, idx + 1) !== -1) { count++; idx = content.indexOf(anchor, idx + 1) }
  if (count !== 1) throw new Error(`Anchor for ${label} found ${count} times (expected exactly 1)`)
  const insertPos = content.indexOf(anchor) + anchor.length
  fs.writeFileSync(full, content.slice(0, insertPos) + insertion + content.slice(insertPos))
  console.log(`  [OK]   ${label}`)
}

patch(GROUPS,
  "  summarize: `${root}/:sessionID/summarize`,",
  "\n  continue: `${root}/:sessionID/continue`,",
  "SessionPaths.continue")

const aB = ['            identifier: "session.summarize",',
  '            summary: "Summarize session",',
  '            description: "Generate a concise summary of the session using AI compaction to preserve key information.",',
  '          }),','        ),'].join("\n")
const iB = "\n" + ['        HttpApiEndpoint.post("continue", SessionPaths.continue, {',
  '          params: { sessionID: SessionID },',
  '          query: WorkspaceRoutingQuery,',
  '          success: described(Schema.Boolean, "Continued session"),',
  '          error: [HttpApiError.BadRequest, ApiNotFoundError],',
  '        }).annotateMerge(',
  '          OpenApi.annotations({',
  '            identifier: "session.continue",',
  '            summary: "Continue session",',
  '            description: "Continue generation from the last assistant message without creating a user message.",',
  '          }),','        ),'].join("\n")
patch(GROUPS, aB, iB, "Endpoint: POST /continue")

const aC = ["      yield* compactSvc.create({",
  "        sessionID: ctx.params.sessionID,","        agent: currentAgent,","        model: {",
  "          providerID: ctx.payload.providerID,","          modelID: ctx.payload.modelID,",
  "        },","        auto: ctx.payload.auto ?? false,","      })",
  "      yield* promptSvc.loop({ sessionID: ctx.params.sessionID })","      return true","    })"].join("\n")
const iC = "\n\n" + [
  "    const continueSession = Effect.fn(\"SessionHttpApi.continue\")(function* (ctx: {",
  "      params: { sessionID: SessionID }","    }) {",
  "      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))",
  "      const messages = yield* SessionError.mapStorageNotFound(",
  "        session.messages({ sessionID: ctx.params.sessionID }),","      )",
  "      const { assistant: lastAssistant } = MessageV2.latest(messages)",
  "      if (lastAssistant) {","        yield* session.updateMessage({",
  "          ...lastAssistant,","          finish: undefined,","          error: undefined,",
  "        })","      }",
  "      yield* promptSvc.loop({ sessionID: ctx.params.sessionID })","      return true","    })"].join("\n")
patch(HANDLERS, aC, iC, "Handler: continueSession")

patch(HANDLERS,
  '      .handle("summarize", summarize)',
  '\n      .handle("continue", continueSession)',
  "Handler registration")

console.log("\nAll patches applied.")
BUN_PATCH_EOF

  # --- Build ---
  info "Building patched binary (2-5 min) ..."
  cd "$OPCODE_SRC/packages/opencode"
  OPENCODE_CHANNEL=latest bun run script/build.ts --single --skip-embed-web-ui --skip-install 2>&1 | tail -5

  BUILT_BIN=$(find "$OPCODE_SRC/packages/opencode/dist" -name "opencode" -type f | head -1)
  [ -f "$BUILT_BIN" ] || die "Build output binary not found"
  info "Binary built ($(du -h "$BUILT_BIN" | cut -f1))"

  # --- Backup & install ---
  info "Backing up official binary ..."
  cp "$OPCODE_BIN" "$OPCODE_BACKUP"
  info "Installing patched binary ..."
  cp "$BUILT_BIN" "$OPCODE_BIN"
  chmod +x "$OPCODE_BIN"

  if [ "$(uname)" = "Darwin" ]; then
    info "Code-signing (macOS) ..."
    codesign --force --sign - "$OPCODE_BIN" 2>/dev/null || warn "codesign failed"
    xattr -cr "$OPCODE_BIN" 2>/dev/null || true
  fi
  info "Verifying ..."
  "$OPCODE_BIN" --version >/dev/null 2>&1 || die "Patched binary failed to run"

  # --- Install plugin ---
  info "Installing TUI plugin ..."
  mkdir -p "$PLUGIN_DIR"
  cat > "$PLUGIN_FILE" << 'PLUGIN_EOF'
import { spawn } from "node:child_process"

export default {
  tui: async (api: any) => {
    const commands = [
      {
        title: "Edit in ocedit",
        value: "ocedit.edit",
        description: "Open this session in the ocedit web editor",
        slash: { name: "edit" },
        onSelect: async () => {
          const sid = api.route?.current?.params?.sessionID
          if (!sid) { api.ui?.toast?.({ title: "No active session" }); return }
          try {
            await fetch("http://127.0.0.1:17654/")
            spawn("open", ["http://127.0.0.1:17654/?session=" + sid], { stdio: "ignore" })
          } catch {
            spawn("ocedit", [sid], { stdio: "ignore", detached: true })
          }
        },
      },
      {
        title: "Continue generation",
        value: "ocedit.continue",
        description: "Continue model generation without a user message",
        slash: { name: "continue" },
        onSelect: () => {
          const sid = api.route?.current?.params?.sessionID
          if (!sid) { api.ui?.toast?.({ title: "No active session" }); return }
          api.ui?.toast?.({ title: "Generating..." })
          const c = api.client?.client
          if (!c) { api.ui?.toast?.({ title: "SDK unavailable" }); return }
          c.post({ url: "/session/" + sid + "/continue" }).catch((e) => {
            api.ui?.toast?.({ title: "Continue failed: " + String(e) })
          })
        },
      },
    ]
    if (api.command?.register) { api.command.register(() => commands) }
    else if (api.keymap?.registerLayer) {
      api.keymap.registerLayer({ commands: commands.map((c) => ({
        name: c.value, slashName: c.slash?.name, namespace: "palette",
        description: c.description, onSelect: c.onSelect,
      })) })
    }
  }
}
PLUGIN_EOF
  info "opencode patched successfully."
}

# ============================================================
# Pre-flight
# ============================================================
command -v bun >/dev/null 2>&1 || die "bun not found (install from https://bun.sh)"
[ -f "$SERVER_TS" ] || die "src/server.ts not found in $PROJECT_DIR"
BUN_PATH="$(command -v bun)"

# ============================================================
# Part 1: Install ocedit command wrapper
# ============================================================
info "Installing ocedit command ..."

BIN_DIR=""
for d in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  [ -d "$d" ] && [ -w "$d" ] && { BIN_DIR="$d"; break; }
done
if [ -z "$BIN_DIR" ]; then
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
fi

WRAPPER="$BIN_DIR/ocedit"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# Generated by ocedit install.sh — do not edit manually
exec "$BUN_PATH" run "$SERVER_TS" "\$@"
EOF
chmod +x "$WRAPPER"

if echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  info "ocedit installed → $WRAPPER"
else
  warn "$BIN_DIR is not in PATH. Add it:  export PATH=\"$BIN_DIR:\$PATH\""
fi

echo "=================="
echo "SKIPPING PATCH"
echo "=================="
echo "done"
exit 0

echo "WARNING: ERROR"

# ============================================================
# Part 2: Patch opencode
# ============================================================
echo ""
if [ ! -f "$OPCODE_BIN" ]; then
  warn "opencode binary not found — skipping patch."
  warn "Install opencode first, then re-run this script."
elif [ -f "$OPCODE_BACKUP" ]; then
  warn "opencode already patched (backup exists)."
  warn "To re-patch: run uninstall.sh first, then install.sh again."
else
  if command -v git >/dev/null 2>&1; then
    _patch_opencode
  else
    warn "git not found — skipping opencode patch."
  fi
fi

# ============================================================
# Summary
# ============================================================
echo ""
info "${BOLD}Install complete!${NC}"
echo ""
echo "  ocedit:"
echo "    ${BOLD}ocedit${NC}            Open session list"
echo "    ${BOLD}ocedit ses_xxx${NC}    Edit specific session"
if [ -f "$OPCODE_BACKUP" ]; then
  echo ""
  echo "  opencode slash commands:"
  echo "    ${BOLD}/edit${NC}            Open current session in ocedit"
  echo "    ${BOLD}/continue${NC}        Continue model generation (no user message)"
fi
echo ""
echo "  Uninstall: ${BOLD}./uninstall.sh${NC}"
