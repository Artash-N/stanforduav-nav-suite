#!/usr/bin/env bash
set -euo pipefail

# One-command dev runner for Mac/Linux.
# It creates/uses a local .venv, installs Python deps, installs npm deps, then runs frontend+backend.

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found. Install Python 3.10+ and try again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found. Install Node.js (LTS) and try again." >&2
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "Creating Python virtualenv (.venv)..."
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "Installing Python dependencies..."
pip install -r backend/requirements.txt

if [ ! -d "node_modules" ]; then
  echo "Installing npm dependencies..."
  npm install
fi

echo "Starting frontend + backend..."
# Uses the venv python because PATH is inherited.
npm run dev:full
