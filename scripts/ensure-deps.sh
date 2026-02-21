#!/bin/bash
#
# ensure-deps.sh
# Ensures typegraph-mcp dependencies are installed.
# Called automatically by Claude Code on session start via plugin hooks.
#

set -e

PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Check if node_modules exist with required packages
if [ -d "$PLUGIN_DIR/node_modules/@modelcontextprotocol" ] && \
   [ -d "$PLUGIN_DIR/node_modules/oxc-parser" ] && \
   [ -d "$PLUGIN_DIR/node_modules/oxc-resolver" ]; then
  echo "typegraph-mcp dependencies OK"
  exit 0
fi

echo "Installing typegraph-mcp dependencies..."
cd "$PLUGIN_DIR"

if command -v npm &> /dev/null; then
  npm install
else
  echo "Warning: npm not found. Run 'npm install' in $PLUGIN_DIR manually."
  exit 1
fi

echo "typegraph-mcp dependencies installed"
exit 0
