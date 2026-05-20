# Electron 浏览器工具链迁移指南

## 目标

将 holaOS 的 Electron 内置浏览器自动化工具链抽取为可复用范式，使另一个 Electron 项目可以直接复刻同类能力。

---

## 源文件清单

按迁移顺序排列，标注每个文件的职责和迁移优先级：

### 必迁文件（核心）

| # | 源路径 | 行数 | 职责 | 迁移优先级 |
|---|--------|------|------|-----------|
| 1 | `runtime/harnesses/src/desktop-browser-tools.ts` | 784 | 工具 ID + JSON Schema 定义（纯数据，零依赖） | P0 |
| 2 | `runtime/harnesses/src/capability-http.ts` | 243 | 通用 HTTP 请求 + 结果格式化（零外部依赖） | P0 |
| 3 | `runtime/harnesses/src/browser-capability-client.ts` | 133 | 浏览器能力 HTTP 客户端（依赖 #1, #2） | P0 |
| 4 | `runtime/harnesses/src/browser-capability-tools.ts` | 843 | Harness 工具适配层（依赖 #1, #3） | P1 |
| 5 | `apps/desktop/electron/browser-pane/http-service.ts` | 1333 | Electron 主进程 HTTP 桥接（依赖 Electron API） | P1 |
| 6 | `apps/desktop/shared/browser-pane-protocol.ts` | 115 | 主进程↔渲染进程共享类型 | P0 |

### 需适配文件（执行引擎）

| # | 源路径 | 行数 | 职责 | 迁移优先级 |
|---|--------|------|------|-----------|
| 7 | `runtime/api-server/src/desktop-browser-tools.ts` | ~4000 | 工具执行引擎（参数解析 + JS 表达式生成 + 调 Electron） | P1 |
| 8 | `runtime/harness-host/src/pi-browser-tools.ts` | 37 | Pi 框架适配层（薄壳，可替换） | P2 |

### 辅助子系统（可渐进迁移）

| # | 源路径 | 职责 | 迁移优先级 |
|---|--------|------|-----------|
| 9 | `electron/browser-pane/tab-state.ts` | 标签页状态管理 | P2 |
| 10 | `electron/browser-pane/tab-observability.ts` | Console/error/request 观测 | P2 |
| 11 | `electron/browser-pane/observability.ts` | 共享观测类型 | P2 |
| 12 | `electron/browser-pane/agent-session-lifecycle.ts` | Agent 会话生命周期 | P2 |
| 13 | `electron/browser-pane/user-lock.ts` | 并发访问锁 | P2 |
| 14 | `electron/browser-pane/downloads.ts` | 下载追踪 | P3 |
| 15 | `electron/browser-pane/popups.ts` | 弹窗处理 | P3 |
| 16 | `electron/browser-pane/bookmarks.ts` | 书签管理 | P3 |

---

## 迁移步骤

### Step 1：复制纯数据层（P0）

直接复制，几乎不需要改动：

```
desktop-browser-tools.ts     →  定义 30 个工具的 ID、Schema、Policy
capability-http.ts           →  HTTP 请求封装 + 结果截断格式化
browser-pane-protocol.ts     →  BrowserSpaceId、BrowserStatePayload 等共享类型
```

改动点：
- 去掉 `x-holaboss-*` 前缀的 header 名，替换为你项目的 header 名
- `browserCapabilityHeaders()` 中的 workspace/session/input/space 字段按需调整

### Step 2：复制 HTTP Client（P0）

```
browser-capability-client.ts  →  browserCapabilityAvailable() + executeBrowserCapabilityTool()
```

改动点：
- URL 路径 `/api/v1/capabilities/browser` 可按需改名
- `DEFAULT_BROWSER_TOOL_TIMEOUT_MS` 默认 30s，按需调整
- 错误信息中 `Holaboss` 替换为项目名

### Step 3：实现 Electron 主进程 HTTP 桥接（P1）

这是迁移工作量最大的一步。参考 `http-service.ts`：

1. **创建 HTTP 服务器**（Node.js `http.createServer`，在 Electron 主进程中启动）
2. **实现认证**：生成 token，请求时校验 `x-<project>-desktop-token`
3. **实现路由**：按以下优先级逐步实现

   第一批（最小可用）：
   - `GET /health` — 健康检查
   - `GET /tabs` — 列出标签页
   - `POST /navigate` — 导航（`webContents.loadURL()`）
   - `POST /evaluate` — 执行 JS（`webContents.executeJavaScript()`）
   - `POST /screenshot` — 截图（`webContents.capturePage()`）
   - `GET /page` — 获取页面状态

   第二批（DOM 交互增强）：
   - `POST /mouse` — 原生鼠标事件（`webContents.sendInputEvent()`）
   - `POST /keyboard` — 原生键盘事件
   - `POST /context-click` — 右键菜单
   - `POST /tabs` — 新建标签页
   - `POST /tabs/select` — 切换标签页
   - `POST /tabs/close` — 关闭标签页

   第三批（可观测性）：
   - `GET /console` — 控制台输出
   - `GET /errors` — 页面错误
   - `GET /requests` — 网络请求
   - `GET /cookies` / `POST /cookies`
   - `GET /downloads`

4. **标签页管理**：用 `BrowserView` 或 `webContents` 管理多标签页
5. **观测性注入**：在 `webContents` 上注册 `console-message`、`render-process-gone`、`did-fail-load`、`did-navigate` 等事件监听

### Step 4：实现工具执行引擎（P1）

参考 `api-server/src/desktop-browser-tools.ts`，核心模式：

```
execute(toolId, args, context):
  1. 解析 runtime config → 得到 Electron HTTP 桥接地址 + token
  2. 按 toolId 分派:
     - 导航类 → 转发到 Electron HTTP bridge 的 /navigate, /tabs 等
     - DOM 操作类 → 生成 JS 表达式字符串 → 通过 /evaluate 执行
     - 截图类 → 转发到 /screenshot
     - 可观测类 → 转发到 /console, /errors, /requests 等
     - 存储/Cookie类 → 生成 JS 表达式 → 通过 /evaluate 执行
  3. 解析结果，格式化返回
```

需要迁移的关键 JS 表达式生成函数：
- `interactiveElementsExpression()` — DOM 快照
- `browserFindExpression()` — 元素查找
- `browserActExpression()` — 动作执行
- `browserWaitPredicateExpression()` — 等待条件
- `browserStorageGetExpression()` / `browserStorageSetExpression()`

### Step 5：注册 API 路由（P1）

在 API server（Fastify/Express/Koa）中注册两个路由：
- `GET /api/v1/capabilities/browser` — 检查浏览器可用性
- `POST /api/v1/capabilities/browser/tools/:toolId` — 执行工具

### Step 6：接入 Harness/Agent 层（P2）

参考 `browser-capability-tools.ts` 和 `pi-browser-tools.ts`：

1. 实现 `createHarnessDesktopBrowserToolDefinition()` — 将工具定义包装为你的 Agent 框架的 Tool 对象
2. 实现 `resolveHarnessDesktopBrowserToolDefinitions()` — 带可用性检查的工具加载
3. 在 Agent 工具注册点注入浏览器工具

---

## 接口契约总结

### Harness → API Server

```
POST /api/v1/capabilities/browser/tools/{toolId}
Headers:
  x-holaboss-workspace-id: <workspace-id>
  x-holaboss-session-id: <session-id>
  x-holaboss-input-id: <input-id>
  x-holaboss-browser-space: "agent" | "user"
Body: JSON — 工具参数（每个工具不同）

Response: JSON
{
  ...工具结果,
  browser_usage: { tool_id, ... }  // 可选
}
```

### API Server → Electron HTTP Bridge

```
POST /api/v1/browser/{route}
Headers:
  x-holaboss-desktop-token: <auth-token>
Body: JSON — 路由参数

Response: JSON — 路由结果
```

---

## 可省略的部分

- **用户浏览器锁** (`user-lock.ts`) — 如果不需要防止 Agent 和用户同时操作，可以跳过
- **浏览器配置导入** (`import-browsers.ts`, `import-chromium.ts`) — 如果不需要从 Chrome/Safari 导入 profile，可以跳过
- **书签管理** (`bookmarks.ts`) — 非核心
- **Pi 框架适配** (`pi-browser-tools.ts`) — 需替换为你自己的 Agent 框架适配层

---

## 测试迁移建议

源测试文件：

| 测试文件 | 覆盖范围 |
|---------|---------|
| `runtime/api-server/src/desktop-browser-tools.test.ts` | 工具执行引擎单元测试 |
| `runtime/harness-host/src/pi-browser-tools.test.ts` | Harness 适配层测试 |
| `apps/desktop/electron/browser-*.test.mjs`（14 个文件） | Electron 桥接层测试 |
| `apps/desktop/e2e/browser-workspace-isolation.test.mjs` | E2E 隔离测试 |

迁移策略：先迁移 `desktop-browser-tools.test.ts` 中的参数解析测试和 JS 表达式测试（不依赖 Electron），再迁移 HTTP bridge 测试。

---

## 执行引擎方案对比

迁移时 Layer 1（工具定义）和 Layer 2（Harness 适配）完全不变，需要选择的是 **Layer 3（执行引擎）和 Layer 4（Electron 桥接）的实现方式**。以下对比三种主流方案。

### 方案 A：WebContents + JS 注入（holaOS 当前方案）

手动拼 JavaScript 表达式，通过 `webContents.executeJavaScript()` 注入到页面执行。

**核心代码模式：**
```
browser_get_state  →  生成 ~200 行 JS → executeJavaScript(interactiveElementsExpression())
browser_act        →  生成 action 分发 JS → executeJavaScript(browserActExpression())
browser_click      →  按 index 取元素 → executeJavaScript() 或 sendInputEvent()
browser_wait       →  生成轮询谓词 JS → 循环 executeJavaScript() 每 250ms 一次
```

| 维度 | 评价 |
|------|------|
| 外部依赖 | 零 |
| 执行引擎代码量 | ~4000 行 |
| Electron HTTP bridge 代码量 | ~1300 行 |
| 等待/重试 | 全部手写（轮询 250ms、最多 4 次重试） |
| 选择器能力 | 基础 CSS + XPath，手写匹配逻辑 |
| 输入模拟 | `sendInputEvent()` + DOM `.click()`，混合策略 |
| Shadow DOM / iframe | 不支持或需额外处理 |
| 维护成本 | **高** — JS 表达式注入与 DOM 规范耦合，浏览器更新可能导致注入表达式失效 |
| 适用场景 | 对依赖体积零容忍、需要完全控制 |

### 方案 B：CDP (Chrome DevTools Protocol)

Electron 内置 `webContents.debugger` API，直接发送 CDP 命令，无需外部依赖。

**核心代码模式：**
```
browser_get_state  →  debugger.sendCommand('DOM.getDocument')
                     + debugger.sendCommand('DOM.querySelectorAll', { nodeId, selector })
                     + debugger.sendCommand('DOM.getBoxModel', { nodeId })
browser_act        →  debugger.sendCommand('DOM.resolveNode', { nodeId })
                     + debugger.sendCommand('Runtime.callFunctionOn', { functionDeclaration, nodeId })
browser_click      →  debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y })
                     + debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y })
browser_wait       →  debugger.sendCommand('Page.enable')
                     + 监听 CDP 事件 Page.loadEventFired / DOM.childNodeInserted
```

| 维度 | 评价 |
|------|------|
| 外部依赖 | 零（Electron 内置） |
| 执行引擎代码量 | ~2000 行（比方案 A 少 50%） |
| Electron HTTP bridge 代码量 | ~800 行 |
| 等待/重试 | CDP 原生事件（`Page.loadEventFired`、`DOM.childNodeInserted`、`Page.frameNavigated`） |
| 选择器能力 | `DOM.querySelector` + `DOM.querySelectorAll` + `DOM.performSearch` |
| 输入模拟 | `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`（比 sendInputEvent 更精确） |
| Shadow DOM / iframe | CDP 原生支持（`DOM.getDocument` 可指定 depth、pierce） |
| 维护成本 | **中** — CDP 协议由 Chrome 团队维护，API 稳定；需处理 debugger attach/detach 生命周期 |
| 适用场景 | **生产级 Electron 应用首选** |

**关键注意点：**
- `webContents.debugger.attach('1.3')` 后才能发送命令
- 同一时间只能有一个 debugger 附加到同一个 webContents
- 页面导航可能触发 debugger detach，需要自动重连
- 部分操作（如文件上传）仍需回退到 `webContents` API

**迁移路径（从方案 A 迁移到方案 B）：**

只需替换 Layer 3 和 Layer 4 的内部实现，工具定义和 Harness 层不动：

```
当前: webContents.executeJavaScript(interactiveElementsExpression())
改为: webContents.debugger.sendCommand('DOM.getDocument')
     + webContents.debugger.sendCommand('DOM.querySelectorAll', { nodeId, selector })

当前: webContents.sendInputEvent({ type: 'mouseDown', ... })
改为: webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ... })

当前: 手写轮询等待 (250ms interval + executeJavaScript)
改为: 监听 CDP 事件 Page.loadEventFired / DOM.childNodeInserted
```

### 方案 C：Playwright (connectOverCDP)

Playwright 通过 CDP 连接到 Electron 已有的浏览器实例，使用 Playwright 的全套 API。

**核心代码模式：**
```
// Electron 启动时开启调试端口
app.commandLine.appendSwitch('remote-debugging-port', '9222')

// 工具执行引擎中
const browser = await chromium.connectOverCDP('http://localhost:9222')
const page = browser.contexts()[0].pages()[0]

browser_get_state  →  page.evaluate(() => ...) 或 page.accessibility.snapshot()
browser_act        →  page.click('button.submit')
browser_click      →  page.locator(`nth=${index}`).click()
browser_wait       →  page.waitForSelector('.result') / page.waitForURL('**/done')
browser_screenshot →  page.screenshot()
```

| 维度 | 评价 |
|------|------|
| 外部依赖 | `playwright-core`（~40MB，不含浏览器二进制） |
| 执行引擎代码量 | **~400 行**（砍到方案 A 的 1/10） |
| Electron HTTP bridge | **可完全移除** — Playwright 直接操作 CDP |
| 等待/重试 | **极强** — 内置 auto-waiting，所有操作自动等待元素可操作 |
| 选择器能力 | CSS、XPath、text、role、test-id、组合选择器、自定义选择器引擎 |
| 输入模拟 | 原生级，支持 iframe、shadow DOM、文件上传、拖拽 |
| Shadow DOM / iframe | 完全支持 |
| 维护成本 | **最低** — Playwright 团队维护选择器引擎和等待逻辑 |
| 致命风险 | **Electron Chromium 版本必须与 Playwright 编译时版本兼容**，不匹配会静默失败或崩溃 |
| 适用场景 | 内部工具 / 快速验证 / 可以锁定依赖版本的项目 |

**版本兼容性风险详解：**

Electron 每个版本捆绑特定 Chromium，Playwright 每个版本也编译自特定 Chromium。两者必须匹配：

| Electron 版本 | Chromium 版本 | 兼容的 Playwright 版本 |
|--------------|--------------|----------------------|
| Electron 33 | Chromium 130 | Playwright 1.48+ |
| Electron 32 | Chromium 128 | Playwright 1.46+ |
| Electron 31 | Chromium 126 | Playwright 1.44+ |

不匹配时的表现：连接可能成功但操作结果不正确、选择器行为异常、截图失败——且**不会报明确错误**。

**缓解措施：**
- 在 `package.json` 中锁定 `playwright-core` 版本，并写死 Electron 版本
- 启动时校验 Chromium 版本号是否匹配
- 使用 `playwright-core`（不含浏览器下载），不要用 `playwright`（会下载自己的 Chromium）

### 方案对比总结

| 维度 | A: JS 注入 | B: CDP | C: Playwright CDP |
|------|-----------|--------|-------------------|
| 外部依赖 | 无 | 无 | playwright-core ~40MB |
| 执行引擎代码量 | ~4000 行 | ~2000 行 | ~400 行 |
| Bridge 代码量 | ~1300 行 | ~800 行 | 0（不需要） |
| 等待/稳定性 | 手写轮询 | CDP 事件 | auto-waiting |
| 选择器能力 | 基础 | 中等 | 极强 |
| Shadow DOM | 不支持 | 支持 | 支持 |
| 版本耦合 | 无 | 无（CDP 协议稳定） | **高（Chromium 版本锁）** |
| 维护成本 | 高 | 中 | 低 |
| 生产可靠性 | 中 | 高 | 中（受版本耦合影响） |
| 推荐场景 | 完全控制 | **生产首选** | 快速验证 |

### 推荐决策路径

```
能否锁定 Electron + Playwright 版本？
├── 能 → 方案 C（Playwright），最少代码量，最快落地
└── 不能 → 是否需要零外部依赖？
    ├── 是 → 方案 B（CDP），生产级，零依赖
    └── 否 → 方案 B（CDP），仍然是最佳平衡点
```

**结论：对于另一个 Electron 项目，方案 B（CDP）是默认推荐。** 方案 C 在你能严格锁定依赖版本时也值得考虑，但长期维护风险更高。方案 A（当前 holaOS 的做法）不建议在新项目中复刻。
