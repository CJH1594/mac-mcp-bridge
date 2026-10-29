#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_DIR="$HOME/.cokacremote"
CWD_FILE="$SESSION_DIR/last_cwd"
DEFAULT_CWD="$HOME"
PORT=3000
TUNNEL_URL="${MCP_PUBLIC_URL:-}"
TUNNEL_PID=""
SERVER_PID=""

if [ ! -t 0 ]; then
    echo "로컬 터미널에서 start.sh를 실행해 주세요."
    exit 1
fi

LAST_CWD="$DEFAULT_CWD"
if [ -f "$CWD_FILE" ]; then
    SAVED_CWD=$(cat "$CWD_FILE" 2>/dev/null || true)
    [ -z "$SAVED_CWD" ] || LAST_CWD="$SAVED_CWD"
fi

if [ -z "$TUNNEL_URL" ]; then
    read -r -p "ngrok HTTPS URL (for example https://your-domain.ngrok-free.dev): " TUNNEL_URL
fi
case "$TUNNEL_URL" in
    https://*) TUNNEL_URL="${TUNNEL_URL%/}" ;;
    *) echo "HTTPS ngrok URL을 입력해 주세요."; exit 1 ;;
esac

INPUT_CWD=""
if [ "${1:-}" != "--reuse-last" ]; then
    read -r -p "Working Directory [$LAST_CWD]: " INPUT_CWD
fi
CWD_TARGET="${INPUT_CWD:-$LAST_CWD}"
if [ ! -d "$CWD_TARGET" ]; then
    echo "디렉터리가 존재하지 않습니다: $CWD_TARGET"
    exit 1
fi
mkdir -p -m 700 "$SESSION_DIR"
printf '%s\n' "$CWD_TARGET" > "$CWD_FILE"

cd "$SCRIPT_DIR"
npm run build

# Only clean up processes owned by this launcher. Never reset OAuth state here:
# an ordinary restart or tunnel interruption must not invalidate an approval.
cleanup() {
    [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true
    [ -z "$TUNNEL_PID" ] || kill "$TUNNEL_PID" 2>/dev/null || true
    [ -z "$SERVER_PID" ] || wait "$SERVER_PID" 2>/dev/null || true
    [ -z "$TUNNEL_PID" ] || wait "$TUNNEL_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ngrok http "$PORT" --url "$TUNNEL_URL" --inspect=false --log=false >/dev/null 2>&1 &
TUNNEL_PID=$!
sleep 1.5
if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "ngrok 실행에 실패했습니다. authtoken과 도메인을 확인해 주세요."
    exit 1
fi

printf '\nServer URL: %s/mcp\nDirectory: %s\n' "$TUNNEL_URL" "$CWD_TARGET"
echo "연결 요청번호를 이 터미널에 입력하면 즉시 승인됩니다."
echo "연결 해제: stop / 승인 시간 초기화: reset time / 앱 종료 (기존 승인 유지): Ctrl+C"

SERVER_LOG="$SESSION_DIR/server.log"
(umask 077; : > "$SERVER_LOG")
chmod 600 "$SERVER_LOG"

MCP_HOST="127.0.0.1" \
MCP_PORT="$PORT" \
MCP_DEFAULT_CWD="$CWD_TARGET" \
MCP_PUBLIC_URL="$TUNNEL_URL" \
MCP_OAUTH_ENABLED=true \
MCP_OAUTH_APPROVAL_MODE=terminal \
MCP_OAUTH_SESSION_TTL_SECONDS=21600 \
MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS=600 \
MCP_ALLOW_NO_AUTH=false \
MCP_AUTH_TOKEN="" \
MCP_OAUTH_APPROVAL_KEY="" \
MCP_CONSOLE_TTY=true \
    node dist/src/server.js < /dev/tty > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
wait "$SERVER_PID"
