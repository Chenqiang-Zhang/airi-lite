#!/bin/bash
# SessionStart hook for Claude Code cloud sessions.
#
# The cloud container ships Node 22, but this project needs Node 24+ (see
# README). Installs Node 24 through the container's nvm, puts it first on the
# session's PATH, and installs the pnpm dependencies so `pnpm test`,
# `pnpm typecheck` and `pnpm build` work from the first turn.
set -euo pipefail

# Cloud sessions only: local machines manage their own Node.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

NODE_MAJOR=24
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "session-start: nvm not found at $NVM_DIR; cannot install Node $NODE_MAJOR" >&2
  exit 1
fi

# nvm is not clean under `set -u`.
set +u
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" --no-use
if ! nvm which "$NODE_MAJOR" >/dev/null 2>&1; then
  nvm install "$NODE_MAJOR"
fi
NODE_PATH_IN_NVM="$(nvm which "$NODE_MAJOR")"
set -u
NODE_BIN="$(dirname "$NODE_PATH_IN_NVM")"
if [ ! -x "$NODE_BIN/node" ]; then
  echo "session-start: Node $NODE_MAJOR not found after nvm install" >&2
  exit 1
fi
export PATH="$NODE_BIN:$PATH"

# Make Node 24 the default for the rest of the session. Written before the
# install, so a failed install still leaves later commands on Node 24.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export NVM_DIR=\"$NVM_DIR\""
    echo "export PATH=\"$NODE_BIN:\$PATH\""
  } >> "$CLAUDE_ENV_FILE"
fi

# pnpm runs on whichever `node` is first on PATH, so the container's copy is
# fine; install one only if the image stops shipping it.
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@10
fi

pnpm install --frozen-lockfile

echo "session-start: node $(node --version), pnpm $(pnpm --version), dependencies installed"
