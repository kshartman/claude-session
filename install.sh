#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.config/cs"
CONFIG_FILE="$CONFIG_DIR/config.json"
BIN_DIR="$HOME/.local/bin"

echo "cs — Claude Session Manager installer"
echo

# Check bun
if ! command -v bun &>/dev/null; then
  echo "ERROR: bun is not installed."
  echo "Install it with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
echo "✓ bun $(bun --version)"

# Check tmux
if ! command -v tmux &>/dev/null; then
  echo "ERROR: tmux is not installed."
  echo "Install it with: sudo apt install tmux"
  exit 1
fi
echo "✓ $(tmux -V)"

# Install dependencies
echo "Installing dependencies..."
cd "$SCRIPT_DIR"
bun install --production 2>&1 | tail -1

# Create config directory
if [ ! -d "$CONFIG_DIR" ]; then
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  echo "✓ Created $CONFIG_DIR"
fi

# Stub config if not present
if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" << 'EOF'
{
  "mongoUri": "mongodb://claude:<password>@your-mongo-host:27017/claude?authMechanism=SCRAM-SHA-256&tls=true"
}
EOF
  chmod 600 "$CONFIG_FILE"
  echo "✓ Created $CONFIG_FILE (edit with your password)"
else
  echo "✓ Config exists at $CONFIG_FILE"
fi

# Symlink
mkdir -p "$BIN_DIR"
ln -sf "$SCRIPT_DIR/cs.ts" "$BIN_DIR/cs"
echo "✓ Symlinked cs → $BIN_DIR/cs"

# Verify PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo
  echo "NOTE: $BIN_DIR is not in your PATH."
  echo "Add to your shell profile:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo
echo "Setup complete! Next steps:"
echo
echo "  1. Edit $CONFIG_FILE with your MongoDB password"
echo "  2. Run 'cs sync' to import existing sessions"
echo "  3. Add to .bashrc for auto-sync on login:"
echo "     echo 'cs sync --quiet &' >> ~/.bashrc"
echo
echo "Run 'cs --help' for usage."
