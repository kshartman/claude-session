#!/usr/bin/env bash
# One-liner install: curl -sSL https://git.bogometer.com/shartman/claude-session/-/raw/main/install-remote.sh | bash
set -euo pipefail

BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/cs"
CONFIG_FILE="$CONFIG_DIR/config.json"
BUNDLE_URL="https://git.bogometer.com/shartman/claude-session/-/raw/main/cs.bundle.js"

echo "cs — Claude Session Manager (remote install)"
echo

# Check bun
if ! command -v bun &>/dev/null; then
  echo "ERROR: bun is not installed."
  echo "Install it with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
echo "  bun $(bun --version)"

# Check tmux
if ! command -v tmux &>/dev/null; then
  echo "ERROR: tmux is not installed."
  echo "Install it with: sudo apt install tmux"
  exit 1
fi
echo "  $(tmux -V)"

# Download bundle
mkdir -p "$BIN_DIR"
echo "Downloading cs..."
curl -sSL "$BUNDLE_URL" -o "$BIN_DIR/cs"
chmod +x "$BIN_DIR/cs"
echo "  Installed to $BIN_DIR/cs"

# Create config directory
if [ ! -d "$CONFIG_DIR" ]; then
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
fi

# Stub config if not present
if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" << 'EOF'
{
  "mongoUri": "mongodb://user:password@your-mongo-host:27017/claude?authMechanism=SCRAM-SHA-256&tls=true"
}
EOF
  chmod 600 "$CONFIG_FILE"
  echo "  Created $CONFIG_FILE (edit with your credentials)"
else
  echo "  Config exists at $CONFIG_FILE"
fi

# Check PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo
  echo "NOTE: $BIN_DIR is not in your PATH."
  echo "Add to your shell profile:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo
echo "Done! Next steps:"
echo "  1. Edit $CONFIG_FILE with your MongoDB credentials"
echo "  2. cs sync"
echo "  3. Optional: echo 'cs sync --quiet &' >> ~/.bashrc"
