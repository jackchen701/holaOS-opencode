import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

import type { HarnessHostOpencodeRequest } from "./opencode-contracts.js";
import type { RunnerOutputEvent, RunnerEventType, JsonObject } from "./contracts.js";

const OPENCODE_SERVER_STARTUP_TIMEOUT_MS = 15_000;
const OPENCODE_IDLE_TIMEOUT_S = 900;
const OPENCODE_HEARTBEAT_INTERVAL_S = 10;

type EventV2Type = string;

interface GlobalSSEEvent {
  directory: string;
  payload: {
    id: string;
    type: EventV2Type;
    properties: Record<string, unknown>;
  };
}

function emitRunnerEvent(event: RunnerOutputEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function mapEventV2ToRunnerEvent(
  eventV2Type: EventV2Type,
  properties: Record<string, unknown>,
  sessionId: string,
  inputId: string,
  sequence: number,
): RunnerOutputEvent | null {
  const base = { session_id: sessionId, input_id: inputId, sequence };

  switch (eventV2Type) {
    case "session.next.text.delta":
      return { ...base, event_type: "output_delta", payload: { delta: properties.delta ?? "" } };
    case "session.next.reasoning.delta":
      return { ...base, event_type: "thinking_delta", payload: { delta: properties.delta ?? "" } };
    case "session.next.tool.called":
      return {
        ...base,
        event_type: "tool_call" as RunnerEventType,
        payload: {
          phase: "started",
          tool_name: properties.tool ?? "unknown",
          call_id: properties.callID ?? "",
          tool_args: properties.input ?? {},
        },
      };
    case "session.next.tool.progress":
      return {
        ...base,
        event_type: "tool_call" as RunnerEventType,
        payload: {
          phase: "in_progress",
          call_id: properties.callID ?? "",
          progress: properties.structured ?? properties.content ?? {},
        },
      };
    case "session.next.tool.success":
      return {
        ...base,
        event_type: "tool_call" as RunnerEventType,
        payload: {
          phase: "completed",
          call_id: properties.callID ?? "",
          error: false,
          result: properties.content ?? properties.structured ?? {},
        },
      };
    case "session.next.tool.failed":
      return {
        ...base,
        event_type: "tool_call" as RunnerEventType,
        payload: {
          phase: "completed",
          call_id: properties.callID ?? "",
          error: true,
          result: properties.error ?? { message: "tool failed" },
        },
      };
    case "session.next.step.ended": {
      const tokens = properties.tokens as Record<string, unknown> | undefined;
      const cost = properties.cost as number | undefined;
      const usage: Record<string, unknown> = {};
      if (tokens) {
        usage.input_tokens = tokens.input ?? 0;
        usage.output_tokens = tokens.output ?? 0;
        usage.cached_input_tokens = (tokens.cache as Record<string, unknown>)?.read ?? 0;
        usage.cache_write_input_tokens = (tokens.cache as Record<string, unknown>)?.write ?? 0;
        usage.total_tokens =
          (typeof tokens.input === "number" ? tokens.input : 0) +
          (typeof tokens.output === "number" ? tokens.output : 0) +
          (typeof tokens.reasoning === "number" ? tokens.reasoning : 0);
      }
      if (typeof cost === "number") usage.estimated_cost_usd = cost;
      return {
        ...base,
        event_type: "run_completed" as RunnerEventType,
        payload: {
          status: "success",
          source: "opencode",
          ...(Object.keys(usage).length > 0 ? { usage } : {}),
        },
      };
    }
    case "session.next.step.failed":
      return {
        ...base,
        event_type: "run_failed" as RunnerEventType,
        payload: {
          type: "Error",
          message: (properties.error as Record<string, unknown>)?.message ?? "step failed",
          source: "opencode",
        },
      };
    case "session.next.compaction.started":
      return { ...base, event_type: "auto_compaction_start", payload: { reason: properties.reason ?? "auto" } };
    case "session.next.compaction.ended":
      return { ...base, event_type: "auto_compaction_end", payload: { text: properties.text ?? "" } };
    default:
      return null;
  }
}

function resolveOpencodeProviderType(modelProxyProvider: string): string {
  const normalized = modelProxyProvider.trim().toLowerCase();
  switch (normalized) {
    case "openai_compatible":
      return "openai";
    case "anthropic_native":
      return "anthropic";
    case "google_compatible":
      return "google";
    default:
      throw new Error(
        `unsupported model_proxy_provider for opencode harness: "${modelProxyProvider}". ` +
        `supported values: openai_compatible, anthropic_native, google_compatible`,
      );
  }
}

function buildOpencodeConfig(request: HarnessHostOpencodeRequest): Record<string, unknown> {
  const modelClient = request.model_client;
  if (!modelClient.api_key) {
    throw new Error(
      "opencode harness requires model_client.api_key from holaOS runtime config. " +
      "ensure runtime-config.json has a provider with api_key configured.",
    );
  }
  if (!modelClient.base_url) {
    throw new Error(
      "opencode harness requires model_client.base_url from holaOS runtime config. " +
      "ensure runtime-config.json has a provider with base_url configured.",
    );
  }
  const modelProxyProvider = modelClient.model_proxy_provider ?? "";
  if (!modelProxyProvider) {
    throw new Error(
      "opencode harness requires model_client.model_proxy_provider from holaOS runtime config. " +
      "this is resolved automatically by agent-runtime-config.ts from your provider kind.",
    );
  }
  const providerType = resolveOpencodeProviderType(modelProxyProvider);

  const providerConfig: Record<string, unknown> = {
    type: providerType,
    apiKey: modelClient.api_key,
    baseURL: modelClient.base_url,
  };
  if (modelClient.default_headers && Object.keys(modelClient.default_headers).length > 0) {
    providerConfig.headers = modelClient.default_headers;
  }

  const mcpServers: Record<string, unknown> = {};
  const runtimeApiUrl = request.runtime_api_base_url;
  if (runtimeApiUrl) {
    mcpServers["holaboss-runtime"] = {
      type: "local",
      command: process.execPath,
      args: [import.meta.url.replace(/\/src\/opencode\.ts$/, "/opencode-runtime-mcp-server.mjs")],
      env: {
        HOLABOSS_RUNTIME_API_URL: runtimeApiUrl,
        HOLABOSS_WORKSPACE_DIR: request.workspace_dir,
        HOLABOSS_SESSION_ID: request.session_id,
        HOLABOSS_INPUT_ID: request.input_id,
      },
    };
  }
  for (const server of request.mcp_servers ?? []) {
    const name = server.name as string;
    if (name && typeof name === "string") {
      mcpServers[name] = server.config ?? {};
    }
  }
  return {
    provider: {
      "holaboss-proxy": {
        ...providerConfig,
        models: {
          default: request.model_id,
        },
      },
    },
    mcp: { servers: mcpServers },
  };
}

async function waitForServerReady(proc: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`opencode server did not start within ${OPENCODE_SERVER_STARTUP_TIMEOUT_MS}ms`));
    }, OPENCODE_SERVER_STARTUP_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        const match = line.match(/opencode server listening on (https?:\/\/\S+)/);
        if (match) {
          cleanup();
          resolve(match[1]!);
          return;
        }
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`opencode server exited with code ${code}\n${output}`));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.once("exit", onExit);
    proc.once("error", onError);
  });
}

async function consumeGlobalSSE(
  url: string,
  workspaceDir: string,
  sessionId: string,
  inputId: string,
  abortSignal: AbortSignal,
  onEvent: (event: RunnerOutputEvent) => void,
  onHeartbeat: () => void,
  onTerminal: () => void,
): Promise<void> {
  const sseUrl = `${url}/global/event`;
  const response = await fetch(sseUrl, { signal: abortSignal });
  if (!response.ok) {
    throw new Error(`SSE connection failed: ${response.status}`);
  }
  if (!response.body) {
    throw new Error("SSE response has no body");
  }

  let sequence = 0;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!abortSignal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;
        let eventData = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("data: ")) {
            eventData += line.slice(6);
          }
        }
        if (!eventData) continue;

        let globalEvent: GlobalSSEEvent;
        try {
          globalEvent = JSON.parse(eventData) as GlobalSSEEvent;
        } catch {
          continue;
        }

        if (globalEvent.directory && globalEvent.directory !== workspaceDir) continue;

        const payload = globalEvent.payload;
        if (!payload?.type) continue;

        if (payload.type === "server.heartbeat") {
          onHeartbeat();
          continue;
        }
        if (payload.type === "server.connected") {
          continue;
        }

        const mapped = mapEventV2ToRunnerEvent(
          payload.type,
          payload.properties as Record<string, unknown>,
          sessionId,
          inputId,
          sequence++,
        );
        if (!mapped) continue;

        onEvent(mapped);

        if (mapped.event_type === "run_completed" || mapped.event_type === "run_failed") {
          onTerminal();
          return;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function runOpencode(request: HarnessHostOpencodeRequest): Promise<number> {
  const startTime = Date.now();
  let sequence = 0;
  const nextSequence = () => ++sequence;
  let terminalEmitted = false;
  let proc: ChildProcess | null = null;
  const abortController = new AbortController();

  const idleTimeoutMs = Math.min(
    request.timeout_seconds > 0 ? request.timeout_seconds : OPENCODE_IDLE_TIMEOUT_S,
    OPENCODE_IDLE_TIMEOUT_S,
  ) * 1000;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortController.abort();
    }, idleTimeoutMs);
  }

  function cleanup(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    if (proc && proc.exitCode === null) {
      proc.kill("SIGKILL");
    }
  }

  if (request.timeout_seconds > 0) {
    hardTimer = setTimeout(() => {
      abortController.abort();
    }, request.timeout_seconds * 1000);
  }

  try {
    const config = buildOpencodeConfig(request);

    const opencodeBin =
      process.env.HOLABOSS_OPENCODE_BIN ??
      (process.env.HOME ? `${process.env.HOME}/.opencode/bin/opencode` : "opencode");

    proc = spawn(opencodeBin, ["serve", "--port=0"], {
      cwd: request.workspace_dir,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const serverUrl = await waitForServerReady(proc);

    emitRunnerEvent({
      session_id: request.session_id,
      input_id: request.input_id,
      sequence: nextSequence(),
      event_type: "run_started" as RunnerEventType,
      payload: {
        ...request.run_started_payload,
        harness_session_id: request.harness_session_id ?? null,
      },
    });

    const createRes = await fetch(`${serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-directory": request.workspace_dir },
      signal: abortController.signal,
    });
    if (!createRes.ok) {
      throw new Error(`Failed to create opencode session: ${createRes.status}`);
    }
    const session = (await createRes.json()) as { id: string };
    const ocSessionId = session.id;

    const promptPayload: Record<string, unknown> = {
      content: request.instruction,
    };

    if (request.system_prompt) {
      promptPayload.system = request.system_prompt;
    }

    const promptRes = await fetch(`${serverUrl}/session/${ocSessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-directory": request.workspace_dir },
      body: JSON.stringify({ prompt: promptPayload }),
      signal: abortController.signal,
    });
    if (!promptRes.ok && promptRes.status !== 204) {
      throw new Error(`Failed to send prompt: ${promptRes.status}`);
    }

    resetIdleTimer();

    await consumeGlobalSSE(
      serverUrl,
      request.workspace_dir,
      request.session_id,
      request.input_id,
      abortController.signal,
      (event) => emitRunnerEvent(event),
      () => resetIdleTimer(),
      () => { terminalEmitted = true; },
    );

    if (!terminalEmitted) {
      const status = abortController.signal.aborted ? "timeout" : "success";
      emitRunnerEvent({
        session_id: request.session_id,
        input_id: request.input_id,
        sequence: nextSequence(),
        event_type: status === "timeout" ? ("run_failed" as RunnerEventType) : ("run_completed" as RunnerEventType),
        payload: {
          status: status === "timeout" ? undefined : "success",
          source: "opencode",
          type: status === "timeout" ? "TimeoutError" : undefined,
          message: status === "timeout" ? `Run timed out after ${request.timeout_seconds}s` : undefined,
          duration_ms: Date.now() - startTime,
        },
      });
    }

    return terminalEmitted && !abortController.signal.aborted ? 0 : 1;
  } catch (error) {
    if (!terminalEmitted) {
      emitRunnerEvent({
        session_id: request.session_id,
        input_id: request.input_id,
        sequence: nextSequence(),
        event_type: "run_failed" as RunnerEventType,
        payload: {
          type: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          source: "opencode",
          duration_ms: Date.now() - startTime,
        },
      });
    }
    return 1;
  } finally {
    cleanup();
  }
}

export async function compactOpencodeSession(request: HarnessHostOpencodeRequest): Promise<{ compacted: boolean }> {
  const config = buildOpencodeConfig(request);
  const opencodeBin =
    process.env.HOLABOSS_OPENCODE_BIN ??
    (process.env.HOME ? `${process.env.HOME}/.opencode/bin/opencode` : "opencode");

  const proc = spawn(opencodeBin, ["serve", "--port=0"], {
    cwd: request.workspace_dir,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const serverUrl = await waitForServerReady(proc);

    const ocSessionId = request.harness_session_id;
    if (!ocSessionId) return { compacted: false };

    const res = await fetch(`${serverUrl}/session/${ocSessionId}/compact`, {
      method: "POST",
      headers: { "x-opencode-directory": request.workspace_dir },
    });

    return { compacted: res.ok || res.status === 204 };
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}
