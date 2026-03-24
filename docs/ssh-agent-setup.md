# SSH Agent Forwarding with cs

`cs attach` connects you to sessions across machines via SSH. For git push and other SSH operations to work inside those sessions, your SSH agent must be forwarded and accessible. This document explains how it works and how to set up your dotfiles.

## The problem

When you `cs attach` from machine A to a session on machine B:

1. Your SSH connection from A→B carries your forwarded agent
2. The agent socket lives at a random path like `/tmp/ssh-xxx/agent.12345`
3. Claude Code (running inside tmux on B) spawns new shells that need `SSH_AUTH_SOCK` to use the agent
4. When you detach and reattach later, a NEW SSH connection creates a NEW socket at a different path
5. The old socket is dead — any shell still pointing to it can't use the agent

## The solution: fixed symlink + unconditional export

Two pieces work together:

### 1. Symlink creation (in `.bash_profile`, gated on SSH_CONNECTION)

When you SSH into a machine, create a symlink from a fixed path to the live agent socket:

```bash
# Only create symlink when arriving via SSH (agent is forwarded)
if [ -n "$SSH_AUTH_SOCK" ] && [ "$SSH_AUTH_SOCK" != "$HOME/.ssh/auth_sock" ]; then
  ln -sf "$SSH_AUTH_SOCK" "$HOME/.ssh/auth_sock"
fi
```

This runs when you SSH in and when `cs attach` connects remotely (cs refreshes this symlink in its SSH #2 attach step).

### 2. SSH_AUTH_SOCK export (in `.bash_profile`, unconditional)

Every shell — interactive, non-interactive, login, tool-spawned — must point to the fixed symlink:

```bash
# MUST be outside any interactive guard
export SSH_AUTH_SOCK="$HOME/.ssh/auth_sock"
```

This goes in `.bash_profile` **before** the `.bashrc` source and **outside** any `[[ $- == *i* ]]` guard. It must run for:
- Interactive login shells (your terminal)
- Non-interactive shells (Claude Code's Bash tool, cron, scripts)
- tmux panes (inherit from tmux environment)

### 3. tmux environment (handled by cs)

`cs attach` does this automatically in the SSH #2 attach step:

```bash
tmux set-environment -t <session> SSH_AUTH_SOCK $SSH_AUTH_SOCK
ln -sf $SSH_AUTH_SOCK ~/.ssh/auth_sock
exec tmux attach-session -t <session>
```

This updates both the tmux session environment (for new panes) and the symlink (for existing shells using the fixed path).

### 4. tmux.conf settings

Your `.tmux.conf` should include:

```
set-option -g update-environment "SSH_AUTH_SOCK SSH_CONNECTION"
set-environment -g SSH_AUTH_SOCK ~/.ssh/auth_sock
```

The first line tells tmux to update those vars when a client attaches. The second sets the global default to the symlink path.

## How it flows

### First attach (session created)

```
You (A) ──ssh──► Machine B
                  │
                  ├─ .bash_profile runs
                  │   ├─ symlink: ~/.ssh/auth_sock → /tmp/ssh-xxx/agent.123
                  │   └─ export SSH_AUTH_SOCK=~/.ssh/auth_sock
                  │
                  ├─ cs creates tmux session
                  │   ├─ tmux new-session runs claude --resume
                  │   └─ tmux sources .tmux.conf (set-environment)
                  │
                  └─ cs attaches
                      ├─ tmux set-environment SSH_AUTH_SOCK /tmp/ssh-xxx/agent.123
                      ├─ ln -sf /tmp/ssh-xxx/agent.123 ~/.ssh/auth_sock
                      └─ tmux attach-session
```

### Reattach (session already exists)

```
You (A) ──ssh──► Machine B (new SSH, new socket /tmp/ssh-yyy/agent.456)
                  │
                  ├─ cs attach runs SSH #2:
                  │   ├─ tmux set-environment SSH_AUTH_SOCK /tmp/ssh-yyy/agent.456
                  │   ├─ ln -sf /tmp/ssh-yyy/agent.456 ~/.ssh/auth_sock
                  │   └─ tmux attach-session
                  │
                  └─ Claude's Bash tool spawns shell:
                      ├─ .bash_profile: export SSH_AUTH_SOCK=~/.ssh/auth_sock
                      ├─ ~/.ssh/auth_sock → /tmp/ssh-yyy/agent.456 (live!)
                      └─ git push works ✓
```

### When it breaks

The agent dies when:
- Your SSH connection from A→B drops (network, laptop sleep, timeout)
- The socket at `/tmp/ssh-xxx/agent.123` is cleaned up
- The symlink still points to the dead socket

It's fixed on next `cs attach` — the SSH #2 step refreshes the symlink. But between disconnect and reattach, existing shells can't use the agent.

## SSH config recommendations

In `~/.ssh/config` on the machine you attach FROM:

```
Host *
  ForwardAgent yes
  ServerAliveInterval 60
  ServerAliveCountMax 3
  AddKeysToAgent yes
```

- `ForwardAgent yes` — forward your agent to remote hosts
- `ServerAliveInterval 60` — send keepalive every 60 seconds (prevents idle timeout)
- `ServerAliveCountMax 3` — disconnect after 3 missed keepalives (3 minutes)
- `AddKeysToAgent yes` — auto-add keys to agent on first use

## Timeout behavior

| Scenario | What happens | Agent status |
|----------|-------------|-------------|
| Normal detach (C-6 d) | SSH closes, socket dies | Dead until reattach |
| Network drop | SSH dies after ServerAliveCountMax | Dead until reattach |
| Laptop sleep | SSH dies on wake (usually) | Dead until reattach |
| `cs attach` from new machine | New SSH, new socket, symlink refreshed | Alive |
| `cs attach` from same machine (local) | No SSH involved, uses existing tmux | Uses whatever symlink points to |

## Checklist

- [ ] `.bash_profile`: `export SSH_AUTH_SOCK="$HOME/.ssh/auth_sock"` — **outside** interactive guard
- [ ] `.bash_profile`: symlink creation on SSH login — gated on `SSH_CONNECTION`
- [ ] `.tmux.conf`: `set-option -g update-environment "SSH_AUTH_SOCK SSH_CONNECTION"`
- [ ] `.tmux.conf`: `set-environment -g SSH_AUTH_SOCK ~/.ssh/auth_sock`
- [ ] `~/.ssh/config`: `ForwardAgent yes` on machines you attach from
- [ ] `~/.ssh/config`: `ServerAliveInterval 60` to prevent idle drops
- [ ] SSH keys deployed to all machines (or use agent forwarding chain)
