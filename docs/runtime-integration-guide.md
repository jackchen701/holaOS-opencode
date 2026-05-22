# holaOS Runtime 集成指南

> 适用于外部编排器接入 holaOS Runtime，通过 opencode harness 执行 Agent 任务。

## 架构总览

```
外部编排器 (你的服务)
  │
  │  HTTP API / 直接调用
  ▼
holaOS Runtime API Server (Fastify)
  │
  │  spawn harness-host
  ▼
harness-host (opencode adapter)
  │
  ├── Attach 模式:  → 已运行的 opencode serve 实例
  │                    (零冷启动，推荐)
  │
  └── Fallback 模式: → 自管理 opencode serve --port=0
                       (独立实例，冷启动 ~1.5s)
```

## 两种运行模式

### 模式一：Attach（推荐）

连接到已运行的 `opencode serve` 实例，零冷启动。

```
外部编排器  ──→  holaOS runtime  ──→  已运行的 opencode serve
                                      (由你提前启动并管理)
```

**启动 opencode serve：**

```bash
# 一次性启动，长期运行
opencode serve --port 4096
# 输出: opencode server listening on http://127.0.0.1:4096
```

**通过环境变量连接：**

```bash
export OPENCODE_SERVE_URL="http://127.0.0.1:4096"
export SANDBOX_AGENT_HARNESS="opencode"
```

**或通过请求参数连接：**

```json
{
  "opencode_serve_url": "http://127.0.0.1:4096"
}
```

**注意：** Attach 模式下，opencode 的 provider/model 配置需在 opencode serve 启动时就已配好（通过 `.opencode/config.json` 或 `OPENCODE_CONFIG_CONTENT`）。holaOS runtime 不会注入配置到已运行的实例。

### 模式二：Fallback（自管理）

每次运行自动 spawn 一个独立的 opencode serve 子进程，运行结束后自动清理。

```
外部编排器  ──→  holaOS runtime  ──→  spawn opencode serve --port=0
                                      (每次冷启动 ~1.5s)
```

**配置：** 不设置 `OPENCODE_SERVE_URL` 和 `opencode_serve_url` 即自动进入 Fallback 模式。runtime 会通过 `OPENCODE_CONFIG_CONTENT` 注入 provider/model/MCP 配置。

---

## 快速开始

### 1. 安装 opencode

```bash
curl -fsSL https://opencode.ai/install | bash
# 安装到 ~/.opencode/bin/opencode
```

### 2. 配置 Provider

创建 `~/.opencode/config.json`（Attach 模式需要）：

```json
{
  "model": "your-provider/your-model",
  "provider": {
    "your-provider": {
      "name": "My Provider",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "apiKey": "<YOUR_API_KEY>",
        "baseURL": "<YOUR_API_BASE_URL>"
      },
      "models": {
        "your-model": { "name": "your-model" }
      }
    }
  }
}
```

支持的 provider 类型：

| Provider Kind | npm 包 | 适用场景 |
|---|---|---|
| `@ai-sdk/openai-compatible` | OpenAI 兼容 API（DeepSeek、GLM、OpenRouter 等） |
| `@ai-sdk/anthropic` | Anthropic 原生 API |
| `@ai-sdk/google` | Google Gemini API |

### 3. 启动 opencode serve（Attach 模式）

```bash
opencode serve --port 4096 &
```

### 4. 发送请求

#### 方式 A：通过 Runtime API Server

```bash
# 启动 runtime API server
SANDBOX_AGENT_HARNESS=opencode \
OPENCODE_SERVE_URL=http://127.0.0.1:4096 \
SANDBOX_RUNTIME_API_PORT=8080 \
node runtime/api-server/dist/index.mjs

# 提交 Agent 运行
curl -X POST http://localhost:8080/api/v1/agent-runs/stream \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "my-workspace",
    "session_id": "session-1",
    "input_id": "input-1",
    "instruction": "Hello, who are you?",
    "context": {
      "_sandbox_runtime_exec_v1": {
        "harness": "opencode"
      }
    },
    "debug": false
  }'
```

#### 方式 B：直接调用 harness-host

```bash
# 构建 base64 编码的请求
REQUEST=$(echo '{
  "workspace_id": "my-workspace",
  "workspace_dir": "/path/to/workspace",
  "session_id": "session-1",
  "input_id": "input-1",
  "instruction": "Hello!",
  "debug": true,
  "provider_id": "deepseek",
  "model_id": "deepseek-chat",
  "timeout_seconds": 60,
  "system_prompt": "You are helpful.",
  "workspace_skill_dirs": [],
  "mcp_servers": [],
  "mcp_tool_refs": [],
  "workspace_config_checksum": "v1",
  "run_started_payload": {},
  "model_client": {
    "model_proxy_provider": "openai_compatible",
    "api_key": "<YOUR_API_KEY>",
    "base_url": "https://api.deepseek.com/v1"
  },
  "opencode_serve_url": "http://127.0.0.1:4096"
}' | base64 -w0)

# 执行
node runtime/harness-host/dist/index.mjs run-opencode --request-base64 "$REQUEST"
```

#### 方式 C：编程调用（Bun/Node）

```typescript
import { runOpencode } from "holaos/runtime/harness-host/src/opencode.ts";

const exitCode = await runOpencode({
  workspace_id: "my-workspace",
  workspace_dir: "/path/to/workspace",
  session_id: "session-1",
  input_id: "input-1",
  instruction: "Hello!",
  debug: true,
  provider_id: "deepseek",
  model_id: "deepseek-chat",
  timeout_seconds: 60,
  system_prompt: "You are helpful.",
  workspace_skill_dirs: [],
  mcp_servers: [],
  mcp_tool_refs: [],
  workspace_config_checksum: "v1",
  run_started_payload: {},
  model_client: {
    model_proxy_provider: "openai_compatible",
    api_key: process.env.YOUR_API_KEY!,
    base_url: "https://api.deepseek.com/v1",
  },
  // Attach 模式:
  opencode_serve_url: "http://127.0.0.1:4096",
  // Fallback 模式: 设为 null 或不传
});
```

---

## 请求格式

### HarnessHostOpencodeRequest 完整字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `workspace_id` | string | ✅ | 工作区 ID |
| `workspace_dir` | string | ✅ | 工作区目录路径 |
| `session_id` | string | ✅ | 会话 ID |
| `input_id` | string | ✅ | 输入 ID（每轮唯一） |
| `instruction` | string | ✅ | 用户指令/提示 |
| `system_prompt` | string | ✅ | 系统提示词 |
| `model_client` | object | ✅ | 模型提供商配置 |
| `model_client.model_proxy_provider` | string | ✅ | `openai_compatible` / `anthropic_native` / `google_compatible` |
| `model_client.api_key` | string | ✅ | API Key |
| `model_client.base_url` | string | 推荐 | API Base URL |
| `model_client.default_headers` | object | 可选 | 自定义请求头 |
| `provider_id` | string | ✅ | Provider 标识 |
| `model_id` | string | ✅ | 模型标识（如 `deepseek-chat`） |
| `timeout_seconds` | number | ✅ | 超时秒数（建议 60-900） |
| `debug` | boolean | ✅ | 调试模式 |
| `workspace_skill_dirs` | string[] | ✅ | 技能目录路径列表 |
| `mcp_servers` | object[] | ✅ | MCP 服务器配置列表 |
| `mcp_tool_refs` | object[] | ✅ | MCP 工具引用列表 |
| `workspace_config_checksum` | string | ✅ | 配置校验和 |
| `run_started_payload` | object | ✅ | 启动事件附加数据 |
| `context_messages` | string[] | 可选 | 运行时上下文（记忆、scratchpad 等） |
| `attachments` | object[] | 可选 | 附件列表 |
| `image_urls` | string[] | 可选 | 图片 URL 列表 |
| `thinking_value` | string | 可选 | 思考预算 |
| `harness_session_id` | string | 可选 | 复用的 opencode session ID |
| `tools` | object | 可选 | 工具启用/禁用映射 |
| `runtime_api_base_url` | string | 可选 | Runtime API 地址（MCP 代理用） |
| `opencode_serve_url` | string | 可选 | Attach 模式目标 URL |

---

## 事件流

harness-host 输出 newline-delimited JSON 到 stdout：

```
{"session_id":"...","input_id":"...","sequence":1,"event_type":"run_started","payload":{}}
{"session_id":"...","input_id":"...","sequence":2,"event_type":"output_delta","payload":{"delta":"Hello"}}
{"session_id":"...","input_id":"...","sequence":3,"event_type":"tool_call","payload":{"phase":"started","tool_name":"bash","call_id":"call_1"}}
{"session_id":"...","input_id":"...","sequence":4,"event_type":"tool_call","payload":{"phase":"completed","call_id":"call_1","error":false}}
{"session_id":"...","input_id":"...","sequence":5,"event_type":"run_completed","payload":{"status":"success","usage":{"input_tokens":100,"output_tokens":50}}}
```

### 事件类型

| 事件 | 方向 | 说明 |
|------|------|------|
| `run_started` | → runtime | 运行开始 |
| `output_delta` | → runtime | 文本增量输出 |
| `thinking_delta` | → runtime | 思考/推理增量 |
| `tool_call` | → runtime | 工具调用（started/completed/in_progress） |
| `auto_compaction_start` | → runtime | 上下文自动压缩开始 |
| `auto_compaction_end` | → runtime | 上下文自动压缩完成 |
| `auto_compaction_delta` | → runtime | 压缩进度 |
| `run_completed` | → runtime | 运行成功完成 |
| `run_failed` | → runtime | 运行失败 |

---

## 环境变量

### Harness 选择

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_AGENT_HARNESS` | `pi` | 设为 `opencode` 使用 opencode harness |

### opencode 连接

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCODE_SERVE_URL` | (无) | Attach 模式目标 URL，设置后跳过 spawn |
| `HOLABOSS_OPENCODE_BIN` | `~/.opencode/bin/opencode` | opencode 二进制路径（Fallback 模式用） |

### Runtime API

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_RUNTIME_API_HOST` | `0.0.0.0` | API server 监听地址 |
| `SANDBOX_RUNTIME_API_PORT` | `8080` | API server 端口 |
| `HOLABOSS_RUNTIME_ROOT` | auto | Runtime 根目录 |
| `HOLABOSS_RUNTIME_APP_ROOT` | `/app` | 应用根目录 |

### 模型配置（Fallback 模式通过请求传入，Attach 模式通过 opencode config）

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `OPENAI_API_KEY` | OpenAI API Key |
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `OPENROUTER_API_KEY` | OpenRouter API Key |

---

## 工作区最低要求

```
<workspace_dir>/
  AGENTS.md                    # Agent 指令（必须有，可为空）
  .holaboss/
    state/
      runtime.db               # 自动创建的 SQLite DB
```

---

## MCP 工具代理（Fallback 模式）

Fallback 模式自动注入 `holaboss-runtime` MCP 服务器，将 holaOS 的 40+ runtime 工具代理给 opencode：

- **Subagent**: `holaboss_delegate_task`, `holaboss_get_subagent`, ...
- **Cronjobs**: `holaboss_cronjobs_list`, `holaboss_cronjobs_create`, ...
- **Terminal**: `terminal_session_start`, `terminal_session_read`, ...
- **Browser**: `browser_act`, `browser_get_state`, ...
- **Workspace Data**: `workspace_data_query`, ...
- **Memory**: `holaboss_scratchpad_read`, ...

需要 `runtime_api_base_url` 指向 holaOS API Server。

---

## 常见 Provider 配置示例

### DeepSeek

```json
{
  "model_client": {
    "model_proxy_provider": "openai_compatible",
    "api_key": "<YOUR_DEEPSEEK_KEY>",
    "base_url": "https://api.deepseek.com/v1"
  },
  "provider_id": "deepseek",
  "model_id": "deepseek-chat"
}
```

### OpenAI

```json
{
  "model_client": {
    "model_proxy_provider": "openai_compatible",
    "api_key": "<YOUR_OPENAI_KEY>",
    "base_url": "https://api.openai.com/v1"
  },
  "provider_id": "openai",
  "model_id": "gpt-4o"
}
```

### Anthropic

```json
{
  "model_client": {
    "model_proxy_provider": "anthropic_native",
    "api_key": "<YOUR_ANTHROPIC_KEY>",
    "base_url": "https://api.anthropic.com"
  },
  "provider_id": "anthropic",
  "model_id": "claude-sonnet-4-20250514"
}
```

### OpenRouter

```json
{
  "model_client": {
    "model_proxy_provider": "openai_compatible",
    "api_key": "<YOUR_OPENROUTER_KEY>",
    "base_url": "https://openrouter.ai/api/v1",
    "default_headers": {
      "HTTP-Referer": "https://your-app.com"
    }
  },
  "provider_id": "openrouter",
  "model_id": "anthropic/claude-sonnet-4"
}
```

### 智谱 GLM

```json
{
  "model_client": {
    "model_proxy_provider": "openai_compatible",
    "api_key": "<YOUR_ZHIPU_KEY>",
    "base_url": "https://open.bigmodel.cn/api/paas/v4"
  },
  "provider_id": "zhipu",
  "model_id": "glm-4-plus"
}
```

---

## 性能对比

| 指标 | Attach 模式 | Fallback 模式 |
|------|------------|--------------|
| 冷启动延迟 | 0ms | ~1500ms |
| Provider 配置 | opencode config（预配） | 请求内传入 |
| MCP 工具 | 需在 opencode config 中配 | 自动注入 |
| 进程管理 | 外部管理 | runtime 自动管理 |
| 适用场景 | 生产环境、高并发 | 开发测试、独立部署 |
