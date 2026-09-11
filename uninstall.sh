#!/usr/bin/env bash
# uninstall.sh — Remove the `ocedit` command
set -euo pipefail

removed=0
for d in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  if [ -f "$d/ocedit" ]; then
    rm -f "$d/ocedit"
    echo "Removed $d/ocedit"
    removed=1
  fi
done
[ "$removed" = "0" ] && echo "ocedit not found (may not be installed)"
