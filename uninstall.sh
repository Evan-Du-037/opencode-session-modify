#!/bin/bash
set -euo pipefail

# ============================================================
# uninstall.sh — Uninstall ocedit + restore opencode
#
# Part 1: Restore opencode to official version
# Part 2: Remove the `ocedit` command wrapper
# ============================================================

OPCODE_BIN="$HOME/.opencode/bin/opencode"
OPCODE_BACKUP="$HOME/.opencode/bin/opencode.orig"
PLUGIN_FILE="$HOME/.config/opencode/plugins/ocedit.ts"

# --- Helpers ---
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BOLD=$'\033[1m'; NC=$'\033[0m'
info()  { echo "${GREEN}==>${NC} $1"; }
warn()  { echo "${YELLOW}!!${NC}  $1"; }
error() { echo "${RED}ERROR:${NC} $1" >&2; }
die()   { error "$1"; exit 1; }

# ============================================================
# Part 1: Restore opencode
# ============================================================
if [ -f "$OPCODE_BACKUP" ]; then
  info "Restoring official opencode binary ..."
  cp "$OPCODE_BACKUP" "$OPCODE_BIN"
  chmod +x "$OPCODE_BIN"
  rm -f "$OPCODE_BACKUP"
  info "Binary restored."
elif [ -f "$OPCODE_BIN" ]; then
  warn "No backup found. Running 'opencode upgrade' ..."
  "$OPCODE_BIN" upgrade 2>&1 || warn "upgrade failed — please reinstall opencode manually."
  info "Upgraded to official version."
else
  warn "opencode not found — skipping restore."
fi

if [ -f "$OPCODE_BIN" ]; then
  info "Verifying ..."
  "$OPCODE_BIN" --version >/dev/null 2>&1 || warn "Binary verification failed."
fi

# --- Remove TUI plugin ---
if [ -f "$PLUGIN_FILE" ]; then
  info "Removing TUI plugin ..."
  rm -f "$PLUGIN_FILE"
  info "Plugin removed."
fi

# ============================================================
# Part 2: Remove ocedit command wrapper
# ============================================================
info "Removing ocedit command ..."
removed=0
for d in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  if [ -f "$d/ocedit" ]; then
    rm -f "$d/ocedit"
    info "Removed $d/ocedit"
    removed=1
  fi
done
[ "$removed" = "0" ] && info "No ocedit wrapper found."

# ============================================================
# Summary
# ============================================================
echo ""
info "${BOLD}Uninstall complete!${NC}"
echo ""
echo "  opencode is at the official version."
echo "  ocedit wrapper removed."
echo ""
echo "  Source code at ~/.opencode/src is kept for reference."
echo "  To remove it: ${BOLD}rm -rf ~/.opencode/src${NC}"
