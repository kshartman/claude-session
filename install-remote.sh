#!/usr/bin/env bash
# One-liner install: curl -sSL https://git.bogometer.com/shartman/claude-session/-/raw/main/install-remote.sh | bash -s -- [--nocron] [--noconfig]
set -euo pipefail

OPT_NOCRON=false
OPT_NOCONFIG=false
for arg in "$@"; do
  case "$arg" in
    --nocron)   OPT_NOCRON=true ;;
    --noconfig) OPT_NOCONFIG=true ;;
  esac
done

BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/cs"
CONFIG_FILE="$CONFIG_DIR/config.json"
BUNDLE_URL="https://git.bogometer.com/shartman/claude-session/-/raw/main/cs.bundle.js"
MANPAGE_URL="https://git.bogometer.com/shartman/claude-session/-/raw/main/cs.1"
MAN_DIR="$HOME/.local/share/man/man1"

echo "cs — Claude Session Manager (remote install)"
echo

# Install bun if missing
if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  # Snapshot shell profiles — bun installer appends PATH export without asking
  for f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.zshrc"; do
    [ -f "$f" ] && cp "$f" "$f.pre-bun"
  done
  curl -fsSL https://bun.sh/install | bash
  # Revert all shell profiles — user's dotfiles may be version controlled
  for f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.zshrc"; do
    [ -f "$f.pre-bun" ] && mv "$f.pre-bun" "$f"
  done
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    echo "ERROR: bun installation failed."
    exit 1
  fi
  echo "  Installed bun (NOTE: .bashrc was NOT modified — add ~/.bun/bin to PATH in your own shell config)"
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

# Download man page
mkdir -p "$MAN_DIR"
curl -sSL "$MANPAGE_URL" -o "$MAN_DIR/cs.1"
echo "  Installed man page (man cs)"

# Create config directory
if [ ! -d "$CONFIG_DIR" ]; then
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
fi

# Copy config from a source host if available, otherwise stub it
if [ "$OPT_NOCONFIG" = true ]; then
  echo "  Config copy skipped (--noconfig)"
elif [ ! -f "$CONFIG_FILE" ]; then
  CONFIG_SOURCE="${CS_CONFIG_HOST:-cs}"
  if scp -q "$CONFIG_SOURCE:~/.config/cs/config.json" "$CONFIG_FILE" 2>/dev/null; then
    chmod 600 "$CONFIG_FILE"
    echo "  Copied config from $CONFIG_SOURCE"
  else
    cat > "$CONFIG_FILE" << 'EOF'
{
  "mongoUri": "mongodb://user:password@your-mongo-host:27017/claude?authMechanism=SCRAM-SHA-256&tls=true"
}
EOF
    chmod 600 "$CONFIG_FILE"
    echo "  Created $CONFIG_FILE (edit with your credentials)"
    echo "  TIP: Or set CS_CONFIG_HOST=<hostname> to copy config via scp"
  fi
else
  echo "  Config exists at $CONFIG_FILE"
fi

# Set up cron sync if not already present (unless --nocron or noCron in config)
NO_CRON=$(grep -o '"noCron":\s*true' "$CONFIG_FILE" 2>/dev/null || true)
if [ "$OPT_NOCRON" = true ] || [ -n "$NO_CRON" ]; then
  echo "  Cron sync skipped"
else
  CRON_CMD="PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\" cs sync --quiet 2>/dev/null"
  if crontab -l 2>/dev/null | grep -q "cs sync"; then
    echo "  Cron sync already configured"
  else
    (crontab -l 2>/dev/null; echo "*/5 * * * * $CRON_CMD") | crontab -
    echo "  Added cron: sync every 5 minutes"
  fi
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
