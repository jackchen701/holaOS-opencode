import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../../harnesses/src/runtime-agent-tools.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function jsonRes(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

function buildMcpTools(): McpToolDefinition[] {
  return RUNTIME_AGENT_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.id,
    description: tool.description,
    inputSchema: {
      type: "object" as const,
      properties: {
        args: {
          type: "object",
          description: `Arguments for ${tool.id}`,
          additionalProperties: true,
        },
      },
    },
  }));
}

function buildBrowserMcpTools(): McpToolDefinition[] {
  const browserTools = [
    "browser_get_state",
    "browser_find",
    "browser_act",
    "browser_wait",
    "browser_select_tab",
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_screenshot",
    "browser_close_tab",
  ];
  return browserTools.map((id) => ({
    name: id,
    description: `Browser tool: ${id}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        args: { type: "object", additionalProperties: true },
      },
    },
  }));
}

async function proxyToolCall(
  toolName: string,
  args: Record<string, unknown>,
  runtimeApiUrl: string,
  sessionId: string,
  inputId: string,
  workspaceDir: string,
  timeoutMs: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${runtimeApiUrl}/capabilities/runtime-tools/${toolName}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-holaboss-session-id": sessionId,
        "x-holaboss-input-id": inputId,
        "x-holaboss-workspace-dir": workspaceDir,
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => `HTTP ${res.status}`);
      return {
        content: [{ type: "text", text: `Error from runtime API (${res.status}): ${errorText}` }],
      };
    }

    const result = await res.json();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        content: [{ type: "text", text: `Timeout after ${timeoutMs}ms calling ${toolName}` }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const runtimeApiUrl = getRequiredEnv("HOLABOSS_RUNTIME_API_URL");
  const workspaceDir = getRequiredEnv("HOLABOSS_WORKSPACE_DIR");
  const sessionId = process.env.HOLABOSS_SESSION_ID ?? "";
  const inputId = process.env.HOLABOSS_INPUT_ID ?? "";
  const timeoutMs = Number(process.env.HOLABOSS_MCP_TOOL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  const allTools = [...buildMcpTools(), ...buildBrowserMcpTools()];

  let requestId = 0;

  process.stdin.setEncoding("utf-8");
  const chunks: string[] = [];

  process.stdin.on("data", (chunk: string) => {
    chunks.push(chunk);
    const data = chunks.join("");
    const lines = data.split("\n");
    const remaining = lines.pop() ?? "";
    chunks.length = 0;
    if (remaining) chunks.push(remaining);

    for (const line of lines) {
      if (!line.trim()) continue;
      handleMessage(line, allTools, runtimeApiUrl, sessionId, inputId, workspaceDir, timeoutMs);
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });

  function sendJson(msg: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  async function handleMessage(
    line: string,
    tools: McpToolDefinition[],
    apiUrl: string,
    sessId: string,
    inId: string,
    wsDir: string,
    timeout: number,
  ): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const method = message.method as string | undefined;
    const msgId = message.id ?? ++requestId;

    if (method === "initialize") {
      sendJson({
        jsonrpc: "2.0",
        id: msgId,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "holaboss-runtime-tools", version: "0.1.0" },
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "tools/list") {
      sendJson({
        jsonrpc: "2.0",
        id: msgId,
        result: { tools },
      });
      return;
    }

    if (method === "tools/call") {
      const params = message.params as Record<string, unknown> | undefined;
      const toolName = params?.name as string | undefined;
      const toolArgs = (params?.arguments as Record<string, unknown>) ?? {};

      if (!toolName) {
        sendJson({
          jsonrpc: "2.0",
          id: msgId,
          error: { code: -32602, message: "Missing tool name" },
        });
        return;
      }

      const result = await proxyToolCall(toolName, toolArgs, apiUrl, sessId, inId, wsDir, timeout);
      sendJson({
        jsonrpc: "2.0",
        id: msgId,
        result,
      });
      return;
    }

    if (method === "ping") {
      sendJson({ jsonrpc: "2.0", id: msgId, result: {} });
      return;
    }

    sendJson({
      jsonrpc: "2.0",
      id: msgId,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

main().catch((error) => {
  process.stderr.write(`holaboss-runtime-mcp-server fatal: ${error}\n`);
  process.exit(1);
});
