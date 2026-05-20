# Task Management Layer Extraction Plan

Status: **Planning**
Created: 2026-05-20
Related: `feat/opencode-harness-integration`

## Goal

Extract holaOS 的任务管理层为独立服务，执行层从 pi in-process SDK 切换为调度 `opencode` CLI。保留 Queue、Cron、Subagent 调度、Memory 管理，去掉对 pi harness 的硬依赖。

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  独立任务调度服务                                         │
│                                                          │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────┐  │
│  │ Cron     │──>│ Queue Worker │   │ Delegate Task  │  │
│  │ Worker   │   │ (poll+claim) │   │ (subagent)     │  │
│  └──────────┘   └──────┬───────┘   └───────┬────────┘  │
│                        │                   │            │
│                        │  claimInputs()    │            │
│                        │                   │            │
│                        v                   v            │
│                 ┌─────────────────────────────┐         │
│                 │ Executor (可插拔)            │         │
│                 │                             │         │
│                 │  默认: spawn opencode CLI   │         │
│                 │  备选: spawn ts-runner      │         │
│                 │       (向后兼容 pi)          │         │
│                 └─────────────────────────────┘         │
│                        │                                │
│                        v                                │
│                 ┌─────────────────────────────┐         │
│                 │ Event Writeback              │        │
│                 │  → turn_results              │        │
│                 │  → session_output_events     │        │
│                 │  → subagent_runs             │        │
│                 │  → memory writeback          │        │
│                 └─────────────────────────────┘         │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Shared: RuntimeStateStore (SQLite per-workspace) │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Extraction Phases

### Phase 1: Extract State Store Package

**现状**: `runtime/state-store/` 已经是独立包 `@holaboss/runtime-state-store`，基于 better-sqlite3，每个 workspace 一个 SQLite DB。

**动作**: 无需改动，直接引用。需要确认以下接口的完整导出：

- `enqueueInput()` / `claimInputs()` / `renewInputClaim()` / `updateInput()`
- `ensureSession()` / `upsertBinding()` / `ensureRuntimeState()`
- `createSubagentRun()` / `updateSubagentRun()`
- `appendOutputEvent()` / `upsertTurnResult()`
- `createCronjob()` / `updateCronjob()` / `listCronjobsDue()`
- `enqueueMainSessionEvent()` / `listPendingMainSessionEvents()`
- `upsertDurableMemoryCandidate()` / `listMemoryEntries()`

**验证**: 所有接口有对应测试。

---

### Phase 2: Extract Queue Worker

**现状**: `api-server/src/queue-worker.ts` — `RuntimeQueueWorker` class。

**依赖**: 
- `RuntimeStateStore` (独立包)
- `processClaimedInput` 回调 (需替换)
- `captureRuntimeException` (日志，可选)

**接口提取**:

```typescript
interface QueueWorkerOptions {
  store: RuntimeStateStore;
  executeClaimedInput: (record: ClaimedInputRecord, options: ClaimedInputExecutionOptions) => Promise<void>;
  maxConcurrency?: number;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  claimStaleHeartbeatMs?: number;
  logger?: Logger;
}
```

**完整生命周期** (必须保留):

```
┌────────────────────────────────────────────────────────────────┐
│ Input Lifecycle                                                 │
│                                                                 │
│  enqueueInput()                                                 │
│       │  - status: QUEUED, attempt: 0                           │
│       │  - idempotencyKey 去重                                   │
│       v                                                         │
│  claimInputs()                                                  │
│       │  - CAS: WHERE status='QUEUED' → SET CLAIMED             │
│       │  - NOT EXISTS 防止同 session 并行                       │
│       │  - priority DESC, created_at ASC                        │
│       v                                                         │
│  executeClaimedInput() ← 可插拔的执行器                          │
│       │                                                         │
│       ├── [成功] → DONE + IDLE                                  │
│       ├── [失败] → FAILED + ERROR                               │
│       ├── [暂停] → PAUSED (AbortController)                     │
│       │                                                         │
│       │  [heartbeat 每 5s 续约 lease]                            │
│       │  [事件驱动续约，最小间隔 250ms]                           │
│       │                                                         │
│       v                                                         │
│  Terminal Cleanup (15 步):                                      │
│    1. append terminal output event                              │
│    2. update input status (DONE/FAILED/PAUSED)                  │
│    3. update runtime state (IDLE/ERROR/WAITING_USER/PAUSED)     │
│    4. persist turn result                                       │
│    5. update subagent run if applicable                         │
│    6. finalize main session events                              │
│    7. run evolve tasks                                          │
│    8. create notifications                                      │
│    9. queue cronjob completion followup                         │
│   10. detect file outputs                                       │
│   11. materialize queued background deliverables                │
│   12. insert session message (user + assistant)                 │
│   13. enqueue session checkpoint job                            │
│   14. relay terminal event to backend                           │
│   15. sync snapshot (pi only)                                   │
│                                                                 │
│  Recovery (#recoverClaimedInputs):                              │
│    - claim_expired: lease 过期 + heartbeat 过期 → requeue       │
│    - claim_abandoned: lease 未过期但 heartbeat 过期 → requeue    │
│    - requeue 条件: 无 turn_result 且仅有 run_claimed events     │
│    - 否则: 合成 run_failed event，标记 FAILED                   │
│    - 特殊: session_checkpoint job 存在时延展 lease              │
│                                                                 │
│  Retry:                                                         │
│    - 无自动重试                                                  │
│    - Runner 级别: context overflow 最多重试 2 次                 │
│    - Runner 级别: provider termination 最多重试 2 次             │
│    - Main session event retry: 指数退避 (5s→10s→20s→...→5min)  │
└────────────────────────────────────────────────────────────────┘
```

**注意事项**:
- Terminal cleanup 的 15 步目前散落在 `claimed-input-executor.ts` 2000+ 行里
- 需要拆分为独立函数，每步可单独测试
- Step 15 (pi snapshot sync) 是 pi 特有的，opencode executor 不需要

---

### Phase 3: Extract Cron Worker

**现状**: `api-server/src/cron-worker.ts` — `RuntimeCronWorker` class。

**依赖**:
- `RuntimeStateStore`
- `QueueWorkerLike` 接口 (只需 `wake()` 方法)

**完整生命周期**:

```
┌──────────────────────────────────────────────────────────┐
│ Cron Job Lifecycle                                        │
│                                                           │
│  CRUD:                                                    │
│    create → update → delete → enable/disable              │
│                                                           │
│  Trigger Loop (60s 轮询):                                 │
│    cronjobIsDue()                                         │
│      │  - enabled check                                   │
│      │  - nextRunAt timestamp comparison                  │
│      │  - fallback: cron expression prev() match          │
│      v                                                    │
│    queueLocalCronjobRun()                                 │
│      │  1. resolve main session (binding/metadata/create) │
│      │  2. create child session (kind="subagent")         │
│      │  3. create subagent_run (sourceType="cronjob")     │
│      │  4. enqueueInput (source="cronjob")                │
│      │  5. wake queue worker                              │
│      v                                                    │
│    After run:                                             │
│      - updateCronjob(lastRunAt, nextRunAt, runCount++)    │
│      - lastStatus = "success" / "failed"                  │
│      - lastError = error message                          │
│                                                           │
│  Error Handling:                                          │
│    - 失败不重试，下次 cron 触发再跑                        │
│    - subagent 走正常失败路径                               │
│                                                           │
│  Edge Cases:                                              │
│    - 删除 cronjob 时有 run 在执行 → run 继续完成           │
│      completion followup 检查 cronjob 是否存在，不存在跳过 │
│    - nextRunAt 计算依赖 cron 表达式解析                    │
└──────────────────────────────────────────────────────────┘
```

**注意事项**:
- `cronjobIsDue()` 的 fallback cron 解析需要 `cron-parser` 依赖
- subagent session 创建复用 queue worker 的 claim 路径
- execution profile (model/thinking) 解析需要从 runtime-config 读取

---

### Phase 4: Extract Subagent Delegation

**现状**: `runtime-agent-tools.ts` 的 `delegateTask()` 方法 (行 2568-2712)。

**依赖**:
- `RuntimeStateStore`
- `QueueWorkerLike.wake()`
- `resolveSubagentExecutionProfile()` (model 选择)
- `normalizeSubagentToolProfile()` (tool 过滤)

**完整生命周期**:

```
┌──────────────────────────────────────────────────────────────┐
│ Subagent Lifecycle                                            │
│                                                               │
│  delegateTask():                                              │
│    For each task:                                             │
│    1. validate workspace + session + task                     │
│    2. create child session (kind="subagent")                  │
│    3. resolveSubagentExecutionProfile() → model, thinking     │
│    4. normalizeSubagentToolProfile() → tool filter            │
│    5. createSubagentRun() → status="queued"                   │
│    6. upsertBinding()                                         │
│    7. ensureRuntimeState("QUEUED")                            │
│    8. enqueueInput() (source="subagent", subagent_id)         │
│    9. wake queue worker                                       │
│                                                               │
│  Execution:                                                   │
│    - 复用 queue worker 的 claim → execute 路径                │
│    - subagent session 有独立的 input queue                     │
│    - 递归委派: 不阻止，通过 ownerMainSessionId 追踪           │
│                                                               │
│  Result Capture:                                              │
│    updateSubagentRunFromTurnResult()                          │
│      ├── completed → resultPayload + archive child session    │
│      ├── failed → errorPayload                               │
│      ├── waiting_on_user → blockingPayload                    │
│      └── cancelled → errorPayload                             │
│                                                               │
│  Result Delivery to Parent:                                   │
│    enqueueMainSessionEvent()                                  │
│      │  deliveryBucket: "background_update" / "waiting_on_user"│
│      │  coalesce window: 5s                                    │
│      │  idle timeout: 5s                                       │
│      v                                                         │
│    MainSessionEventWorker                                     │
│      │  polls every 1s                                         │
│      │  groups by ownerMainSessionId                           │
│      │  waits for parent session idle                          │
│      v                                                         │
│    materialize batch → create synthetic input (priority -100)  │
│      │  idempotencyKey: based on event IDs + timestamps       │
│      v                                                         │
│    queue worker claims batch input                            │
│      ├── success → markMainSessionEventsDelivered()           │
│      └── failure → requeue with exponential backoff           │
│            5s → 10s → 20s → 40s → ... → max 5min             │
│                                                               │
│  Timeout:                                                     │
│    - 继承 runner timeout (默认 30min)                         │
│    - idle timeout: 15min 无事件则终止                         │
│    - task proposals: 最长 2h                                  │
└──────────────────────────────────────────────────────────────┘
```

**注意事项**:
- `MainSessionEventWorker` 的 batching 逻辑较复杂，需要一起提取
- parent session idle 检测依赖 runtime state 读取
- event delivery 失败的指数退避重试不能丢

---

### Phase 5: Implement opencode CLI Executor

**核心**: 替代 `claimed-input-executor.ts` 的 2000+ 行，写一个新的 executor，调度 `opencode` CLI 执行。

**接口**:

```typescript
interface ClaimedInputRecord {
  inputId: string;
  sessionId: string;
  workspaceId: string;
  payload: Record<string, unknown>; // text, context, attachments, etc.
  attempt: number;
}

interface ClaimedInputExecutionOptions {
  signal: AbortSignal;
  onEvent: (event: RunnerOutputEvent) => void;
  onHeartbeat: () => void;
}

async function executeViaOpencode(
  store: RuntimeStateStore,
  record: ClaimedInputRecord,
  options: ClaimedInputExecutionOptions,
): Promise<void>
```

**执行流程**:

```
┌──────────────────────────────────────────────────────┐
│ opencode CLI Executor                                │
│                                                       │
│  1. Read input payload                               │
│     - instruction: payload.text                      │
│     - context: payload.context (subagent info, etc.) │
│     - model: resolved from runtime-config            │
│                                                       │
│  2. Prepare workspace                                │
│     - Ensure .opencode/ dir with skill symlinks      │
│     - Write OPENCODE_CONFIG_CONTENT to env           │
│     - Write AGENTS.md with system prompt + memory    │
│                                                       │
│  3. Spawn opencode CLI                               │
│     - Capture stdout (JSONL events)                  │
│     - Capture stderr (logs)                          │
│     - Pipe AbortSignal to process kill               │
│                                                       │
│  4. Relay events                                     │
│     - Parse JSONL → RunnerOutputEvent                │
│     - Call onEvent() for each                        │
│     - Call onHeartbeat() on activity                 │
│                                                       │
│  5. On terminal event                                │
│     - Return (caller handles cleanup)                │
└──────────────────────────────────────────────────────┘
```

**与当前 opencode harness adapter 的关系**:
- 当前 `harness-host/src/opencode.ts` 已经实现了 `spawn opencode serve → HTTP API → SSE` 的模式
- 新 executor 可以复用 `buildOpencodeConfig()`、event mapping 等逻辑
- 区别：不走 ts-runner + harness-host 子进程链，而是直接在 executor 内 spawn

**注意 opencode CLI vs HTTP serve**:
- 当前 adapter 用 `opencode serve --port=0` + HTTP API + SSE
- 也可以用 `opencode` CLI 直接执行（stdin prompt → stdout JSONL）
- CLI 模式更简单，不需要 HTTP server 启动等待
- 需要确认 opencode CLI 的 JSONL 输出格式和 event types

---

### Phase 6: Memory Management

**现状**: Memory 管理分三部分：

| 部分 | 位置 | 耦合度 |
|------|------|--------|
| Storage | `RuntimeStateStore` (memory_entries, memory_embedding_index) | 独立 |
| Recall | `ts-runner.ts` (memory-recall-manifest) → 注入 system prompt | 中等 |
| Writeback | `turn-memory-writeback.ts` + background model client | 松散 |

**提取策略**:

```
┌──────────────────────────────────────────────────────┐
│ Memory Lifecycle                                      │
│                                                       │
│  Recall (执行前):                                     │
│    1. 从 memory_entries 查询相关记忆                   │
│    2. embedding 相似度匹配                            │
│    3. 组装为 context 文本                             │
│    4. 注入到 instruction 或 system prompt             │
│                                                       │
│  Writeback (执行后):                                  │
│    1. trigger: 每个 terminal turn 后                  │
│    2. heuristic candidates:                           │
│       - workspace command facts                      │
│       - workspace business facts                     │
│       - workspace procedures                         │
│       - repeated permission blockers                 │
│    3. model extraction: 每 5 轮调用 background model  │
│    4. upsertDurableMemoryCandidate()                 │
│    5. rebuild MEMORY.md files                        │
│                                                       │
│  Embedding:                                           │
│    - embedding model client (background task)         │
│    - memory_embedding_index table                     │
│    - recall-embedding-model.ts                       │
│                                                       │
│  注意:                                                │
│    - background model client 需要独立配置              │
│    - embedding 模型需要 API key + base_url            │
│    - MEMORY.md 写入 workspace 虚拟文件系统            │
└──────────────────────────────────────────────────────┘
```

---

### Phase 7: Terminal Cleanup Pipeline

这是最容易遗漏的部分。当前 `claimed-input-executor.ts` 在 terminal event 后执行 15 步 cleanup。迁移后每步都需要对应实现：

| Step | 操作 | 依赖 | 必须？ |
|------|------|------|--------|
| 1 | append terminal output event | store | ✅ |
| 2 | update input status (DONE/FAILED/PAUSED) | store | ✅ |
| 3 | update runtime state (IDLE/ERROR/...) | store | ✅ |
| 4 | persist turn result (assistant_text, token_usage) | store | ✅ |
| 5 | update subagent run if applicable | store + subagent lifecycle | ✅ |
| 6 | finalize main session events | store + main-session-event-worker | ✅ |
| 7 | run evolve tasks | store + evolve worker | ⚠️ 可延后 |
| 8 | create notifications | store | ⚠️ 可延后 |
| 9 | queue cronjob completion followup | store + cron worker | ✅ |
| 10 | detect file outputs | filesystem | ⚠️ 可延后 |
| 11 | materialize background deliverables | store | ⚠️ 可延后 |
| 12 | insert session message | store | ✅ |
| 13 | enqueue session checkpoint job | store | ⚠️ 可延后 |
| 14 | relay terminal event to backend | HTTP client | ⚠️ 可延后 |
| 15 | sync pi snapshot | pi SessionManager | ❌ 不需要 |

---

## Data Dependencies

### Per-Workspace SQLite Tables (必须)

| Table | 用途 | Phase |
|-------|------|-------|
| `agent_session_inputs` | 队列 | 2 |
| `agent_sessions` | session 身份 | 2 |
| `agent_runtime_sessions` | session 运行状态 | 2 |
| `session_runtime_state` | 实时状态 (BUSY/IDLE/ERROR) | 2 |
| `session_output_events` | 事件流 | 2 |
| `turn_results` | 轮次结果 | 2 |
| `subagent_runs` | subagent 追踪 | 4 |
| `main_session_event_queue` | subagent→parent 通知 | 4 |
| `cronjobs` | cron job 存储 | 3 |
| `memory_entries` | 记忆存储 | 6 |
| `memory_embedding_index` | 记忆索引 | 6 |
| `session_messages` | session 历史 | 2 |
| `conversation_bindings` | harness 绑定 | 2 |
| `post_run_jobs` | post-run 任务 | 2 |
| `runtime_notifications` | 通知 | 可延后 |

### External Dependencies

| 依赖 | 用途 | 替代方案 |
|------|------|---------|
| better-sqlite3 | SQLite 驱动 | 必须保留 |
| cron-parser | cron 表达式解析 | 必须保留 |
| opencode binary | 执行器 | 必须安装 |
| embedding model API | 记忆索引 | 配置 API key |
| background LLM API | 记忆提取 | 复用 model client |

---

## Migration Strategy

### Approach: 逐步替换，保持向后兼容

```
Phase 1: state-store (不动)
Phase 2: queue-worker (提取，可插拔 executor)
Phase 3: cron-worker (提取)
Phase 4: subagent delegation (提取)
Phase 5: opencode executor (新写)
Phase 6: memory (提取)
Phase 7: terminal cleanup pipeline (拆分)
```

### Key Risks

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| Terminal cleanup 15 步遗漏 | 高 | 逐步迁移，先实现必须步骤 |
| Main session event batching 逻辑丢失 | 高 | 一起提取 main-session-event-worker |
| Claim recovery 逻辑差异 | 中 | 保持原有 SQL 和阈值 |
| opencode CLI 输出格式不确定 | 中 | 先用 HTTP serve 模式（已验证），后续迁移到 CLI |
| Memory writeback 依赖 background model | 中 | 配置独立的 model client |
| SQLite 非事务操作导致不一致 | 低 | 保持原有 WAL 模式 + recovery 逻辑 |

### Success Criteria

- [ ] Queue worker 可独立启动，claim → execute → cleanup 完整闭环
- [ ] Cron worker 触发的任务完整执行（cron → subagent → result → followup）
- [ ] delegateTask 创建的 subagent 完整执行（delegate → execute → result delivery to parent）
- [ ] Stale claim recovery 正确工作（kill executor 进程 → input 被 requeue）
- [ ] Memory recall 注入到 opencode 的 system prompt
- [ ] Memory writeback 在 turn 完成后触发
- [ ] Pause 机制工作 (abort → input PAUSED → 可恢复)
- [ ] opencode CLI executor 产出的 events 与 pi executor 格式兼容
- [ ] 所有现有 pi executor 测试通过（不破坏现有功能）
