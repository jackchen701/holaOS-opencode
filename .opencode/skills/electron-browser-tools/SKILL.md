---
name: electron-browser-tools
description: Electron 内置浏览器自动化工具链的完整范式 — 30 个工具定义、四层架构、DOM 注入表达式、Agent 使用策略。用于在其他 Electron 项目中复刻或迁移同类浏览器操作能力。
---

## 概览

holaOS 的浏览器工具链是一套**不依赖 Playwright/Puppeteer**、直接基于 Electron `WebContents` API 构建的浏览器自动化体系。Agent 通过 30 个结构化工具控制内嵌浏览器，涵盖导航、DOM 交互、截图、调试、网络观测、存储和 Cookie 操作。

核心设计原则：
- 用 `WebContents.executeJavaScript()` 注入 DOM 检查/操作表达式，而非外部浏览器驱动
- 用 Electron 原生 `MouseInputEvent`/`KeyboardInputEvent` 发送真实输入
- 通过 localhost HTTP 桥接 Agent runtime 与 Electron 主进程
- 工具分 `inspect`（只读）和 `mutate`（变更）两类 policy

---

## 30 个工具完整定义

### 导航类
| 工具 ID | Policy | 说明 |
|---------|--------|------|
| `browser_navigate` | mutate | 导航到 URL |
| `browser_open_tab` | mutate | 在新标签页打开 URL |
| `browser_select_tab` | mutate | 切换活动标签页 |
| `browser_close_tab` | mutate | 关闭标签页 |
| `browser_back` | mutate | 后退 |
| `browser_forward` | mutate | 前进 |
| `browser_reload` | mutate | 刷新 |
| `browser_list_tabs` | inspect | 列出所有标签页 |

### DOM 交互类
| 工具 ID | Policy | 说明 |
|---------|--------|------|
| `browser_get_state` | inspect | 读取 DOM 状态、交互元素、媒体、可选截图。核心检查工具。支持 revision 增量更新 |
| `browser_find` | inspect | 按文本/标签/选择器/XPath 查找元素，返回 ref 和 bounding box |
| `browser_act` | mutate | 通用浏览器动作：click/double_click/hover/focus/fill/type/press/select/check/uncheck/scroll_into_view |
| `browser_click` | mutate | 按索引点击交互元素（从 browser_get_state 返回的列表） |
| `browser_type` | mutate | 按索引输入文本到元素 |
| `browser_press` | mutate | 发送键盘按键 |
| `browser_scroll` | mutate | 滚动页面 |
| `browser_context_click` | mutate | 打开原生右键菜单 |

### 等待/调试类
| 工具 ID | Policy | 说明 |
|---------|--------|------|
| `browser_wait` | inspect | 等待条件：页面加载/URL/文本/元素/DOM变化/下载/JS函数 |
| `browser_debug` | inspect | 诊断点击性、页面状态、elementFromPoint 命中测试 |
| `browser_evaluate` | mutate | 在页面中执行 JavaScript |

### 截图/下载类
| 工具 ID | Policy | 说明 |
|---------|--------|------|
| `browser_screenshot` | inspect | 截图，返回 artifact handle |
| `browser_list_downloads` | inspect | 列出下载记录 |

### 可观测性类
| 工具 ID | Policy | 说明 |
|---------|--------|------|
| `browser_get_console` | inspect | 读取浏览器控制台输出 |
| `browser_get_errors` | inspect | 读取页面/运行时/网络错误 |
| `browser_list_requests` | inspect | 列出最近网络请求 |
| `browser_get_request` | inspect | 读取单个请求的详细元数据 |

### 存储/Cookie 类
| 工具 ID | Policy | 说明 |
|---------|--------|------|
| `browser_storage_get` | inspect | 读取 localStorage/sessionStorage |
| `browser_storage_set` | mutate | 设置/删除 localStorage/sessionStorage |
| `browser_cookies_get` | inspect | 读取 Cookie |
| `browser_cookies_set` | mutate | 设置 Cookie |

---

## 四层架构

```
┌─────────────────────────────────────────────────┐
│  Layer 1: 工具定义 (desktop-browser-tools.ts)    │  ← 30 个工具的 ID、Schema、Policy
├─────────────────────────────────────────────────┤
│  Layer 2: Harness 适配 (browser-capability-tools) │  ← 包装成 Agent 可调用的 Tool 对象
│           + HTTP Client (browser-capability-client)│  ← POST 到 runtime API
├─────────────────────────────────────────────────┤
│  Layer 3: API Server (app.ts 路由)               │  ← Fastify 路由，委托给 ToolService
│           + 执行引擎 (desktop-browser-tools.ts)   │  ← 解析参数，生成 JS 表达式，调 Electron
├─────────────────────────────────────────────────┤
│  Layer 4: Electron HTTP Bridge (http-service.ts) │  ← 主进程 HTTP 服务器，直接操作 WebContents
└─────────────────────────────────────────────────┘
```

### Layer 1 — 工具定义（纯数据，零依赖）

文件：`runtime/harnesses/src/desktop-browser-tools.ts`（784 行）

导出：
- `DESKTOP_BROWSER_TOOL_IDS` — 30 个工具 ID 的 const tuple
- `DesktopBrowserToolId` — 联合类型
- `DesktopBrowserToolDefinition` — 接口：`{ id, description, policy, session_scope, input_schema }`
- `DESKTOP_BROWSER_TOOL_DEFINITIONS` — 完整定义数组

每个工具的 `input_schema` 是标准 JSON Schema，`policy` 标记 `"inspect"` 或 `"mutate"`。

### Layer 2 — Harness 适配 + HTTP Client

**`browser-capability-tools.ts`**（843 行）— 将定义转为可调用工具对象：

关键函数：
- `createHarnessDesktopBrowserToolDefinition(def, options)` — 包装单个工具，`execute` 函数 POST 到 runtime API
- `createHarnessDesktopBrowserToolDefinitions(options)` — 批量创建 30 个工具
- `resolveHarnessDesktopBrowserToolDefinitions(options)` — 先检查可用性，不可用返回空数组

辅助函数：
- `browserLocatorProperties()` — 共享的 ref/text/label/selector/xpath/scope Schema
- `browserWaitForParameters()` — 共享的 wait 条件 Schema
- `browserToolParameters(toolId)` — 每个 tool 的增强版 JSON Schema（带 description）

**`browser-capability-client.ts`**（133 行）— 底层 HTTP 客户端：

关键函数：
- `browserCapabilityAvailable()` — GET `/api/v1/capabilities/browser`，检查浏览器是否可用
- `executeBrowserCapabilityTool()` — POST `/api/v1/capabilities/browser/tools/{toolId}`
- `browserCapabilityHeaders()` — 构建 `x-holaboss-workspace-id`、`x-holaboss-session-id`、`x-holaboss-input-id`、`x-holaboss-browser-space` 请求头

### Layer 3 — API Server 路由 + 执行引擎

**`app.ts`** 中注册两个路由：
- `GET /api/v1/capabilities/browser` — 返回浏览器状态 `{ available, configured, reachable, backend, tools }`
- `POST /api/v1/capabilities/browser/tools/:toolId` — 执行工具

**`desktop-browser-tools.ts`**（~4000 行）— 核心执行引擎：

接口：
- `DesktopBrowserToolServiceLike` — `{ getStatus(), execute() }`
- `DesktopBrowserToolServiceOptions` — `{ fetchImpl, resolveConfig, artifactStore }`

`DesktopBrowserToolService` 类的关键实现模式：
1. 从 `ProductRuntimeConfig` 解析 Electron 桌面浏览器 URL + 认证 token
2. 对每个 tool ID 分派到具体实现方法
3. DOM 检查工具生成 JavaScript 表达式字符串，通过 Electron HTTP bridge 的 `/api/v1/browser/evaluate` 执行
4. 导航/标签页/截图等直接调用 Electron HTTP bridge 的对应路由

JS 表达式生成函数：
- `interactiveElementsExpression()` — DOM 快照提取
- `browserFindExpression()` — 元素定位匹配
- `browserActExpression()` — 动作分发（点击/填充/输入等）
- `browserWaitPredicateExpression()` — 等待条件轮询
- `browserEvaluateExpression()` — JS 评估
- `browserStorageGetExpression()` / `browserStorageSetExpression()` — 存储访问

### Layer 4 — Electron 主进程 HTTP 桥接

**`http-service.ts`**（1333 行）— 在 Electron 主进程启动 localhost HTTP 服务器：

路由映射：

| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/v1/browser/health` | GET | 健康检查 |
| `/api/v1/browser/tabs` | GET | 列出标签页 |
| `/api/v1/browser/tabs` | POST | 新建标签页 |
| `/api/v1/browser/tabs/select` | POST | 选择标签页 |
| `/api/v1/browser/tabs/close` | POST | 关闭标签页 |
| `/api/v1/browser/page` | GET | 获取页面状态 |
| `/api/v1/browser/navigate` | POST | 导航到 URL |
| `/api/v1/browser/evaluate` | POST | 执行 JS（WebContents.executeJavaScript） |
| `/api/v1/browser/context-click` | POST | 右键菜单 |
| `/api/v1/browser/mouse` | POST | 原生鼠标事件 |
| `/api/v1/browser/keyboard` | POST | 原生键盘事件 |
| `/api/v1/browser/screenshot` | POST | 截图（WebContents.capturePage） |
| `/api/v1/browser/downloads` | GET | 下载列表 |
| `/api/v1/browser/console` | GET | 控制台输出 |
| `/api/v1/browser/errors` | GET | 页面错误 |
| `/api/v1/browser/requests` | GET | 网络请求列表 |
| `/api/v1/browser/requests/:id` | GET | 单个请求详情 |
| `/api/v1/browser/cookies` | GET | 获取 Cookie |
| `/api/v1/browser/cookies` | POST | 设置 Cookie |
| `/api/v1/browser/operator-surface-context` | GET | 界面上下文 |

认证：`x-holaboss-desktop-token` 请求头。作用域：workspace/session/space。

支撑子系统（`apps/desktop/electron/browser-pane/`）：
- `tab-state.ts` — 标签页状态管理
- `tab-observability.ts` — 每个标签页的 console/error/request 观测
- `observability.ts` — 共享观测类型和辅助
- `agent-session-lifecycle.ts` — Agent 会话浏览器空间生命周期
- `user-lock.ts` — 用户浏览器锁（防止 Agent 和用户同时操作）
- `popups.ts` — 弹窗处理
- `downloads.ts` — 下载追踪
- `bookmarks.ts` — 书签管理
- `import-browsers.ts` / `import-chromium.ts` — 浏览器配置导入

---

## 调用链路（完整流程）

```
Agent 调用 browser_navigate({ url: "https://example.com" })
  │
  ▼
Layer 2: HarnessDesktopBrowserToolDefinitionLike.execute()
  │  POST http://localhost:5060/api/v1/capabilities/browser/tools/browser_navigate
  │  Headers: x-holaboss-workspace-id, x-holaboss-session-id, ...
  │
  ▼
Layer 3: DesktopBrowserToolService.execute("browser_navigate", { url })
  │  解析 ProductRuntimeConfig → 得到 Electron HTTP 桥接地址 + token
  │  POST http://127.0.0.1:XXXXX/api/v1/browser/navigate
  │  Headers: x-holaboss-desktop-token
  │
  ▼
Layer 4: BrowserPaneHttpService (Electron 主进程)
  │  验证 token → 找到目标 workspace/space → 获取 WebContents
  │  webContents.loadURL("https://example.com")
  │  等待 load 事件 → 返回结果
  │
  ▼
结果原路返回给 Agent
```

---

## 工具使用策略（Agent Prompt 规则）

这些规则注入到 Agent 的 system prompt 中，指导何时及如何使用浏览器工具：

### 优先级规则
1. **浏览器工具是 fallback**，不是默认路径。只在用户明确要求、任务需要 UI 交互、需要视觉确认、非浏览器路径被阻断时才使用
2. **优先使用 MCP 工具** — 如果连接了 MCP 且有匹配工具，不要走浏览器
3. **DOM 优先于截图** — 优先用 DOM 结构化数据提取，只在视觉确认必要时截图

### 操作模式
1. **先 `browser_get_state` 再操作** — 获取当前页面状态和交互元素列表
2. **用 `browser_find` 定位** — 当目标元素不在 compact snapshot 中时
3. **用 `browser_act` 替代 `browser_click`** — 当目标可能在 snapshot 外或由嵌套 DOM 节点表示时
4. **用 `wait_for` / `post_state` 内联稳定** — 避免在 click/type 后单独调用 browser_wait
5. **用 `since_revision` 增量检查** — 避免每次全量快照

### 等待条件
- 页面加载后等 `load` 或 `interactive`
- SPA 路由跳转等 `url` 或 `dom_change`
- 表单提交等 `text` 或 `element`
- 下载触发等 `download_started` 或 `download_completed`
- JS 谓词等 `function`

---

## DOM 注入表达式模式

这是这套工具链的核心技术：通过 `WebContents.executeJavaScript()` 注入 JS 表达式完成 DOM 操作。

### 交互元素提取 (`interactiveElementsExpression`)

选择器：
```
a[href], button, input, textarea, select,
[role='button'], [role='link'],
[contenteditable]:not([contenteditable='false']),
[tabindex]
```

每个元素返回：
- `index`（1-based 序号）
- `tag`、`role`、`text`（截断至 120 字符）
- `ref`（稳定引用，用于 browser_act）
- `boundingBox`（x, y, width, height）
- `attributes`（href, placeholder, value, type, aria-label 等）

### 媒体元素提取

选择器：`img, video, canvas, [role='img']`

### 动作表达式 (`browserActExpression`)

支持的动作和实现方式：
- `click` — `element.click()` 或坐标点击
- `fill` — focus + 全选 + 输入值
- `type` — 逐字符 input 事件
- `select` — 设置 `<select>` 值
- `hover` — dispatchEvent mouseover/mousemove
- `scroll_into_view` — `element.scrollIntoView()`
- `check/uncheck` — 设置 checked 属性

### 等待谓词 (`browserWaitPredicateExpression`)

轮询间隔 250ms，按条件类型生成不同的检查函数：
- `load` — `document.readyState`
- `url` — URL 匹配
- `text` — `document.body.innerText.includes()`
- `element` — `document.querySelector()` / `document.evaluate()`
- `dom_change` — MutationObserver 计数
- `function` — eval 用户表达式

---

## 关键常量

```
BROWSER_GET_STATE_COMPACT_MAX_NODES = 30
BROWSER_GET_STATE_TEXT_MAX_CHARS = 2500
BROWSER_GET_STATE_ELEMENT_TEXT_MAX_CHARS = 120
BROWSER_GET_STATE_MAX_ATTEMPTS = 4
BROWSER_WAIT_DEFAULT_TIMEOUT_MS = 5000
BROWSER_WAIT_POLL_INTERVAL_MS = 250
BROWSER_TOOL_MAX_TIMEOUT_MS = 30000
BROWSER_FIND_DEFAULT_MAX_RESULTS = 25
```

---

## 共享协议类型

`apps/desktop/shared/browser-pane-protocol.ts`（115 行）定义了主进程和渲染进程共享的类型：
- `BrowserSpaceId` — `"user" | "agent"`
- `BrowserStatePayload` — 标签页状态（url, title, loading, error）
- `BrowserTabListPayload` — 标签页列表（含活动标签、数量、生命周期状态、控制模式）
- `BrowserBookmarkPayload`、`BrowserDownloadPayload` 等
