---
name: holaos-e2e-prerequisites
description: holaOS runtime e2e 测试的隐藏前置条件和排查路径
---

## 前置条件
- `HOLABOSS_RUNTIME_ROOT` 和 `HOLABOSS_RUNTIME_APP_ROOT` 必须指向 holaOS repo 的 `runtime/` 目录（默认 `/app`，本地开发不适用）
- workspace 目录必须包含：`workspace.yaml`（有效 YAML mapping）、`AGENTS.md`（非空）、`README.md`
- `workspace.yaml` 必须包含 `agents`（含 `id` 和 `model`）和 `mcp_registry`（含 `servers`）
- runtime DB 位置在 `<workspace_dir>/.holaboss/state/runtime.db`，workspace 目录名由 API 的 `workspace_id` 决定，不是传入的 `directory` 参数

## 关键坑点
- ⚠致命 环境变量 `HOLABOSS_RUNTIME_APP_ROOT` 未设置时，ts-runner 的 `cd /runtime/api-server` 会失败，但错误信息是 `RunnerCommandError`，不直接暴露原因
- ⚠隐蔽 runtime DB 不在传入的 `directory` 路径下，而在 `HB_SANDBOX_ROOT/workspace/<workspace_id>/.holaboss/state/` 下，查错 DB 导致看到空结果
- ⚠易忘 `workspace.yaml` 空文件会报 "must parse to a mapping object"；有内容但缺 `agents` 报 "missing object field 'agents'"；缺 `mcp_registry` 报 "missing object field 'mcp_registry'"——错误信息链式暴露，每次只报一个

## 已验证方案
- 最小 `workspace.yaml`：
  ```yaml
  agents:
    id: agent-1
    model: <model_id>
  mcp_registry:
    servers: {}
    allowlist:
      tool_ids: []
  ```
- 启动 server 必设环境变量：`HOLABOSS_RUNTIME_ROOT`、`HOLABOSS_RUNTIME_APP_ROOT`（均指向 repo `runtime/`）、`HB_SANDBOX_ROOT`、`HOLABOSS_RUNTIME_CONFIG_PATH`
- 查结果时用 `find $SANDBOX_ROOT -name "runtime.db"` 定位实际 DB 路径
- `SANDBOX_AGENT_HARNESS=opencode` 切换 harness，不设则默认 pi
- opencode harness 需要 `HOLABOSS_OPENCODE_BIN` 指向 opencode 二进制路径（默认 `~/.opencode/bin/opencode`）
- 需要临时关闭 proxy：启动时用 `env -u http_proxy -u https_proxy ...` 或在 shell 里 `unset`
