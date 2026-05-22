# OpenCode Harness Integration Plan

Status: **Phase 1-6 + Phase 5 Implemented**
Branch: `feat/opencode-harness-integration`
Created: 2026-05-19

## Goal

Add [opencode](https://github.com/opencode-ai/opencode) as a second harness adapter in holaOS runtime. opencode serves as the **execution engine** (LLM agent loop, provider, compaction), while holaOS continues to own **orchestration** (queue, state, tools, MCP hosting).

Key principles:
- opencode runs as a subprocess (`opencode serve`), communicated via HTTP API + Global SSE
- holaOS runtime tools (40+) are injected via MCP server configuration
- opencode is not forked or monkey-patched; all integration is through its public HTTP API
- opencode can be upgraded independently without breaking holaOS

## Architecture

```
holaOS api-server
  └── ts-runner (subprocess)
        └── harness-host (subprocess)
              └── opencode-adapter
                    │
                    ├── spawn: opencode serve --port=0
                    │     env: OPENCODE_CONFIG_CONTENT = { provider, mcp.servers, ... }
                    │
                    ├── SSE:  GET /global/event  (filtered by directory)
                    │     → maps EventV2 → RunnerOutputEvent JSONL → stdout
                    │
                    ├── POST /session                  → create session
                    ├── POST /session/{id}/prompt_async → send prompt
                    ├── POST /session/{id}/abort        → cancel/timeout
                    ├── POST /session/{id}/compact      → explicit compaction
                    ├── GET  /session/{id}/context       → inspect context window
                    │
                    └── lifecycle: heartbeat via SSE, timeout via abort
```

### Why Global SSE (`/global/event`) instead of Instance SSE (`/event`)

| | Instance SSE | Global SSE (chosen) |
|---|---|---|
| scope | single instance | all instances |
| requires workspace routing | yes | no |
| lifecycle binding | tied to instance scope | tied to server process |
| filtering | none needed | `event.directory === workspaceDir` |
| reuse potential | one connection per run | single connection serves multiple runs |

Global SSE is simpler: we only need the workspace directory path, no need to understand opencode's instance/project concepts. The 10s heartbeat also doubles as harness keepalive detection.

## Event Mapping: OpenCode EventV2 → holaOS RunnerOutputEvent

### Streaming Events

| OpenCode EventV2 | holaOS RunnerOutputEvent | Notes |
|---|---|---|
| `session.next.prompted` | `run_started` | Terminal start |
| `session.next.text.started` | (ignored) | No holaOS equivalent |
| `session.next.text.delta` | `output_delta` | `delta` field maps directly |
| `session.next.text.ended` | (ignored) | |
| `session.next.reasoning.started` | (ignored) | |
| `session.next.reasoning.delta` | `thinking_delta` | `delta` field maps directly |
| `session.next.reasoning.ended` | (ignored) | |
| `session.next.tool.input.started` | `tool_call` (phase: started) | Extract name, callID |
| `session.next.tool.input.delta` | (ignored) | Streaming tool args, no holaOS equivalent |
| `session.next.tool.input.ended` | (ignored) | |
| `session.next.tool.called` | `tool_call` (phase: started) | Full tool invocation with input |
| `session.next.tool.progress` | `tool_call` (phase: in_progress) | Progress update |
| `session.next.tool.success` | `tool_call` (phase: completed) | Extract callID, result |
| `session.next.tool.failed` | `tool_call` (phase: completed, error) | Extract callID, error |
| `session.next.step.started` | (internal tracking) | Track step count |
| `session.next.step.ended` | `run_completed` | Terminal; extract tokens/cost |
| `session.next.step.failed` | `run_failed` | Terminal |
| `session.next.compaction.started` | `auto_compaction_start` | |
| `session.next.compaction.delta` | `auto_compaction_delta` | New event type (optional) |
| `session.next.compaction.ended` | `auto_compaction_end` | |
| `session.next.retried` | (logged, not emitted) | Provider retry info |
| `session.next.agent.switched` | (logged) | Agent changed mid-loop |
| `session.next.model.switched` | (logged) | Model changed mid-loop |
| `server.heartbeat` | (keepalive) | Reset idle timer |
| `server.connected` | (lifecycle) | First SSE message confirms connection |

### Token Usage Mapping

OpenCode `session.next.step.ended` carries:
```json
{
  "tokens": {
    "input": 1234,
    "output": 567,
    "reasoning": 89,
    "cache": { "read": 100, "write": 50 }
  },
  "cost": 0.012
}
```

Maps to holaOS `run_completed.usage`:
```json
{
  "input_tokens": 1234,
  "uncached_input_tokens": 1134,
  "output_tokens": 567,
  "cached_input_tokens": 100,
  "cache_write_input_tokens": 50,
  "total_tokens": 1950,
  "estimated_cost_usd": 0.012
}
```

## Tool Strategy

### opencode built-in tools (kept as-is)

opencode provides these coding tools natively. They work within the workspace directory boundary and need no replacement:

| Tool | Purpose |
|------|---------|
| `bash` | Shell command execution |
| `read` | File reading |
| `edit` | Search/replace file editing |
| `write` | File writing |
| `glob` | File pattern matching |
| `grep` | Content search (ripgrep) |
| `webfetch` | URL content fetching |
| `websearch` | Web search |
| `question` | Ask user for input |
| `todo` | Todo list management |

### holaOS runtime tools (injected via MCP)

The 40+ holaOS runtime tools that opencode doesn't have are exposed as an MCP server. opencode discovers them through its native MCP support.

**New component: `runtime/harness-host/src/opencode-runtime-mcp-server.ts`**

This MCP server proxies tool calls to the holaOS API server:

```
opencode agent loop calls MCP tool (e.g. holaboss_delegate_task)
  → MCP server receives callTool request
    → HTTP POST to holaOS API (/api/v1/capabilities/runtime-tools/...)
      → Returns result to opencode
```

Runtime tools to expose via MCP:

| Category | Tools |
|----------|-------|
| Subagent orchestration | `holaboss_delegate_task`, `holaboss_get_subagent`, `holaboss_list_background_tasks`, `holaboss_cancel_subagent`, `holaboss_resume_subagent`, `holaboss_continue_subagent` |
| Workspace instructions | `holaboss_update_workspace_instructions` |
| Cronjobs | `holaboss_cronjobs_list`, `holaboss_cronjobs_create`, `holaboss_cronjobs_get`, `holaboss_cronjobs_update`, `holaboss_cronjobs_delete` |
| Onboarding | `holaboss_onboarding_status`, `holaboss_onboarding_complete` |
| Image generation | `image_generate` |
| Downloads | `download_url` |
| Reports | `write_report` |
| Terminal sessions | `terminal_sessions_list`, `terminal_session_start`, `terminal_session_get`, `terminal_session_read`, `terminal_session_wait`, `terminal_session_send_input`, `terminal_session_signal`, `terminal_session_close` |
| Workspace data (SQLite) | `workspace_data_list_tables`, `workspace_data_describe_table`, `workspace_data_sample_rows`, `workspace_data_query` |
| Scratchpad | `holaboss_scratchpad_read`, `holaboss_scratchpad_write` |
| Browser | `browser_get_state`, `browser_find`, `browser_act`, `browser_wait`, `browser_select_tab`, etc. |

The MCP server implementation uses `mcporter` (already a holaOS dependency) or the official MCP SDK to expose a stdio-based MCP server. The `OPENCODE_CONFIG_CONTENT` injection registers it:

```json
{
  "mcp": {
    "servers": {
      "holaboss-runtime": {
        "type": "local",
        "command": "node",
        "args": ["dist/opencode-runtime-mcp-server.mjs"],
        "env": {
          "HOLABOSS_RUNTIME_API_URL": "http://...",
          "HOLABOSS_SESSION_ID": "...",
          "HOLABOSS_WORKSPACE_ID": "..."
        }
      }
    }
  }
}
```

## Provider Configuration

opencode's provider system is configured via `OPENCODE_CONFIG_CONTENT`. holaOS injects its model proxy:

```json
{
  "provider": {
    "holaboss-proxy": {
      "type": "openai",
      "url": "${HOLABOSS_MODEL_PROXY_URL}",
      "apiKey": "${HOLABOSS_API_KEY}",
      "models": {
        "default": "${HOLABOSS_MODEL_ID}"
      }
    }
  }
}
```

This replaces the pi harness's manual `AuthStorage` + `ModelRegistry` + provider patching with a declarative config.

## Compaction

opencode has built-in auto-compaction (`packages/opencode/src/session/compaction.ts`, 639 lines). Key features:
- Automatic on context overflow
- Incremental summary updates (preserves previous summary)
- Configurable tail turns and preserve_recent_tokens
- Pruning of old tool outputs (lightweight)
- Split-turn handling for oversized contexts

**No holaOS patches needed** — unlike pi which required 300+ lines of monkey-patching.

holaOS can optionally trigger explicit compaction via `POST /session/{id}/compact` if session-checkpoint logic decides it's needed before a run.

## Session State

opencode persists sessions in SQLite (Drizzle ORM). holaOS doesn't need to read or manage this state directly:
- Session continuity: opencode reuses sessions by ID across prompts
- Ephemeral followup: `POST /session/{id}/prompt` with the same sessionID
- Session ID mapping: holaOS maps its `session_id` → opencode `sessionID` (stored in harness session state)

The `persistWorkspaceHarnessSessionId` / `readWorkspaceHarnessSessionId` mechanism from `ts-runner-session-state.ts` already supports multi-harness storage.

## Timeout & Abort

| Scenario | Mechanism |
|----------|-----------|
| Hard timeout | `setTimeout` in adapter → `POST /session/{id}/abort` → `proc.kill()` |
| Idle timeout | No text/reasoning delta for N seconds → abort |
| Heartbeat keepalive | Global SSE `server.heartbeat` every 10s resets idle timer |
| Subagent sliding deadline | Same as pi — `HOLABOSS_SUBAGENT_HARNESS_RUN_TIMEOUT_S` env |

## Files to Create/Modify

### New Files

| File | Purpose | Est. Lines |
|------|---------|------------|
| `runtime/harnesses/src/opencode.ts` | HarnessDefinition + RuntimeHarnessAdapter | ~80 |
| `runtime/harness-host/src/opencode.ts` | Core adapter: spawn server, SSE bridge, event mapping, abort | ~600-800 |
| `runtime/harness-host/src/opencode-contracts.ts` | Request/response types for opencode harness | ~100 |
| `runtime/harness-host/src/opencode-runtime-mcp-server.ts` | MCP server wrapping holaOS runtime tools | ~400-500 |
| `runtime/harness-host/src/opencode.test.ts` | Event mapping, SSE parsing, lifecycle tests | ~800-1000 |
| `runtime/harnesses/src/opencode.test.ts` | HarnessDefinition unit tests | ~80 |

### Files to Modify

| File | Change |
|------|--------|
| `runtime/harnesses/src/index.ts` | Add opencodeHarnessDefinition to HARNESS_DEFINITIONS |
| `runtime/harness-host/src/harness-registry.ts` | Add opencode to HARNESS_HOST_IMPLEMENTATIONS |
| `runtime/api-server/src/harness-registry.ts` | Add opencodeRuntimeHarnessPlugin to HARNESS_PLUGINS |
| `runtime/api-server/src/harness-conformance.test.ts` | Update expected harness list |
| `runtime/api-server/src/harness-registry.test.ts` | Update expected adapter list |
| `runtime/harness-host/src/harness-registry.test.ts` | Update expected plugin list |
| `runtime/harness-host/src/contracts.ts` | Add opencode request type (if not reusing PiRequest) |

### Files That Don't Need Changes

These are harness-agnostic and work as-is:
- `runtime/api-server/src/runner-worker.ts` — subprocess management, harness-independent
- `runtime/api-server/src/queue-worker.ts` — queue processing, harness-independent
- `runtime/api-server/src/claimed-input-executor.ts` — uses node runner mock, only pi compaction tests reference pi
- `runtime/api-server/src/ts-runner.ts` — delegates to harness adapter via testDeps()
- `runtime/api-server/src/ts-runner.test.ts` — 100% reusable via mock pattern
- `runtime/api-server/src/ts-runner-session-state.test.ts` — already tests multi-harness
- `runtime/state-store/` — fully harness-agnostic
- `runtime/deploy/` — packaging, no change needed

## Implementation Phases

### Phase 1: Skeleton — Harness Definition + Registration + Test Infrastructure

**Goal:** opencode appears as a registered harness; test infrastructure ready.

**Implementation tasks:**

1. [ ] Create `runtime/harnesses/src/opencode.ts` — harness definition:
   ```typescript
   capabilities: {
     requiresBackend: false,
     supportsStructuredOutput: false,
     supportsWaitingUser: true,
     supportsSkills: true,
     supportsMcpTools: true,
   }
   ```

2. [ ] Register in `runtime/harnesses/src/index.ts`:
   ```typescript
   export const HARNESS_DEFINITIONS = [piHarnessDefinition, opencodeHarnessDefinition] as const
   export const DEFAULT_HARNESS_ID = "pi"  // keep pi as default
   ```

3. [ ] Register in `runtime/harness-host/src/harness-registry.ts`

4. [ ] Add plugin entry in `runtime/api-server/src/harness-registry.ts`

5. [ ] Update 3 conformance/registry test files

6. [ ] Create `runtime/harness-host/src/test-util/opencode-server-mock.ts`:
   - Lightweight HTTP server simulating opencode's API surface
   - `POST /session`, `POST /session/:id/prompt_async`, `POST /session/:id/abort`
   - `GET /global/event` SSE with configurable event scripts
   - Used by all subsequent test phases

7. [ ] Create `runtime/harness-host/src/test-util/opencode-sse-parser.ts`:
   - Parse `text/event-stream` into typed EventV2 objects

8. [ ] Create `runtime/harnesses/src/opencode.test.ts` (~10 cases):
   - HarnessDefinition shape, capabilities, `buildRunnerPrepPlan()`, `buildHarnessHostRequest()`

**Verify:**
```bash
bun test runtime/api-server/src/harness-conformance.test.ts
bun test runtime/api-server/src/harness-registry.test.ts
bun test runtime/harness-host/src/harness-registry.test.ts
bun test runtime/harnesses/src/opencode.test.ts
```

### Phase 2: Core Adapter — Event Bridge + Lifecycle

**Goal:** opencode harness can execute a prompt and stream events back to holaOS.

**Implementation tasks:**

1. [ ] Create `runtime/harness-host/src/opencode-contracts.ts`:
   - Request/response types for opencode harness
   - EventV2 → RunnerOutputEvent mapping table (documented)

2. [ ] Create `runtime/harness-host/src/opencode.ts` with `runOpencode()`:
   - Spawn `opencode serve --port=0` (or use mock server in tests)
   - Wait for `opencode server listening on <url>` on stdout
   - Connect to `GET /global/event` SSE
   - Create session via `POST /session` (with `x-opencode-directory` header)
   - Send prompt via `POST /session/{id}/prompt_async`
   - Filter SSE events by `event.directory === workspaceDir`
   - Map EventV2 → RunnerOutputEvent (stdout JSONL)
   - Idle timeout: no text/reasoning delta for N seconds → `POST /session/{id}/abort`
   - Heartbeat: `server.heartbeat` resets idle timer
   - Hard timeout: absolute deadline → abort + proc.kill()
   - Cleanup: SIGTERM + SIGKILL in finally block

3. [ ] Create `runtime/harness-host/src/opencode.test.ts` (~25 cases):
   - Event mapping: all 14 event type mappings (see Test Coverage Analysis)
   - Lifecycle: spawn, SSE, prompt, timeout, crash, abort, heartbeat
   - Directory filtering: only matching events processed
   - Token usage normalization
   - Uses `opencode-server-mock.ts` for deterministic testing

**Verify:**
```bash
bun test runtime/harness-host/src/opencode.test.ts
bun test runtime/api-server/src/runner-worker.test.ts       # harness-agnostic, must still pass
bun test runtime/api-server/src/ts-runner.test.ts           # harness-agnostic, must still pass
bun test runtime/api-server/src/ts-runner-session-state.test.ts  # multi-harness, must still pass
```

**POC verification (manual):**
- Set `HOLABOSS_SELECTED_HARNESS=opencode`
- Send a prompt through holaOS API
- Verify streaming output deltas appear
- Verify `run_completed` is emitted

### Phase 3: Runtime Tools — MCP Server Proxy

**Goal:** holaOS runtime tools are available to opencode agents via MCP.

**Implementation tasks:**

1. [ ] Create `runtime/harness-host/src/opencode-runtime-mcp-server.ts`:
   - stdio-based MCP server using `@modelcontextprotocol/sdk`
   - Exposes holaOS runtime tools as MCP tools
   - Each tool call proxies to `POST /api/v1/capabilities/runtime-tools/{toolId}`
   - Headers: `x-holaboss-workspace-id`, `x-holaboss-session-id`, `x-holaboss-input-id`
   - Workspace boundary enforcement at MCP layer (validate file paths)

2. [ ] Wire MCP server injection into `opencode.ts` adapter:
   - `OPENCODE_CONFIG_CONTENT` includes `mcp.servers.holaboss-runtime` config
   - MCP server binary path resolved from harness-host bundle

3. [ ] Browser tools: expose as additional MCP tools or separate MCP server

4. [ ] Create `runtime/harness-host/src/opencode-runtime-mcp-server.test.ts` (~15 cases):
   - Tool proxy: callTool → HTTP POST → result
   - Error handling: HTTP error → MCP error response
   - Workspace boundary: path outside workspace → rejected
   - Session ID header propagation
   - Abort signal during tool execution
   - Uses `fetchImpl` mock pattern from `pi-runtime-tools.test.ts`

**Verify:**
```bash
bun test runtime/harness-host/src/opencode-runtime-mcp-server.test.ts
bun test runtime/harness-host/src/opencode.test.ts           # regression
bun test runtime/api-server/src/queue-worker.test.ts         # harness-agnostic, must still pass
```

### Phase 4: Compaction + Session State + Retry

**Goal:** Feature parity with pi harness for compaction, session persistence, and retry recovery.

**Implementation tasks:**

1. [ ] **Compaction integration:**
   - opencode auto-compaction emits `session.next.compaction.*` events via SSE
   - Map to `auto_compaction_start` / `auto_compaction_end` RunnerOutputEvents
   - holaOS session-checkpoint triggers explicit compaction via `POST /session/{id}/compact`
   - Verify compaction result via `GET /session/{id}/context`

2. [ ] **Session persistence mapping:**
   - Map holaOS `session_id` ↔ opencode `sessionID`
   - Use `persistWorkspaceHarnessSessionId` for reuse across runs
   - Support ephemeral followup (reuse session for multi-turn)
   - Session reuse: same `sessionID` in `POST /session/{id}/prompt_async`

3. [ ] **Retry continuation:**
   - Map `session.next.retried` events (provider retries) → log, don't emit
   - Context overflow: opencode handles internally, emits compaction events
   - Persistent overflow: detect repeated compaction → `run_failed` with session-reset-required

4. [ ] **Subagent coordination:**
   - Disable opencode's built-in `task` tool (or leave as secondary)
   - holaOS `holaboss_delegate_task` via MCP delegates to holaOS subagent system

5. [ ] **Workspace skills:**
   - opencode `skill` tool loads SKILL.md files
   - Align skill directory with holaOS workspace skill dirs
   - Inject skill dirs via `OPENCODE_CONFIG_CONTENT` or workspace config

6. [ ] Create `runtime/harness-host/src/opencode-compaction.test.ts` (~10 cases):
   - Mirrors the 12 pi compaction tests from `claimed-input-executor.test.ts`
   - Uses `opencode-server-mock.ts` with compaction scenario scripts
   - Tests: auto-compaction, explicit compact, overflow retry, persistent overflow, subagent retry, main-session retry, pre-run compaction, background followup

**Verify:**
```bash
bun test runtime/harness-host/src/opencode-compaction.test.ts
bun test runtime/harness-host/src/opencode.test.ts              # regression
bun test runtime/harness-host/src/opencode-runtime-mcp-server.test.ts  # regression
bun test runtime/api-server/src/claimed-input-executor.test.ts  # pi tests still pass
```

### Phase 5: Production Hardening

Status: **Implemented**
Completed: 2026-05-22

1. [x] Error handling: SSE disconnect (reader done → `run_failed`), server crash (proc exit race via `Promise.race`)
2. [x] Logging: structured JSON to stderr (session_id, input_id, workspace_id context)
3. [x] Resource cleanup: `detached: true` + `proc.unref()` + SIGTERM → grace period → SIGKILL
4. [x] Configuration: `HOLABOSS_OPENCODE_BIN` env var, startup/timeout constants
5. [x] Full regression: 49 tests pass across 7 test files
6. [x] Compaction tests: 11 cases in `opencode-compaction.test.ts`
7. [x] MCP server tests: 10 cases in `opencode-runtime-mcp-server.test.ts`
8. [ ] Metrics: token usage, latency, compaction frequency (deferred)
9. [ ] Sentry integration (deferred per user request)

**Final verification:**
```bash
# All harness-agnostic layers
bun test runtime/api-server/src/runner-worker.test.ts
bun test runtime/api-server/src/queue-worker.test.ts
bun test runtime/api-server/src/ts-runner.test.ts
bun test runtime/api-server/src/ts-runner-session-state.test.ts
bun test runtime/state-store/

# Updated registry/conformance
bun test runtime/api-server/src/harness-conformance.test.ts
bun test runtime/api-server/src/harness-registry.test.ts
bun test runtime/harness-host/src/harness-registry.test.ts

# New opencode tests
bun test runtime/harness-host/src/opencode.test.ts
bun test runtime/harness-host/src/opencode-compaction.test.ts
bun test runtime/harness-host/src/opencode-runtime-mcp-server.test.ts
bun test runtime/harnesses/src/opencode.test.ts

# Pi harness still works (no regressions)
bun test runtime/harness-host/src/pi.test.ts
bun test runtime/api-server/src/claimed-input-executor.test.ts

# Full runtime test suite
bun run runtime:test
```

## Test Coverage Analysis

### Existing Tests: Coverage Matrix

The holaOS test suite is deliberately structured in layers. Most tests mock the harness via a **node runner script** (a temporary JS file that emits JSONL events to stdout), making them harness-agnostic by design. Only the compaction/retry tests reach into pi's `SessionManager` directly.

#### Layer 1: Fully Harness-Agnostic (100% reusable, 0 changes needed)

| Test File | Lines | Cases | What It Tests | Why Harness-Agnostic |
|-----------|-------|-------|---------------|---------------------|
| `runner-worker.test.ts` | 535 | ~20 | Subprocess spawn, stdout parsing, timeout, heartbeat, abort | Uses temp JS script mock, never references pi |
| `queue-worker.test.ts` | 1039 | ~15 | Priority, concurrency, claim/recovery, expired claims | Pure queue logic, no harness code |
| `ts-runner.test.ts` | ~2500 | ~30 | Request decode, bootstrap, event relay, session state | Uses `testDeps()` factory that mocks harness adapter |
| `ts-runner-session-state.test.ts` | 135 | ~5 | Multi-harness session storage read/write | Already tests `pi` + `other` dual harness |
| `ts-runner-events.test.ts` | ~100 | ~5 | Push callback, stdout output format | Pure event formatting |
| `runner-prep*.test.ts` | ~300 | ~10 | MCP server config, fingerprint | Harness-independent prep |
| All `runtime/state-store/` tests | ~5000 | ~40 | SQLite CRUD for all entities | No harness concept |

**Total reusable: ~120 test cases**

#### Layer 2: Partially Harness-Specific (claimed-input-executor.test.ts)

57 test cases total. Uses `setNodeRunnerCommand()` with temp JS scripts for most tests — this mock pattern is harness-agnostic. However, **12 test cases** directly use pi's `SessionManager`:

| # | Test Case | Lines | pi Dependency | opencode Equivalent |
|---|-----------|-------|---------------|-------------------|
| 1 | Context-budget telemetry from replay clipping and checkpoint queueing | 689-830 | `openPiSessionManager()`, `piSessionMessageTexts()` | Need opencode context inspection via `GET /session/{id}/context` |
| 2 | Main-session followups on bound session snapshot | 1975-2050 | `openPiSessionManager()`, `buildSessionContext()` | Need opencode session reuse via sessionID |
| 3 | Queues background session checkpoint when PI context crosses compaction threshold | 4337-4435 | `openPiSessionManager()`, `writeEntries()` | Need opencode compaction trigger via `POST /session/{id}/compact` |
| 4 | Waits for in-flight session checkpoint before starting runner | 4439-4515 | pi session file lock | Need opencode session busy state check |
| 5 | Compacts a reused PI session before smaller-window model run | 4671-4860 | `openPiSessionManager()`, `buildSessionContext()`, `writeEntries()` | opencode auto-handles; test that `POST /compact` works |
| 6 | Synthesizes turn request snapshot for main-session background followups | 4864-5165 | pi session tree manipulation | opencode session message history via `GET /session/{id}/message` |
| 7 | Continues when pre-run compaction cannot get below maintenance threshold | 5170-5340 | pi compaction result parsing | opencode compaction result from SSE events |
| 8 | Retries once after provider context overflow + runtime compaction | 5343-5580 | pi session snapshot + compaction | opencode handles overflow internally; test retry from SSE `session.next.retried` |
| 9 | Retries long-running terminated PI subagent runs after snapshot compaction | 5583-5790 | pi session snapshot | opencode session restore + continue |
| 10 | Retries long-running terminated PI main-session runs after snapshot compaction | 5791-5975 | pi session snapshot | opencode session restore + continue |
| 11 | Does not retry short terminated PI provider errors | 5976-6100 | pi session state check | opencode step.failed event |
| 12 | Fails with session reset required when overflow persists after runtime recovery retry | 6103-6302 | pi session compaction | opencode overflow detection from SSE |

**The remaining 45 test cases** in this file are harness-agnostic — they use the node runner script mock pattern.

#### Layer 3: Harness-Definition-Specific (must update, small effort)

| Test File | Cases | Change Needed |
|-----------|-------|---------------|
| `harness-conformance.test.ts` | ~10 | Add opencode to expected `HARNESS_DEFINITIONS` list + test its capabilities |
| `harness-registry.test.ts` (api-server) | ~8 | Add opencode adapter to expected list |
| `harness-registry.test.ts` (harness-host) | ~3 | Add opencode plugin to expected list |

### Test Gap Summary

```
Existing reusable tests:      ~120 cases (Layer 1) + 45 cases (Layer 2) = ~165
Existing tests needing update:  ~3 files, ~21 cases total (Layer 3)
Existing tests NOT reusable:    12 compaction/retry cases in Layer 2
New tests needed:               ~40-50 cases across 3 new test files
```

### Test Infrastructure to Build

#### `opencode-server-mock.ts` — Mock HTTP Server for Integration Tests

The existing test suite uses `setNodeRunnerCommand()` with temp JS scripts that emit JSONL events to stdout. For opencode, we need a mock **HTTP server** that simulates the opencode `serve` API surface, so that `claimed-input-executor.test.ts` compaction tests can run against opencode too.

This mock server implements:
- `POST /session` → returns `{ id: "mock-session-1" }`
- `POST /session/:id/prompt` → returns mock assistant message
- `POST /session/:id/prompt_async` → returns 204
- `POST /session/:id/abort` → returns 200
- `POST /session/:id/compact` → triggers mock compaction events
- `GET /session/:id/context` → returns mock context messages
- `GET /session/:id/message` → returns mock messages
- `GET /global/event` → SSE stream with configurable events

The mock accepts a **scenario script** (JSON) that defines what events to emit and when, enabling deterministic replay of:
- Happy path streaming
- Compaction triggers
- Context overflow + retry
- Provider errors
- Heartbeat patterns

Location: `runtime/harness-host/src/test-util/opencode-server-mock.ts` (~400 lines)

#### `opencode-sse-parser.ts` — Shared Test Utility

Parses Global SSE `text/event-stream` into typed EventV2 objects. Used by both the adapter tests and the mock server to verify round-trip correctness.

Location: `runtime/harness-host/src/test-util/opencode-sse-parser.ts` (~100 lines)

### New Test Files

| Test File | Est. Cases | What It Tests |
|-----------|------------|---------------|
| `runtime/harnesses/src/opencode.test.ts` | ~10 | HarnessDefinition shape, capabilities, `buildRunnerPrepPlan()`, `buildHarnessHostRequest()` |
| `runtime/harness-host/src/opencode.test.ts` | ~25 | Core adapter: event mapping, SSE parsing, session lifecycle, timeout/abort |
| `runtime/harness-host/src/opencode-runtime-mcp-server.test.ts` | ~15 | MCP server: tool proxy, error handling, workspace boundary |
| `runtime/harness-host/src/opencode-compaction.test.ts` | ~10 | Compaction triggers, context overflow, retry scenarios (mirrors the 12 pi compaction tests) |

### Key Test Scenarios

#### Event Mapping (`opencode.test.ts`, ~25 cases)

| Scenario | Input (EventV2) | Expected Output (RunnerOutputEvent) |
|----------|----------------|-------------------------------------|
| Text streaming | `session.next.text.delta` | `output_delta` with `delta` field |
| Reasoning streaming | `session.next.reasoning.delta` | `thinking_delta` with `delta` field |
| Tool invocation start | `session.next.tool.called` | `tool_call` phase=started, name + callID |
| Tool progress | `session.next.tool.progress` | `tool_call` phase=in_progress |
| Tool success | `session.next.tool.success` | `tool_call` phase=completed, result |
| Tool failure | `session.next.tool.failed` | `tool_call` phase=completed, error |
| Step completed | `session.next.step.ended` | `run_completed` with token usage |
| Step failed | `session.next.step.failed` | `run_failed` with error |
| Compaction started | `session.next.compaction.started` | `auto_compaction_start` |
| Compaction ended | `session.next.compaction.ended` | `auto_compaction_end` |
| Unknown event type | `session.next.agent.switched` | Ignored (no output) |
| Non-matching directory | `directory !== workspaceDir` | Filtered out (no output) |
| Heartbeat | `server.heartbeat` | No output, reset idle timer |
| Connected | `server.connected` | No output, mark SSE ready |
| Multiple tool calls interleaved | tool.called A, tool.called B, tool.success A, tool.success B | Correct ordering preserved |
| Token usage normalization | step.ended with tokens/cost | Correct `usage` field mapping |

#### Lifecycle (`opencode.test.ts`)

| Scenario | Validation |
|----------|------------|
| Happy path: spawn → SSE → prompt → stream → completed → cleanup | All events emitted, proc killed |
| Timeout: no response within N seconds | `POST /abort` called, `run_failed` emitted |
| Server crash: process exits mid-run | `run_failed` emitted, no hang |
| SSE disconnect: connection drops | Reconnect attempt or `run_failed` |
| Heartbeat: `server.heartbeat` resets idle timer | No premature timeout |
| Abort signal from harness-host | `POST /abort` called, cleanup complete |
| Server startup timeout: no "listening" message | `run_failed` with startup error |
| Concurrent directory filtering | Only matching directory events processed |

#### Compaction (`opencode-compaction.test.ts`, ~10 cases)

Mirrors the 12 pi compaction tests in `claimed-input-executor.test.ts` but uses the opencode mock server:

| Scenario | opencode Mechanism | Validation |
|----------|-------------------|------------|
| Auto-compaction triggers on overflow | opencode emits `compaction.started` → `compaction.ended` via SSE | `auto_compaction_start/end` events emitted to holaOS |
| Explicit compaction via session-checkpoint | `POST /session/{id}/compact` | Compaction events appear in SSE |
| Compaction preserves context | `GET /session/{id}/context` returns post-compaction messages | Context reduced, summary present |
| Context overflow + retry | opencode emits `retried` + compaction | holaOS sees retry + compaction events |
| Persistent overflow after retry | Multiple overflow events | `run_failed` with session-reset-required |
| Subagent run retry after termination | Restore subagent session + continue | Retry events correct |
| Main-session retry after termination | Restore main session + continue | Retry events correct |
| No retry for short provider errors | `step.failed` without retryable error | Immediate `run_failed`, no retry |
| Pre-run compaction for smaller model window | `POST /compact` before prompt | Compaction completes before prompt sent |
| Compaction during background followup | Compact + send followup prompt | Correct ordering |

#### MCP Server (`opencode-runtime-mcp-server.test.ts`, ~15 cases)

| Scenario | Validation |
|----------|------------|
| Tool proxy: callTool → HTTP POST → result | Correct tool name, args, headers |
| Error handling: HTTP 500 → MCP error | Error message propagated |
| Error handling: HTTP timeout → MCP error | Timeout propagated |
| Workspace boundary: path inside workspace | Allowed |
| Workspace boundary: path outside workspace | Rejected with error |
| Missing API URL env var | Graceful startup failure |
| Multiple tool calls in sequence | Each proxied independently |
| Large tool result (truncation) | Result truncated if exceeds limit |
| Session ID header propagation | `x-holaboss-session-id` present |
| Abort signal during tool execution | MCP call cancelled |
| Tool not found in registry | MCP error "tool not found" |
| Browser tools proxy | CDP commands forwarded correctly |
| Terminal session tools proxy | Terminal lifecycle forwarded |
| Workspace data tools proxy | SQL queries forwarded |
| Subagent delegation tool proxy | Delegate request forwarded |

### Test Patterns to Follow

| Pattern | Source | Reuse |
|---------|--------|-------|
| `baseRequest()` factory | `pi.test.ts` | Copy and adapt for opencode request shape |
| `fetchImpl` mock | `pi-browser-tools.test.ts`, `pi-runtime-tools.test.ts` | Reuse for MCP server tests |
| Temp dir + fs | All test files | Reuse for workspace directory tests |
| `process.stdout.write` monkey-patch | `pi.test.ts` | Reuse for JSONL output tests |
| `RuntimeStateStore` temp DB | `claimed-input-executor.test.ts` | Reuse for integration tests |
| Node runner script mock | `runner-worker.test.ts` | Pattern reuse for `opencode-server-mock.ts` |
| `setNodeRunnerCommand()` | `claimed-input-executor.test.ts` | Pattern: inject custom runner that wraps opencode mock server |

### Existing Tests Update Checklist

| File | Change | Effort |
|------|--------|--------|
| `harness-conformance.test.ts` | Add opencode to `HARNESS_DEFINITIONS` list; add capability assertions | Small (~30 lines) |
| `harness-registry.test.ts` (api-server) | Add opencode adapter to expected list | Small (~10 lines) |
| `harness-registry.test.ts` (harness-host) | Add opencode plugin to expected list | Small (~5 lines) |

### Regression Safety Net

After all changes, the following commands must pass with **zero failures**:

```bash
# Harness-agnostic layers (should pass without changes)
bun test runtime/api-server/src/runner-worker.test.ts
bun test runtime/api-server/src/queue-worker.test.ts
bun test runtime/api-server/src/ts-runner.test.ts
bun test runtime/api-server/src/ts-runner-session-state.test.ts
bun test runtime/state-store/

# Updated registry/conformance tests
bun test runtime/api-server/src/harness-conformance.test.ts
bun test runtime/api-server/src/harness-registry.test.ts
bun test runtime/harness-host/src/harness-registry.test.ts

# New opencode tests
bun test runtime/harness-host/src/opencode.test.ts
bun test runtime/harness-host/src/opencode-compaction.test.ts
bun test runtime/harness-host/src/opencode-runtime-mcp-server.test.ts
bun test runtime/harnesses/src/opencode.test.ts

# Full claimed-input-executor (45 agnostic + 12 pi-specific still pass with pi)
bun test runtime/api-server/src/claimed-input-executor.test.ts
```

## Open Questions

1. **opencode EventV2 stability**: EventV2 is behind an experimental flag. Need to verify it's enabled by default in `opencode serve` mode, or whether we should use the legacy Bus events via `/event` as fallback.

2. **opencode binary distribution**: How to bundle or locate the opencode binary? Options:
   - npm dependency (`@opencode-ai/opencode` if published)
   - Pre-built binary in holaOS deploy bundle
   - System PATH (user-installed)

3. **opencode session reuse vs. ephemeral**: Should we create a new opencode session per holaOS input, or reuse across inputs within the same holaOS session? Reuse enables multi-turn context but complicates session state management.

4. **opencode's `task` tool vs. holaOS subagents**: opencode has a built-in `task` tool for subagent delegation. Should holaOS's `holaboss_delegate_task` via MCP replace it, or should they coexist? Recommendation: use holaOS subagent system for consistency with the rest of the platform.

5. **opencode built-in tool overlap**: opencode's `bash`, `read`, `edit` etc. work natively. The MCP-injected runtime tools (terminal sessions, workspace data) complement but don't replace them. No conflict expected.

## Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| opencode SSE format changes | High | Low | Pin opencode version; integration tests catch breakage |
| opencode serve startup latency | Medium | Medium | Reuse server process across runs; connection pooling |
| EventV2 experimental flag disabled | High | Medium | Fallback to legacy Bus events; file upstream issue |
| MCP server stdio protocol mismatch | Medium | Low | Use official MCP SDK; test against opencode's MCP client |
| opencode process leak on crash | High | Medium | PID tracking + SIGTERM/SIGKILL in finally block; process group kill |
| Token usage field mismatch | Low | Medium | Adapter normalizes to holaOS format; test with real providers |

## Success Criteria

- [ ] `HOLABOSS_SELECTED_HARNESS=opencode` produces correct streaming output for a coding task
- [ ] holaOS runtime tools are accessible to opencode agent via MCP
- [ ] Compaction triggers automatically and preserves context
- [ ] Timeout/abort kills opencode run cleanly
- [ ] All new test files pass
- [ ] All existing tests pass (no regressions)
- [ ] opencode can be upgraded to latest version without breaking holaOS integration

---

## Phase 6: Injection Gap Fixes

Status: **Implemented**
Added: 2026-05-20
Completed: 2026-05-20

### Problem

When using the opencode harness, several holaOS features are silently lost because `runOpencode()` receives the data but doesn't use it. The pi harness has rich injection logic; opencode needs equivalent wiring.

### Gap Analysis

| Feature | pi harness | opencode harness | Severity |
|---------|-----------|-----------------|----------|
| System prompt | ✅ full (with todo-resume patch) | ⚠ partial (raw, no patch) | Medium |
| Context messages / Memory | ✅ inlined into prompt | ❌ received but discarded | **Critical** |
| Workspace skills | ✅ loaded as skill tools | ❌ not loaded or injected | **Critical** |
| Tool enablement map | ✅ filters enabled tools | ❌ not forwarded | Medium |
| MCP servers | ✅ direct binding | ✅ via config | OK |
| Runtime MCP proxy | N/A | ✅ works when API URL present | OK |
| Attachments | ✅ inlined (base64/text) | ❌ discarded | Medium |
| Image URLs | ✅ fetched and inlined | ❌ discarded | Medium |
| Thinking value | ✅ configured | ❌ not forwarded | Low |
| Browser tools (direct) | ✅ injected | ❌ only via MCP proxy | Low |

### Fix Plan

#### 6.1 Context Messages Injection [Critical]

`request.context_messages` contains recalled memory, user context, scratchpad, evolve candidates, recent runtime context — all composed by `agent-runtime-config.ts`.

**Approach**: Append context messages to the instruction text before sending to opencode.

```typescript
// In runOpencode(), before building promptPayload:
let instruction = request.instruction;
if (request.context_messages?.length) {
  const contextBlock = request.context_messages
    .map((msg, i) => `[Runtime Context ${i + 1}]\n${msg}\n[/Runtime Context ${i + 1}]`)
    .join("\n\n");
  instruction = `${contextBlock}\n\n${instruction}`;
}
```

This mirrors what pi does in `runtimeContextMessagesBlock()`.

#### 6.2 Workspace Skills Injection [Critical]

`request.workspace_skill_dirs` contains paths to skill directories (each has a `SKILL.md` + supporting files).

**Approach**: Symlink each skill directory into `<workspace_dir>/.opencode/skills/<skill_name>/` before spawning opencode. Clean up symlinks after run completes.

```typescript
// Before spawn:
const skillsDir = path.join(request.workspace_dir, ".opencode", "skills");
fs.mkdirSync(skillsDir, { recursive: true });

const skillLinks: string[] = [];
for (const dir of request.workspace_skill_dirs ?? []) {
  const name = path.basename(dir);
  const link = path.join(skillsDir, name);
  if (!fs.existsSync(link)) {
    fs.symlinkSync(dir, link);
    skillLinks.push(link);
  }
}

// In cleanup():
for (const link of skillLinks) {
  fs.unlinkSync(link);
}
```

This leverages opencode's native skill loading from `.opencode/skills/`.

#### 6.3 System Prompt Todo-Resume Patch [Medium]

Pi applies todo-resume instruction patching via `effectiveSystemPromptForRequest()`. Opencode passes the raw system prompt.

**Approach**: Import and apply the same patching function, or extract it into a shared utility.

#### 6.4 Attachments and Image URLs [Medium]

`request.attachments` and `request.image_urls` are received but discarded.

**Approach**: Add attachment parts to the opencode prompt payload's `parts` array:

```typescript
// Build parts array
const parts: unknown[] = [{ type: "text", text: instruction }];

for (const url of request.image_urls ?? []) {
  parts.push({ type: "file", url, mime: "image/png" });
}

// For attachments, inline text content or reference file paths
```

#### 6.5 Tool Enablement Map [Medium]

`request.tools` is a `Record<string, boolean>` map of enabled/disabled tools. Opencode gets all MCP tools unfiltered.

**Approach**: Either filter in the runtime MCP proxy (skip calls to disabled tools), or accept that opencode sees all tools and rely on system prompt instructions to guide usage. The latter is simpler and matches opencode's design philosophy.

#### 6.6 Thinking Value [Low]

`request.thinking_value` configures model thinking budget. Opencode's prompt API doesn't expose this directly.

**Approach**: Skip for now. If needed, investigate opencode's model config for thinking/reasoning settings.

### Priority Order

1. Context messages (6.1) — without this, the agent has no memory or context
2. Workspace skills (6.2) — opencode's native skill mechanism, low-effort symlink
3. System prompt patch (6.3) — consistency with pi
4. Attachments (6.4) — needed for file/image inputs
5. Tool enablement (6.5) — acceptable to defer
6. Thinking value (6.6) — defer

### Validation

- [ ] Context messages appear in opencode agent's responses
- [ ] Workspace skills are loaded and callable from opencode agent
- [ ] Attachments (images, files) are visible to opencode agent
- [ ] Memory recall works end-to-end (ask about past interactions)
- [ ] No regressions in existing opencode harness tests
