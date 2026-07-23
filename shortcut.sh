#!/usr/bin/env bash
# shortcut.sh — Create a double-clickable ocedit shortcut on the Desktop
set -euo pipefail

DESKTOP="$HOME/Desktop"
SHORTCUT="$DESKTOP/ocedit.command"

command -v ocedit >/dev/null 2>&1 || {
  echo "ERROR: ocedit not found in PATH. Run ./install.sh first." >&2
  exit 1
}

mkdir -p "$DESKTOP"

OCEDIT_PATH="$(command -v ocedit)"

cat > "$SHORTCUT" <<EOF
#!/usr/bin/env bash
exec "$OCEDIT_PATH" "\$@"
EOF
chmod +x "$SHORTCUT"

echo "Created $SHORTCUT"