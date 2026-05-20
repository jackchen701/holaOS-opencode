import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

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
    case "message.part.updated": {
      const part = properties.part as Record<string, unknown> | undefined;
      const delta = properties.delta as string | undefined;
      const partType = (part as Record<string, unknown>)?.type;
      if (partType === "tool-invocation") {
        const toolInv = (part as Record<string, unknown>)?.toolInvocation as Record<string, unknown> | undefined;
        const state = toolInv?.state as string | undefined;
        const toolName = toolInv?.toolName as string ?? "unknown";
        const callId = toolInv?.callId as string ?? "";
        if (state === "call") {
          return { ...base, event_type: "tool_call" as RunnerEventType, payload: { phase: "started", tool_name: toolName, call_id: callId, tool_args: toolInv?.args ?? {} } };
        }
        if (state === "result") {
          return { ...base, event_type: "tool_call" as RunnerEventType, payload: { phase: "completed", call_id: callId, error: false, result: toolInv?.result ?? {} } };
        }
        return { ...base, event_type: "tool_call" as RunnerEventType, payload: { phase: "in_progress", call_id: callId, progress: toolInv ?? {} } };
      }
      if (typeof delta === "string" && delta) {
        return { ...base, event_type: "output_delta", payload: { delta } };
      }
      if (typeof part?.text === "string") {
        return { ...base, event_type: "output_delta", payload: { delta: part.text as string } };
      }
      return null;
    }
    case "message.updated": {
      const info = properties.info as Record<string, unknown> | undefined;
      if (info?.finish) {
        const tokens = info.tokens as Record<string, unknown> | undefined;
        const cost = info.cost as number | undefined;
        const usage: Record<string, unknown> = {};
        if (tokens) {
          usage.input_tokens = tokens.input ?? 0;
          usage.output_tokens = tokens.output ?? 0;
          usage.total_tokens = (typeof tokens.input === "number" ? tokens.input : 0) + (typeof tokens.output === "number" ? tokens.output : 0);
        }
        if (typeof cost === "number") usage.estimated_cost_usd = cost;
        return { ...base, event_type: "run_completed" as RunnerEventType, payload: { status: "success", source: "opencode", ...(Object.keys(usage).length > 0 ? { usage } : {}) } };
      }
      return null;
    }
    case "session.idle":
      return { ...base, event_type: "run_completed" as RunnerEventType, payload: { status: "success", source: "opencode" } };
    case "session.error":
      return { ...base, event_type: "run_failed" as RunnerEventType, payload: { type: "Error", message: (properties.error as Record<string, unknown>)?.message ?? "session error", source: "opencode" } };
    case "session.status": {
      const status = properties.status as Record<string, unknown> | undefined;
      if (status?.type === "error") {
        return { ...base, event_type: "run_failed" as RunnerEventType, payload: { type: "Error", message: status.message ?? "session status error", source: "opencode" } };
      }
      return null;
    }
    case "session.next.text.delta":
      return { ...base, event_type: "output_delta", payload: { delta: properties.delta ?? "" } };
    case "session.next.reasoning.delta":
      return { ...base, event_type: "thinking_delta", payload: { delta: properties.delta ?? "" } };
    case "session.next.tool.called":
      return { ...base, event_type: "tool_call" as RunnerEventType, payload: { phase: "started", tool_name: properties.tool ?? "unknown", call_id: properties.callID ?? "", tool_args: properties.input ?? {} } };
    case "session.next.tool.success":
      return { ...base, event_type: "tool_call" as RunnerEventType, payload: { phase: "completed", call_id: properties.callID ?? "", error: false, result: properties.content ?? properties.structured ?? {} } };
    case "session.next.tool.failed":
      return { ...base, event_type: "tool_call" as RunnerEventType, payload: { phase: "completed", call_id: properties.callID ?? "", error: true, result: properties.error ?? { message: "tool failed" } } };
    case "session.next.step.ended": {
      const tokens = properties.tokens as Record<string, unknown> | undefined;
      const cost = properties.cost as number | undefined;
      const usage: Record<string, unknown> = {};
      if (tokens) { usage.input_tokens = tokens.input ?? 0; usage.output_tokens = tokens.output ?? 0; usage.total_tokens = (typeof tokens.input === "number" ? tokens.input : 0) + (typeof tokens.output === "number" ? tokens.output : 0); }
      if (typeof cost === "number") usage.estimated_cost_usd = cost;
      return { ...base, event_type: "run_completed" as RunnerEventType, payload: { status: "success", source: "opencode", ...(Object.keys(usage).length > 0 ? { usage } : {}) } };
    }
    case "session.next.step.failed":
      return { ...base, event_type: "run_failed" as RunnerEventType, payload: { type: "Error", message: (properties.error as Record<string, unknown>)?.message ?? "step failed", source: "opencode" } };
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
        `supported values: openai_compatible (openai, deepseek, zhipu/glm, codingplan, openrouter, etc.), ` +
        `anthropic_native (anthropic, claude), google_compatible (google, gemini). ` +
        `this value is resolved by holaOS agent-runtime-config.ts from your provider kind in runtime-config.json.`,
      );
  }
}

function npmPackageForProvider(providerType: string): string {
  switch (providerType) {
    case "openai":
      return "@ai-sdk/openai-compatible";
    case "anthropic":
      return "@ai-sdk/anthropic";
    case "google":
      return "@ai-sdk/google";
    default:
      return "@ai-sdk/openai-compatible";
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

  const mcpServers: Record<string, unknown> = {};
  const runtimeApiUrl = request.runtime_api_base_url;
  if (runtimeApiUrl) {
    mcpServers["holaboss-runtime"] = {
      type: "local",
      command: [process.execPath, import.meta.url.replace(/\/src\/opencode\.ts$/, "/opencode-runtime-mcp-server.mjs")],
      environment: {
        HOLABOSS_RUNTIME_API_URL: runtimeApiUrl,
        HOLABOSS_WORKSPACE_DIR: request.workspace_dir,
        HOLABOSS_SESSION_ID: request.session_id,
        HOLABOSS_INPUT_ID: request.input_id,
      },
      enabled: true,
    };
  }
  for (const server of request.mcp_servers ?? []) {
    const name = server.name as string;
    if (name && typeof name === "string") {
      mcpServers[name] = server.config ?? {};
    }
  }
  const result: Record<string, unknown> = {
    model: `holaboss-proxy/${request.model_id}`,
    provider: {
      "holaboss-proxy": {
        name: "holaOS Proxy",
        npm: npmPackageForProvider(providerType),
        options: {
          apiKey: modelClient.api_key,
          baseURL: modelClient.base_url,
          ...(modelClient.default_headers && Object.keys(modelClient.default_headers).length > 0
            ? { headers: modelClient.default_headers }
            : {}),
        },
        models: {
          [request.model_id]: { name: request.model_id },
        },
      },
    },
  };
  if (Object.keys(mcpServers).length > 0) {
    result.mcp = mcpServers;
  }
  return result;
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

function runtimeContextMessagesBlock(request: HarnessHostOpencodeRequest): string {
  const messages = Array.isArray(request.context_messages)
    ? request.context_messages.map((message) => message.trim()).filter(Boolean)
    : [];
  if (messages.length === 0) {
    return "";
  }
  return [
    "Runtime context:",
    ...messages.map((message, index) =>
      [`[Runtime Context ${index + 1}]`, message, `[/Runtime Context ${index + 1}]`].join("\n")
    ),
  ].join("\n\n");
}

function injectContextMessages(request: HarnessHostOpencodeRequest): string {
  const contextBlock = runtimeContextMessagesBlock(request);
  if (!contextBlock) return request.instruction;
  return `${contextBlock}\n\n${request.instruction}`;
}

function symlinkWorkspaceSkills(request: HarnessHostOpencodeRequest): string[] {
  const skillsDir = path.join(request.workspace_dir, ".opencode", "skills");
  const createdLinks: string[] = [];

  const skillDirs = request.workspace_skill_dirs ?? [];
  if (skillDirs.length === 0) return createdLinks;

  fs.mkdirSync(skillsDir, { recursive: true });

  for (const dir of skillDirs) {
    const name = path.basename(dir);
    const link = path.join(skillsDir, name);
    try {
      if (!fs.existsSync(link)) {
        fs.symlinkSync(dir, link);
        createdLinks.push(link);
      }
    } catch {
      // symlink creation is best-effort; skip on failure
    }
  }

  return createdLinks;
}

function cleanupSkillSymlinks(links: string[]): void {
  for (const link of links) {
    try {
      const stat = fs.lstatSync(link);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(link);
      }
    } catch {
      // best-effort cleanup
    }
  }
}

function buildInstructionWithAttachments(request: HarnessHostOpencodeRequest, instruction: string): string {
  const sections: string[] = [];

  const attachments = request.attachments ?? [];
  const imageUrls = request.image_urls ?? [];

  if (attachments.length > 0) {
    const attachmentLines = attachments.map((a) => {
      const relativePath = a.workspace_path
        ? `./${a.workspace_path}`
        : a.name;
      return `- ${a.name} (${a.kind}, ${a.mime_type}) at ${relativePath}`;
    });
    sections.push(["Attachments:", ...attachmentLines].join("\n"));
  }

  if (imageUrls.length > 0) {
    const urlLines = imageUrls.map((url, i) => `- [Image URL ${i + 1}] ${url}`);
    sections.push(["Image URLs:", ...urlLines].join("\n"));
  }

  if (sections.length === 0) return instruction;
  return `${sections.join("\n\n")}\n\n${instruction}`;
}

export async function runOpencode(request: HarnessHostOpencodeRequest): Promise<number> {
  const startTime = Date.now();
  let sequence = 0;
  const nextSequence = () => ++sequence;
  let terminalEmitted = false;
  let proc: ChildProcess | null = null;
  const abortController = new AbortController();
  let skillLinks: string[] = [];

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
    cleanupSkillSymlinks(skillLinks);
    skillLinks = [];
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
    skillLinks = symlinkWorkspaceSkills(request);

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
      const body = await createRes.text().catch(() => "");
      throw new Error(`Failed to create opencode session: ${createRes.status} ${body.slice(0, 500)}`);
    }
    const session = (await createRes.json()) as { id: string };
    const ocSessionId = session.id;

    const instructionWithContext = injectContextMessages(request);
    const fullInstruction = buildInstructionWithAttachments(request, instructionWithContext);

    const promptPayload: Record<string, unknown> = {
      parts: [{ type: "text", text: fullInstruction }],
      model: { providerID: "holaboss-proxy", modelID: request.model_id },
    };

    if (request.system_prompt) {
      promptPayload.system = request.system_prompt;
    }

    resetIdleTimer();

    const ssePromise = consumeGlobalSSE(
      serverUrl,
      request.workspace_dir,
      request.session_id,
      request.input_id,
      abortController.signal,
      (event) => emitRunnerEvent(event),
      () => resetIdleTimer(),
      () => { terminalEmitted = true; },
    );

    const promptRes = await fetch(`${serverUrl}/session/${ocSessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-directory": request.workspace_dir },
      body: JSON.stringify(promptPayload),
      signal: abortController.signal,
    });
    if (!promptRes.ok && promptRes.status !== 204) {
      const promptBody = await promptRes.text().catch(() => "");
      throw new Error(`Failed to send prompt: ${promptRes.status} ${promptBody.slice(0, 500)}`);
    }

    await ssePromise;

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
