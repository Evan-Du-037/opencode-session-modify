#!/usr/bin/env bash
# install.sh — Install the `ocedit` command
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_TS="$SCRIPT_DIR/src/server.ts"

command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not found (https://bun.sh)" >&2; exit 1; }
[ -f "$SERVER_TS" ] || { echo "ERROR: $SERVER_TS not found" >&2; exit 1; }

BUN_PATH="$(command -v bun)"

# Find or create a writable bin directory
BIN_DIR=""
for d in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  [ -d "$d" ] && [ -w "$d" ] && { BIN_DIR="$d"; break; }
done
[ -z "$BIN_DIR" ] && { BIN_DIR="$HOME/.local/bin"; mkdir -p "$BIN_DIR"; }

WRAPPER="$BIN_DIR/ocedit"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$BUN_PATH" run "$SERVER_TS" "\$@"
EOF
chmod +x "$WRAPPER"

echo "Installed ocedit → $WRAPPER"
if echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo ""
  echo "  ocedit            Open session list"
  echo "  ocedit ses_xxx    Edit specific session"
else
  echo ""
  echo "NOTE: Add $BIN_DIR to PATH:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi
echo ""
echo "Uninstall: ./uninstall.sh"
