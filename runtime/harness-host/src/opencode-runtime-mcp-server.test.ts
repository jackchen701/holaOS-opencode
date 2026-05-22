import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_SCRIPT = path.join(__dirname, "opencode-runtime-mcp-server.ts");

const RUNTIME_API_PORT = 18923 + Math.floor(Math.random() * 1000);
let nextPort = RUNTIME_API_PORT;

function getPort(): number {
  return nextPort++;
}

function spawnMcpServer(env: Record<string, string>): ChildProcess {
  return spawn("bun", ["run", MCP_SERVER_SCRIPT], {
    env: { ...process.env, ...env },
    cwd: path.resolve(__dirname, "../../"),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

class MockRuntimeApi {
  private server: Server;
  private port: number = 0;
  public receivedRequests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  private responses = new Map<string, { status: number; body: unknown }>();

  constructor() {
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<string> {
    this.port = getPort();
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${this.port}`);
      });
      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => { this.server.close(() => resolve()); });
  }

  setToolResponse(toolName: string, status: number, body: unknown): void {
    this.responses.set(toolName, { status, body });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[key] = value;
    }

    let body: unknown = null;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch { body = rawBody; }
    }

    this.receivedRequests.push({ method: req.method ?? "GET", url: url.pathname, headers, body });

    const toolMatch = url.pathname.match(/^\/capabilities\/runtime-tools\/(.+)$/);
    if (toolMatch) {
      const toolName = toolMatch[1]!;
      const response = this.responses.get(toolName);
      if (response) {
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response.body));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, tool: toolName }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
}

async function sendMcpMessage(lines: string[], messages: string[]): Promise<void> {
  for (const msg of messages) {
    lines.push(msg);
  }
}

test("MCP server initialize responds with protocol version and capabilities", async () => {
  const api = new MockRuntimeApi();
  const apiUrl = await api.start();

  const proc = spawnMcpServer({
    HOLABOSS_RUNTIME_API_URL: apiUrl,
    HOLABOSS_WORKSPACE_DIR: "/tmp/test-ws",
    HOLABOSS_SESSION_ID: "sess-1",
    HOLABOSS_INPUT_ID: "in-1",
  });

  const responses: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) responses.push(line);
    }
  });

  const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  proc.stdin!.write(initMsg + "\n");

  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.ok(responses.length >= 1, `expected at least 1 response, got ${responses.length}`);
  const initResp = JSON.parse(responses[0]!);
  assert.equal(initResp.result.protocolVersion, "2024-11-05");
  assert.equal(initResp.result.serverInfo.name, "holaboss-runtime-tools");

  proc.kill();
  await api.stop();
});

test("MCP server tools/list returns runtime agent tools", async () => {
  const api = new MockRuntimeApi();
  const apiUrl = await api.start();

  const proc = spawnMcpServer({
    HOLABOSS_RUNTIME_API_URL: apiUrl,
    HOLABOSS_WORKSPACE_DIR: "/tmp/test-ws",
    HOLABOSS_SESSION_ID: "sess-1",
    HOLABOSS_INPUT_ID: "in-1",
  });

  const responses: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) responses.push(line);
    }
  });

  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");

  await new Promise((resolve) => setTimeout(resolve, 500));

  const toolsResp = responses.map((r) => { try { return JSON.parse(r); } catch { return null; } }).find((r) => r?.id === 2);
  assert.ok(toolsResp, "should have tools/list response");
  assert.ok(Array.isArray(toolsResp.result.tools));
  assert.ok(toolsResp.result.tools.length > 0, `expected tools, got ${toolsResp.result.tools.length}`);

  const toolNames = toolsResp.result.tools.map((t: any) => t.name);
  assert.ok(toolNames.includes("holaboss_cronjobs_list"));
  assert.ok(toolNames.includes("holaboss_delegate_task"));

  proc.kill();
  await api.stop();
});

test("MCP server tools/call proxies to runtime API", async () => {
  const api = new MockRuntimeApi();
  const apiUrl = await api.start();

  api.setToolResponse("holaboss_cronjobs_list", 200, { cronjobs: [{ id: "cron-1", schedule: "0 9 * * *" }] });

  const proc = spawnMcpServer({
    HOLABOSS_RUNTIME_API_URL: apiUrl,
    HOLABOSS_WORKSPACE_DIR: "/tmp/test-ws",
    HOLABOSS_SESSION_ID: "sess-mcp-1",
    HOLABOSS_INPUT_ID: "in-mcp-1",
  });

  const responses: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) responses.push(line);
    }
  });

  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  proc.stdin!.write(JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "holaboss_cronjobs_list", arguments: {} },
  }) + "\n");

  await new Promise((resolve) => setTimeout(resolve, 500));

  const callResp = responses.map((r) => { try { return JSON.parse(r); } catch { return null; } }).find((r) => r?.id === 3);
  assert.ok(callResp, "should have tools/call response");
  assert.ok(callResp.result.content);
  assert.equal(callResp.result.content[0].type, "text");

  const resultData = JSON.parse(callResp.result.content[0].text);
  assert.ok(resultData.cronjobs);
  assert.equal(resultData.cronjobs[0].id, "cron-1");

  assert.ok(api.receivedRequests.length >= 1);
  const req = api.receivedRequests.find((r) => r.url.includes("holaboss_cronjobs_list"));
  assert.ok(req, "runtime API should have received tool call");
  assert.equal(req!.headers["x-holaboss-session-id"], "sess-mcp-1");
  assert.equal(req!.headers["x-holaboss-input-id"], "in-mcp-1");
  assert.equal(req!.headers["x-holaboss-workspace-dir"], "/tmp/test-ws");

  proc.kill();
  await api.stop();
});

test("MCP server returns error for HTTP 500 from runtime API", async () => {
  const api = new MockRuntimeApi();
  const apiUrl = await api.start();

  api.setToolResponse("holaboss_cronjobs_create", 500, { error: "internal server error" });

  const proc = spawnMcpServer({
    HOLABOSS_RUNTIME_API_URL: apiUrl,
    HOLABOSS_WORKSPACE_DIR: "/tmp/test-ws",
    HOLABOSS_SESSION_ID: "sess-1",
    HOLABOSS_INPUT_ID: "in-1",
  });

  const responses: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) responses.push(line);
    }
  });

  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  proc.stdin!.write(JSON.stringify({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "holaboss_cronjobs_create", arguments: { schedule: "0 9 * * *" } },
  }) + "\n");

  await new Promise((resolve) => setTimeout(resolve, 500));

  const callResp = responses.map((r) => { try { return JSON.parse(r); } catch { return null; } }).find((r) => r?.id === 5);
  assert.ok(callResp);
  assert.ok(callResp.result.content[0].text.includes("Error from runtime API (500)"));

  proc.kill();
  await api.stop();
});

test("MCP server returns error for missing tool name", async () => {
  const api = new MockRuntimeApi();
  const apiUrl = await api.start();

  const proc = spawnMcpServer({
    HOLABOSS_RUNTIME_API_URL: apiUrl,
    HOLABOSS_WORKSPACE_DIR: "/tmp/test-ws",
    HOLABOSS_SESSION_ID: "sess-1",
    HOLABOSS_INPUT_ID: "in-1",
  });

  const responses: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) responses.push(line);
    }
  });

  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  proc.stdin!.write(JSON.stringify({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { arguments: {} },
  }) + "\n");

  await new Promise((resolve) => setTimeout(resolve, 500));

  const callResp = responses.map((r) => { try { return JSON.parse(r); } catch { return null; } }).find((r) => r?.id === 6);
  assert.ok(callResp);
  assert.ok(callResp.error);
  assert.equal(callResp.error.code, -32602);

  proc.kill();
  await api.stop();
});

test("MCP server handles ping", async () => {
  const api = new MockRuntimeApi();
  const apiUrl = await api.start();

  const proc = spawnMcpServer({
    HOLABOSS_RUNTIME_API_URL: apiUrl,
    HOLABOSS_WORKSPACE_DIR: "/tmp/test-ws",
    HOLABOSS_SESSION_ID: "sess-1",
    HOLABOSS_INPUT_ID: "in-1",
  });

  const responses: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) responses.push(line);
    }
  });

  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) + "\n");

  await new Promise((resolve) => setTimeout(resolve, 500));

  const pingResp = responses.map((r) => { try { return JSON.parse(r); } catch { return null; } }).find((r) => r?.id === 7);
  assert.ok(pingResp);
  assert.deepEqual(pingResp.result, {});

  proc.kill();
  await api.stop();
});

test("MCP server handles unknown method", async () => {
  const api = new MockRuntimeApi();
  const apiUrl = await api.start();

  const proc = spawnMcpServer({
    HOLABOSS_RUNTIME_API_URL: apiUrl,
    HOLABOSS_WORKSPACE_DIR: "/tmp/test-ws",
    HOLABOSS_SESSION_ID: "sess-1",
    HOLABOSS_INPUT_ID: "in-1",
  });

  const responses: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) responses.push(line);
    }
  });

  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "unknown/method" }) + "\n");

  await new Promise((resolve) => setTimeout(resolve, 500));

  const unknownResp = responses.map((r) => { try { return JSON.parse(r); } catch { return null; } }).find((r) => r?.id === 8);
  assert.ok(unknownResp);
  assert.ok(unknownResp.error);
  assert.equal(unknownResp.error.code, -32601);

  proc.kill();
  await api.stop();
});

test("MCP server browser tools are included in tools/list", async () => {
  const api = new MockRuntimeApi();
  const apiUrl = await api.start();

  const proc = spawnMcpServer({
    HOLABOSS_RUNTIME_API_URL: apiUrl,
    HOLABOSS_WORKSPACE_DIR: "/tmp/test-ws",
    HOLABOSS_SESSION_ID: "sess-1",
    HOLABOSS_INPUT_ID: "in-1",
  });

  const responses: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) responses.push(line);
    }
  });

  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");

  await new Promise((resolve) => setTimeout(resolve, 500));

  const toolsResp = responses.map((r) => { try { return JSON.parse(r); } catch { return null; } }).find((r) => r?.id === 2);
  const toolNames = toolsResp.result.tools.map((t: any) => t.name);

  assert.ok(toolNames.includes("browser_get_state"));
  assert.ok(toolNames.includes("browser_act"));
  assert.ok(toolNames.includes("browser_screenshot"));

  proc.kill();
  await api.stop();
});

test("MCP server proxies multiple tool calls independently", async () => {
  const api = new MockRuntimeApi();
  const apiUrl = await api.start();

  api.setToolResponse("holaboss_onboarding_status", 200, { completed: true });
  api.setToolResponse("holaboss_cronjobs_list", 200, { cronjobs: [] });

  const proc = spawnMcpServer({
    HOLABOSS_RUNTIME_API_URL: apiUrl,
    HOLABOSS_WORKSPACE_DIR: "/tmp/test-ws",
    HOLABOSS_SESSION_ID: "sess-multi",
    HOLABOSS_INPUT_ID: "in-multi",
  });

  const responses: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) responses.push(line);
    }
  });

  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "holaboss_onboarding_status", arguments: {} } }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "holaboss_cronjobs_list", arguments: {} } }) + "\n");

  await new Promise((resolve) => setTimeout(resolve, 500));

  const resp10 = responses.map((r) => { try { return JSON.parse(r); } catch { return null; } }).find((r) => r?.id === 10);
  const resp11 = responses.map((r) => { try { return JSON.parse(r); } catch { return null; } }).find((r) => r?.id === 11);

  assert.ok(resp10, "should have response for first tool call");
  assert.ok(resp11, "should have response for second tool call");

  assert.ok(resp10.result.content[0].text.includes("completed"));
  assert.ok(resp11.result.content[0].text.includes("cronjobs"));

  const toolCalls = api.receivedRequests.filter((r) => r.url.includes("runtime-tools"));
  assert.equal(toolCalls.length, 2, "should have 2 proxied calls");

  proc.kill();
  await api.stop();
});

test("MCP server session ID and workspace dir headers propagated", async () => {
  const api = new MockRuntimeApi();
  const apiUrl = await api.start();

  const proc = spawnMcpServer({
    HOLABOSS_RUNTIME_API_URL: apiUrl,
    HOLABOSS_WORKSPACE_DIR: "/tmp/my-workspace",
    HOLABOSS_SESSION_ID: "sess-header-test",
    HOLABOSS_INPUT_ID: "in-header-test",
  });

  const responses: string[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) responses.push(line);
    }
  });

  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "holaboss_scratchpad_read", arguments: {} } }) + "\n");

  await new Promise((resolve) => setTimeout(resolve, 500));

  const req = api.receivedRequests.find((r) => r.url.includes("holaboss_scratchpad_read"));
  assert.ok(req, "should have received tool call");
  assert.equal(req!.headers["x-holaboss-session-id"], "sess-header-test");
  assert.equal(req!.headers["x-holaboss-input-id"], "in-header-test");
  assert.equal(req!.headers["x-holaboss-workspace-dir"], "/tmp/my-workspace");

  proc.kill();
  await api.stop();
});
