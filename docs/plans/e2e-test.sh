#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# holaOS + OpenCode Harness E2E Test Script
#
# Prerequisites:
#   1. opencode installed:  curl -fsSL https://opencode.ai/install | bash
#   2. API server built:   bun run --cwd runtime/api-server build
#   3. Harness host built: bun run --cwd runtime/harness-host build
#   4. A working LLM API key (set OPENAI_API_KEY or configure model proxy)
#
# Usage:
#   bash runtime/docs/plans/e2e-test.sh
# ─────────────────────────────────────────────────────────────────────────────

SANDBOX_ROOT="/tmp/holaboss-e2e"
PORT="${E2E_PORT:-3060}"
BASE_URL="http://127.0.0.1:${PORT}"
WORKSPACE_NAME="e2e-test-$(date +%s)"

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# ─── Step 0: Check prerequisites ────────────────────────────────────────────

log "Checking prerequisites..."

OPENCODE_BIN="${HOME}/.opencode/bin/opencode"
if [ ! -x "$OPENCODE_BIN" ]; then
  fail "opencode not found at $OPENCODE_BIN. Install: curl -fsSL https://opencode.ai/install | bash"
fi
log "  opencode: $($OPENCODE_BIN --version 2>/dev/null || echo 'binary found, version check needs platform binary')"

[ -f "runtime/api-server/dist/index.mjs" ] || fail "api-server not built. Run: bun run --cwd runtime/api-server build"
[ -f "runtime/harness-host/dist/index.mjs" ] || fail "harness-host not built. Run: bun run --cwd runtime/harness-host build"

# ─── Step 1: Prepare sandbox ────────────────────────────────────────────────

log "Preparing sandbox at ${SANDBOX_ROOT}..."
rm -rf "$SANDBOX_ROOT"
mkdir -p "${SANDBOX_ROOT}"/{workspace,state}

# Create a minimal workspace project
mkdir -p "${SANDBOX_ROOT}/workspace/${WORKSPACE_NAME}"
cat > "${SANDBOX_ROOT}/workspace/${WORKSPACE_NAME}/README.md" <<'EOF'
# E2E Test Workspace
This is a test workspace for validating the opencode harness integration.
EOF

# ─── Step 2: Write minimal runtime config ───────────────────────────────────

# Use pre-written config if available, otherwise generate from env
if [ -f "/tmp/holaboss-e2e/state/runtime-config.json" ]; then
  cp /tmp/holaboss-e2e/state/runtime-config.json "${SANDBOX_ROOT}/state/runtime-config.json"
  log "  Using pre-written runtime-config.json from /tmp/holaboss-e2e"
elif [ -n "${OPENAI_API_KEY:-}" ]; then
  log "  Using OPENAI_API_KEY from environment"
  cat > "${SANDBOX_ROOT}/state/runtime-config.json" <<EOF
{
  "runtime": {
    "mode": "oss",
    "default_model": "openai/gpt-4o-mini"
  },
  "providers": {
    "hb_openai": {
      "kind": "openai_compatible",
      "api_key": "${OPENAI_API_KEY}",
      "base_url": "https://api.openai.com/v1"
    }
  }
}
EOF
else
  log "  WARNING: no runtime-config.json and no OPENAI_API_KEY."
  log "  Create /tmp/holaboss-e2e/state/runtime-config.json first, or set OPENAI_API_KEY"
  cat > "${SANDBOX_ROOT}/state/runtime-config.json" <<'EOF'
{
  "runtime": {
    "mode": "oss",
    "default_model": "deepseek-custom/deepseek-v4-pro"
  }
}
EOF
fi

# ─── Step 3: Start the runtime API server ───────────────────────────────────

log "Starting runtime API server on port ${PORT}..."

export HB_SANDBOX_ROOT="$SANDBOX_ROOT"
export SANDBOX_RUNTIME_API_PORT="$PORT"
export SANDBOX_AGENT_HARNESS="${E2E_HARNESS:-opencode}"
export HOLABOSS_HOST_STATE_DB_PATH="${SANDBOX_ROOT}/state/host-state.db"
export HOLABOSS_RUNTIME_DB_PATH="${SANDBOX_ROOT}/state/host-state.db"
export HOLABOSS_CONTROL_PLANE_DB_PATH="${SANDBOX_ROOT}/state/control-plane.db"
export HOLABOSS_RUNTIME_CONFIG_PATH="${SANDBOX_ROOT}/state/runtime-config.json"
export HOLABOSS_RUNTIME_LOG_PATH="${SANDBOX_ROOT}/state/runtime.log"
export HOLABOSS_RUNTIME_WORKFLOW_BACKEND="local"
export HOLABOSS_DEFAULT_MODEL="openai/gpt-4o-mini"
export PROACTIVE_ENABLE_REMOTE_BRIDGE="0"
export HOLABOSS_EMBEDDED_RUNTIME="0"
export HOLABOSS_OPENCODE_BIN="$OPENCODE_BIN"

API_PID=""
cleanup() {
  log "Cleaning up..."
  if [ -n "$API_PID" ]; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  log "Done."
}
trap cleanup EXIT

node runtime/api-server/dist/index.mjs &
API_PID=$!

# Wait for server ready
log "Waiting for API server..."
for i in $(seq 1 30); do
  if curl -sf "${BASE_URL}/healthz" > /dev/null 2>&1; then
    log "  API server ready"
    break
  fi
  sleep 1
done
if ! curl -sf "${BASE_URL}/healthz" > /dev/null 2>&1; then
  fail "API server did not start within 30s"
fi

# ─── Step 4: Create workspace ───────────────────────────────────────────────

log "Creating workspace '${WORKSPACE_NAME}'..."
WORKSPACE_ID="ws-${WORKSPACE_NAME}"
curl -sf "${BASE_URL}/api/v1/workspaces" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{
    \"workspace_id\": \"${WORKSPACE_ID}\",
    \"name\": \"${WORKSPACE_NAME}\",
    \"directory\": \"${SANDBOX_ROOT}/workspace/${WORKSPACE_NAME}\"
  }" | jq .

# ─── Step 5: Create session ────────────────────────────────────────────────

log "Creating agent session..."
SESSION_RESP=$(curl -sf "${BASE_URL}/api/v1/agent-sessions" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{
    \"workspace_id\": \"${WORKSPACE_ID}\",
    \"kind\": \"main_session\",
    \"title\": \"E2E OpenCode Harness Test\"
  }")
echo "$SESSION_RESP" | jq .
SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.session.id // .session.session_id // empty')
if [ -z "$SESSION_ID" ]; then
  fail "Failed to create session. Response: $SESSION_RESP"
fi
log "  Session ID: ${SESSION_ID}"

# ─── Step 6: Send a test prompt (non-streaming) ────────────────────────────

log ""
log "═══════════════════════════════════════════════════════════"
log "  Sending test prompt via queue endpoint..."
log "═══════════════════════════════════════════════════════════"
log ""

QUEUE_RESP=$(curl -sf "${BASE_URL}/api/v1/agent-sessions/queue" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{
    \"workspace_id\": \"${WORKSPACE_ID}\",
    \"session_id\": \"${SESSION_ID}\",
    \"text\": \"Read the README.md file in the current workspace and tell me what it says. Be very brief.\"
  }" 2>&1) || true

echo "$QUEUE_RESP" | jq . 2>/dev/null || echo "$QUEUE_RESP"

if echo "$QUEUE_RESP" | jq -e '.input_id' > /dev/null 2>&1; then
  INPUT_ID=$(echo "$QUEUE_RESP" | jq -r '.input_id')
  log "  Input queued: ${INPUT_ID}"
else
  log "  Queue response did not contain input_id. Checking for error..."
  log "  Response: $QUEUE_RESP"
fi

# ─── Step 7: Wait for processing and check ─────────────────────────────────

if [ -n "${INPUT_ID:-}" ]; then
  log ""
  log "Waiting for run to complete (up to 120s)..."
  for i in $(seq 1 120); do
    STATE=$(curl -sf "${BASE_URL}/api/v1/agent-sessions/${SESSION_ID}/runtime-state?workspace_id=${WORKSPACE_ID}" 2>/dev/null || echo '{}')
    STATUS=$(echo "$STATE" | jq -r '.status // "unknown"')
    if [ "$STATUS" = "IDLE" ] && [ $i -gt 3 ]; then
      log "  Run completed (status: ${STATUS})"
      break
    fi
    if [ $((i % 10)) -eq 0 ]; then
      log "  ... still ${STATUS} (${i}s)"
    fi
    sleep 1
  done

  # Check turn results
  log ""
  log "Checking turn results..."
  curl -sf "${BASE_URL}/api/v1/agent-sessions/${SESSION_ID}/turn-results?workspace_id=${WORKSPACE_ID}" 2>/dev/null | jq '.[0:3]' 2>/dev/null || log "  No turn results found"
fi

# ─── Step 8: Streaming test ─────────────────────────────────────────────────

log ""
log "═══════════════════════════════════════════════════════════"
log "  Sending test prompt via streaming endpoint..."
log "═══════════════════════════════════════════════════════════"
log ""

curl -sf -N "${BASE_URL}/api/v1/agent-runs/stream" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{
    \"workspace_id\": \"${WORKSPACE_ID}\",
    \"session_id\": \"${SESSION_ID}\",
    \"instruction\": \"What is 2+2? Answer with just the number.\"
  }" 2>&1 | head -50 || log "  Stream endpoint test completed (or timed out)"

log ""
log "═══════════════════════════════════════════════════════════"
log "  E2E test complete. Check logs above for results."
log "═══════════════════════════════════════════════════════════"
log ""
log "Useful follow-up commands:"
log "  # Check opencode sessions"
log "  ls ~/.opencode/share/opencode/sessions/ 2>/dev/null || ls ~/.local/share/opencode/sessions/ 2>/dev/null"
log ""
log "  # Check runtime state DB"
log "  sqlite3 ${SANDBOX_ROOT}/state/host-state.db 'SELECT id, status FROM turn_results ORDER BY created_at DESC LIMIT 5;'"
log ""
log "  # Check runtime log"
log "  tail -50 ${SANDBOX_ROOT}/state/runtime.log"
log ""
log "  # Kill the API server"
log "  kill $API_PID"
