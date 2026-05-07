#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Start the AI Token League server with a specified environment.

Options:
  -e, --env FILE    Environment file to load (default: env.local)
  -s, --smoke       Run smoke test after starting
  -d, --detach      Run in background (detached mode)
  -l, --log FILE    Log file for detached mode (default: server.log)
  -p, --pid FILE    PID file for detached mode (default: server.pid)
  -h, --help        Show this help message

Examples:
  $(basename "$0")                       # Start with env.local
  $(basename "$0") -e env.test           # Start with env.test
  $(basename "$0") -e env.local -d       # Detached mode
  $(basename "$0") -e env.local -s       # Start and run smoke test
EOF
  exit 0
}

ENV_FILE="env.local"
SMOKE=false
DETACH=false
LOG_FILE="server.log"
PID_FILE="server.pid"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -e|--env)    ENV_FILE="$2"; shift 2 ;;
    -s|--smoke)  SMOKE=true; shift ;;
    -d|--detach) DETACH=true; shift ;;
    -l|--log)    LOG_FILE="$2"; shift 2 ;;
    -p|--pid)    PID_FILE="$2"; shift 2 ;;
    -h|--help)   usage ;;
    *)           echo "Unknown option: $1"; usage ;;
  esac
done

# Resolve env file path
if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$PROJECT_ROOT/$ENV_FILE"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: env file not found: $ENV_FILE"
  exit 1
fi

echo "Loading env: $ENV_FILE"

# Export variables from env file, skipping comments and empty lines
set -a
eval "$(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$')"
set +a

# Check Node.js version
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 22 ]]; then
  echo "Error: Node.js >= 22 required, found $(node -v)"
  exit 1
fi

# Resolve port: use configured PORT, fall back to random free port if in use
check_port() {
  local port=$1
  # Try lsof (macOS/Linux) first, then ss (Linux), then nc
  if command -v lsof &>/dev/null; then
    ! lsof -i :"$port" -sTCP:LISTEN &>/dev/null
  elif command -v ss &>/dev/null; then
    ! ss -tlnp | grep -q ":${port} "
  else
    ! nc -z 127.0.0.1 "$port" 2>/dev/null
  fi
}

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"

if ! check_port "$PORT"; then
  # Find a random free port
  NEW_PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
  echo "Port $PORT is in use, using random port $NEW_PORT"
  PORT="$NEW_PORT"
  export PORT
fi

if [[ "$DETACH" == true ]]; then
  # Resolve log/pid paths
  [[ "$LOG_FILE" != /* ]] && LOG_FILE="$PROJECT_ROOT/$LOG_FILE"
  [[ "$PID_FILE" != /* ]] && PID_FILE="$PROJECT_ROOT/$PID_FILE"

  # Check if already running
  if [[ -f "$PID_FILE" ]]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Server already running (PID $OLD_PID). Stop it first or remove $PID_FILE"
      exit 1
    fi
    rm -f "$PID_FILE"
  fi

  echo "Starting server on $HOST:$PORT (background)..."
  node src/backend/server.js >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
  echo "Server started (PID $SERVER_PID), port: $PORT, log: $LOG_FILE"

  # Brief wait to check if it crashed immediately
  sleep 1
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Error: server exited early. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
else
  echo "Starting server on $HOST:$PORT..."
  if [[ "$SMOKE" == true ]]; then
    node src/backend/server.js --smoke
  else
    exec node src/backend/server.js
  fi
fi
