import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeServerMock } from "./test-util/opencode-server-mock.js";
import { mapEventV2ToRunnerEvent } from "./opencode.js";

const WORKSPACE_DIR = `/tmp/hb-compaction-test-${Date.now()}`;

const SESSION_ID = "sess-compaction-1";
const INPUT_ID = "in-compaction-1";

function makeEventV2(type: string, properties: Record<string, unknown>, directory = WORKSPACE_DIR): string {
  return JSON.stringify({
    directory,
    payload: { id: `evt-${Date.now()}`, type, properties: { sessionID: SESSION_ID, ...properties } },
  });
}

test("compaction.started maps to auto_compaction_start", () => {
  const result = mapEventV2ToRunnerEvent("session.next.compaction.started", { sessionID: SESSION_ID, reason: "overflow" }, SESSION_ID, INPUT_ID, 1);
  assert.ok(result);
  assert.equal(result!.event_type, "auto_compaction_start");
  assert.equal(result!.payload.source, "opencode");
});

test("compaction.ended maps to auto_compaction_end", () => {
  const result = mapEventV2ToRunnerEvent("session.next.compaction.ended", { sessionID: SESSION_ID, text: "Compacted" }, SESSION_ID, INPUT_ID, 2);
  assert.ok(result);
  assert.equal(result!.event_type, "auto_compaction_end");
});

test("compaction.delta maps to auto_compaction_delta", () => {
  const result = mapEventV2ToRunnerEvent("session.next.compaction.delta", { sessionID: SESSION_ID, delta: "Summarizing..." }, SESSION_ID, INPUT_ID, 3);
  assert.ok(result);
  assert.equal(result!.event_type, "auto_compaction_delta");
});

test("compaction events via mock SSE followed by step.ended", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();

  const res = await fetch(`${url}/session`, { method: "POST" });
  const session = await res.json() as any;

  mock.enqueueScenario(session.id, {
    events: [
      { data: makeEventV2("session.next.compaction.started", { reason: "overflow" }), delayMs: 10 },
      { data: makeEventV2("session.next.compaction.delta", { delta: "Summarizing..." }), delayMs: 10 },
      { data: makeEventV2("session.next.compaction.ended", { text: "Compacted" }), delayMs: 10 },
      { data: makeEventV2("session.next.text.delta", { delta: "Final answer" }), delayMs: 10 },
      { data: makeEventV2("session.next.step.ended", { tokens: { input: 100, output: 50 }, cost: 0.01 }), delayMs: 10 },
    ],
  });

  await fetch(`${url}/session/${session.id}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "test" }),
  });

  const sseResponse = await fetch(`${url}/global/event`);
  const reader = sseResponse.body!.getReader();
  const types: string[] = [];

  const timeout = setTimeout(() => reader.cancel(), 3000);
  try {
    let buffer = "";
    while (types.length < 7) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      for (const chunk of buffer.split("\n\n")) {
        if (!chunk.trim()) continue;
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed?.payload?.type) types.push(parsed.payload.type);
          } catch {}
        }
      }
      buffer = "";
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => {});
  }

  assert.ok(types.includes("session.next.compaction.started"));
  assert.ok(types.includes("session.next.compaction.ended"));
  assert.ok(types.includes("session.next.step.ended"));

  await mock.stop();
});

test("compact endpoint triggers compaction events via SSE", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();

  const res = await fetch(`${url}/session`, { method: "POST" });
  const session = await res.json() as any;

  const sseResponse = await fetch(`${url}/global/event`);
  const reader = sseResponse.body!.getReader();
  const types: string[] = [];

  await fetch(`${url}/session/${session.id}/compact`, { method: "POST" });

  const timeout = setTimeout(() => reader.cancel(), 1500);
  try {
    let buffer = "";
    while (types.length < 3) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      for (const chunk of buffer.split("\n\n")) {
        if (!chunk.trim()) continue;
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed?.payload?.type) types.push(parsed.payload.type);
          } catch {}
        }
      }
      buffer = "";
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => {});
  }

  assert.ok(types.includes("session.next.compaction.started"));
  assert.ok(types.includes("session.next.compaction.ended"));

  await mock.stop();
});

test("session.next.step.failed maps to run_failed", () => {
  const result = mapEventV2ToRunnerEvent(
    "session.next.step.failed",
    { error: { message: "provider context overflow" } },
    SESSION_ID, INPUT_ID, 1,
  );
  assert.ok(result);
  assert.equal(result!.event_type, "run_failed");
  assert.equal((result!.payload as any).message, "provider context overflow");
});

test("session.next.retried is ignored (returns null)", () => {
  const result = mapEventV2ToRunnerEvent(
    "session.next.retried",
    { attempt: 1, reason: "rate_limited" },
    SESSION_ID, INPUT_ID, 1,
  );
  assert.equal(result, null);
});

test("session.error maps to run_failed", () => {
  const result = mapEventV2ToRunnerEvent(
    "session.error",
    { error: { message: "persistent context overflow" } },
    SESSION_ID, INPUT_ID, 1,
  );
  assert.ok(result);
  assert.equal(result!.event_type, "run_failed");
  assert.equal((result!.payload as any).message, "persistent context overflow");
});

test("message.updated with finish maps to run_completed with usage", () => {
  const result = mapEventV2ToRunnerEvent(
    "message.updated",
    { info: { finish: "stop", tokens: { input: 200, output: 100 }, cost: 0.02 } },
    SESSION_ID, INPUT_ID, 5,
  );
  assert.ok(result);
  assert.equal(result!.event_type, "run_completed");
  const usage = (result!.payload as any).usage;
  assert.equal(usage.input_tokens, 200);
  assert.equal(usage.output_tokens, 100);
  assert.equal(usage.estimated_cost_usd, 0.02);
});

test("compaction events interleaved with tool calls preserve ordering", () => {
  const results: string[] = [];

  const toolCall = mapEventV2ToRunnerEvent(
    "session.next.tool.called",
    { tool: "bash", callID: "call-1", input: { command: "ls" } },
    SESSION_ID, INPUT_ID, 1,
  );
  if (toolCall) results.push(toolCall.event_type);

  const compactStart = mapEventV2ToRunnerEvent(
    "session.next.compaction.started",
    { reason: "overflow" },
    SESSION_ID, INPUT_ID, 2,
  );
  if (compactStart) results.push(compactStart.event_type);

  const compactEnd = mapEventV2ToRunnerEvent(
    "session.next.compaction.ended",
    { text: "Done" },
    SESSION_ID, INPUT_ID, 3,
  );
  if (compactEnd) results.push(compactEnd.event_type);

  const stepEnded = mapEventV2ToRunnerEvent(
    "session.next.step.ended",
    { tokens: { input: 50, output: 25 } },
    SESSION_ID, INPUT_ID, 4,
  );
  if (stepEnded) results.push(stepEnded.event_type);

  assert.deepEqual(results, ["tool_call", "auto_compaction_start", "auto_compaction_end", "run_completed"]);
});

test("session.status error type maps to run_failed", () => {
  const result = mapEventV2ToRunnerEvent(
    "session.status",
    { status: { type: "error", message: "session corrupted" } },
    SESSION_ID, INPUT_ID, 1,
  );
  assert.ok(result);
  assert.equal(result!.event_type, "run_failed");
  assert.equal((result!.payload as any).message, "session corrupted");
});
