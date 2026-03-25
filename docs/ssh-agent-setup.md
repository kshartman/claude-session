# SSH Agent Management in cs

cs manages a persistent local SSH agent on each machine. No agent forwarding, no symlinks, no dotfile configuration required.

## How it works

Each machine runs its own SSH agent at a fixed socket path: `~/.ssh/cs-agent.sock`. The agent is started automatically by `cs attach` and persists across tmux detach/reattach, SSH disconnects, and network drops.

Your SSH private key must be on each machine. When `cs attach` detects the agent has no loaded keys (expired or first use), it prompts for your passphrase. Keys expire after a configurable timeout (default 8 hours).

## The flow

### First attach to a remote session

```
You (A) ──cs attach──► Machine B
                         │
                         ├─ SSH #1 (ensure): starts agent at ~/.ssh/cs-agent.sock
                         │   └─ Creates tmux session if needed
                         │
                         └─ SSH #2 (attach): checks agent for keys
                             ├─ No keys? Prompts: "Adding SSH key (expires in 8h)..."
                             ├─ You enter passphrase (once)
                             ├─ Sets tmux env: SSH_AUTH_SOCK=~/.ssh/cs-agent.sock
                             └─ Attaches to tmux session
```

### Reattach (session exists, keys still valid)

```
You (A) ──cs attach──► Machine B
                         │
                         ├─ SSH #1: agent already running, keys loaded → skip
                         └─ SSH #2: keys valid → straight to tmux attach
```

### Reattach (keys expired)

```
You (A) ──cs attach──► Machine B
                         │
                         ├─ SSH #1: agent running but no keys → skip (SSH #2 handles it)
                         └─ SSH #2: "Adding SSH key (expires in 8h)..."
                             ├─ You enter passphrase
                             └─ Attaches to tmux session
```

### Local attach (same machine)

```
cs attach claude-session
  │
  ├─ Ensures agent at ~/.ssh/cs-agent.sock
  ├─ No keys? Prompts ssh-add
  ├─ Sets tmux env SSH_AUTH_SOCK
  └─ tmux switch-client or attach-session
```

## Why not agent forwarding?

Agent forwarding is inherently fragile:
- The socket dies when the SSH connection dies (sleep, network drop, timeout)
- Symlinks to the socket go stale
- tmux sessions started before the SSH connection don't inherit the socket
- ControlMaster mux connections cache stale agent state
- Non-interactive shells (Claude's Bash tool) may not have `SSH_AUTH_SOCK` set

A persistent local agent has none of these problems. The socket is always at the same path, the agent survives everything, and the only thing that expires is the loaded key.

## Configuration

In `~/.config/cs/config.json`:

```json
{
  "agentKeyTimeout": 28800
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `agentKeyTimeout` | `28800` (8h) | Seconds before loaded keys expire. Set to `0` for no expiry (not recommended). |

## Managing agents

```bash
cs agent stop              # stop agent on this machine
cs agent stop --host dev   # stop agent on a specific host
cs agent stop --all        # stop agents on all known hosts
```

## Requirements

- SSH private key deployed to each machine cs manages
- `ssh-add` available on PATH
- No dotfile changes needed — no `.bash_profile`, `.tmux.conf`, or `~/.ssh/config` modifications required by cs

## Timeout behavior

| Scenario | Agent status | What happens |
|----------|-------------|-------------|
| Normal detach | Agent alive, keys loaded | Instant reattach, no passphrase |
| Sleep / network drop | Agent alive, keys loaded | Instant reattach, no passphrase |
| Keys expired (8h default) | Agent alive, no keys | Prompts passphrase on next `cs attach` |
| `cs agent stop` | Agent stopped | Next `cs attach` starts fresh agent, prompts passphrase |
| Machine reboot | Agent gone | Next `cs attach` starts agent, prompts passphrase |
