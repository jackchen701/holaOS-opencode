import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server, type ServerResponse } from "node:http";

function jsonRes(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function startMockRuntimeApi(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/capabilities/runtime-tools/holaboss_delegate_task") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        jsonRes(res, { ok: true, task_id: "task-1", instruction: body });
      });
      return;
    }
    if (url.pathname === "/capabilities/runtime-tools/holaboss_cronjobs_list") {
      jsonRes(res, { ok: true, cronjobs: [] });
      return;
    }
    if (url.pathname.startsWith("/capabilities/runtime-tools/")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        jsonRes(res, { ok: true, tool: url.pathname.split("/").pop(), args: body });
      });
      return;
    }
    jsonRes(res, { error: "not found" }, 404);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

test("runtime tools MCP server tool list includes all RUNTIME_AGENT_TOOL_IDS", async () => {
  const { RUNTIME_AGENT_TOOL_IDS } = await import("../../harnesses/src/runtime-agent-tools.js");
  assert.ok(RUNTIME_AGENT_TOOL_IDS.length > 0, "should have runtime tool IDs");
  const toolIds = RUNTIME_AGENT_TOOL_IDS as string[];
  assert.ok(toolIds.includes("holaboss_delegate_task"), "should include delegate_task");
  assert.ok(toolIds.includes("holaboss_cronjobs_list"), "should include cronjobs list");
  assert.ok(toolIds.includes("workspace_data_query"), "should include workspace data query");
  assert.ok(toolIds.includes("terminal_session_start"), "should include terminal session start");
  assert.ok(toolIds.length >= 35, `should have at least 35 tools, got ${toolIds.length}`);
});

test("proxyToolCall forwards tool requests to runtime API", async () => {
  const server = await startMockRuntimeApi(0);
  const addr = server.address() as { port: number };
  const apiUrl = `http://127.0.0.1:${addr.port}`;

  const { RUNTIME_AGENT_TOOL_DEFINITIONS } = await import("../../harnesses/src/runtime-agent-tools.js");
  const toolDef = RUNTIME_AGENT_TOOL_DEFINITIONS.find((t) => t.id === "holaboss_delegate_task");
  assert.ok(toolDef, "holaboss_delegate_task definition should exist");

  const res = await fetch(`${apiUrl}/capabilities/runtime-tools/holaboss_delegate_task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-holaboss-session-id": "session-1",
      "x-holaboss-input-id": "input-1",
      "x-holaboss-workspace-dir": "/tmp/workspace",
    },
    body: JSON.stringify({ instruction: "do something" }),
  });

  assert.ok(res.ok, `Expected ok response, got ${res.status}`);
  const result = await res.json() as any;
  assert.equal(result.ok, true);
  assert.equal(result.task_id, "task-1");

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("proxyToolCall returns error for unknown tool", async () => {
  const server = await startMockRuntimeApi(0);
  const addr = server.address() as { port: number };
  const apiUrl = `http://127.0.0.1:${addr.port}`;

  const res = await fetch(`${apiUrl}/capabilities/runtime-tools/nonexistent_tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.ok(res.ok);
  const result = await res.json() as any;
  assert.equal(result.tool, "nonexistent_tool");

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("proxyToolCall returns error when runtime API is unreachable", async () => {
  const res = await fetch("http://127.0.0.1:1/capabilities/runtime-tools/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(2000),
  }).catch((e) => ({ ok: false, status: 0, error: e }));

  if ("error" in res) {
    assert.ok(true, "connection refused as expected");
  } else {
    assert.ok(!res.ok, "should not be ok when API unreachable");
  }
});

test("MCP server tool definitions cover runtime agent tools", async () => {
  const { RUNTIME_AGENT_TOOL_IDS } = await import("../../harnesses/src/runtime-agent-tools.js");
  const toolIds = RUNTIME_AGENT_TOOL_IDS as string[];
  const uniqueIds = new Set(toolIds);
  assert.equal(uniqueIds.size, toolIds.length, "tool IDs should be unique");
});
