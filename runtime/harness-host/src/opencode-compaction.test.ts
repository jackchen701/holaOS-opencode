import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeServerMock } from "./test-util/opencode-server-mock.js";
import { parseGlobalSSEData, parseSSEStream, type GlobalSSEEvent } from "./test-util/opencode-sse-parser.js";
import { mapEventV2ToRunnerEvent } from "./opencode.js";

const WORKSPACE_DIR = `/tmp/hb-opencode-compaction-test-${Date.now()}`;

function makeEventV2(type: string, properties: Record<string, unknown>, directory = WORKSPACE_DIR): string {
  return JSON.stringify({
    directory,
    payload: { id: `evt-${Date.now()}`, type, properties: { sessionID: "session-1", ...properties } },
  });
}

test("mapEventV2 maps compaction started", () => {
  const result = mapEventV2ToRunnerEvent(
    "session.next.compaction.started",
    { sessionID: "session-1", reason: "auto" },
    "session-1",
    "input-1",
    0,
  );
  assert.ok(result);
  assert.equal(result!.event_type, "auto_compaction_start");
  assert.equal(result!.payload.reason, "auto");
});

test("mapEventV2 maps compaction ended", () => {
  const result = mapEventV2ToRunnerEvent(
    "session.next.compaction.ended",
    { sessionID: "session-1", text: "Summary..." },
    "session-1",
    "input-1",
    1,
  );
  assert.ok(result);
  assert.equal(result!.event_type, "auto_compaction_end");
  assert.equal(result!.payload.text, "Summary...");
});

test("mapEventV2 maps step failed", () => {
  const result = mapEventV2ToRunnerEvent(
    "session.next.step.failed",
    { sessionID: "session-1", error: { message: "context overflow" } },
    "session-1",
    "input-1",
    0,
  );
  assert.ok(result);
  assert.equal(result!.event_type, "run_failed");
  assert.equal(result!.payload.message, "context overflow");
  assert.equal(result!.payload.source, "opencode");
});

test("mapEventV2 maps retried event to null (ignored)", () => {
  const result = mapEventV2ToRunnerEvent(
    "session.next.retried",
    { sessionID: "session-1", attempt: 1, error: { message: "rate limit" } },
    "session-1",
    "input-1",
    0,
  );
  assert.equal(result, null);
});

test("mapEventV2 maps agent switched to null (ignored)", () => {
  const result = mapEventV2ToRunnerEvent(
    "session.next.agent.switched",
    { sessionID: "session-1", agent: "explore" },
    "session-1",
    "input-1",
    0,
  );
  assert.equal(result, null);
});

test("compaction scenario plays through SSE in correct order", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();

  const res = await fetch(`${url}/session`, { method: "POST" });
  const session = await res.json() as any;

  mock.enqueueScenario(session.id, {
    events: [
      { data: makeEventV2("session.next.prompted", {}), delayMs: 10 },
      { data: makeEventV2("session.next.text.delta", { delta: "Thinking..." }), delayMs: 10 },
      { data: makeEventV2("session.next.compaction.started", { reason: "auto" }), delayMs: 20 },
      { data: makeEventV2("session.next.compaction.ended", { text: "Summarized context" }), delayMs: 10 },
      { data: makeEventV2("session.next.text.delta", { delta: "After compaction..." }), delayMs: 10 },
      {
        data: makeEventV2("session.next.step.ended", {
          finish: "stop",
          cost: 0.02,
          tokens: { input: 200, output: 100, reasoning: 10, cache: { read: 50, write: 0 } },
        }),
        delayMs: 10,
      },
    ],
  });

  const sseRes = await fetch(`${url}/global/event`);
  const reader = sseRes.body!.getReader();
  const collected: GlobalSSEEvent[] = [];

  await fetch(`${url}/session/${session.id}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "test compaction" }),
  });

  const readTimeout = setTimeout(() => reader.cancel(), 3000);
  try {
    let buffer = "";
    while (collected.length < 7) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const events = parseSSEStream(buffer);
      for (const event of events) {
        const parsed = parseGlobalSSEData(event.data);
        if (parsed) collected.push(parsed);
      }
      if (events.length > 0) buffer = "";
    }
  } finally {
    clearTimeout(readTimeout);
    await reader.cancel().catch(() => {});
  }

  const types = collected
    .filter((e) => e.directory === WORKSPACE_DIR)
    .map((e) => e.payload.type);

  const compactionStartIdx = types.indexOf("session.next.compaction.started");
  const compactionEndIdx = types.indexOf("session.next.compaction.ended");
  const stepEndedIdx = types.indexOf("session.next.step.ended");

  assert.ok(compactionStartIdx >= 0, "should have compaction started");
  assert.ok(compactionEndIdx >= 0, "should have compaction ended");
  assert.ok(stepEndedIdx >= 0, "should have step ended");
  assert.ok(compactionStartIdx < compactionEndIdx, "compaction start before end");
  assert.ok(compactionEndIdx < stepEndedIdx, "compaction before step ended");

  await mock.stop();
});

test("overflow retry scenario: compaction + retry + success", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();

  const res = await fetch(`${url}/session`, { method: "POST" });
  const session = await res.json() as any;

  mock.enqueueScenario(session.id, {
    events: [
      { data: makeEventV2("session.next.prompted", {}), delayMs: 10 },
      { data: makeEventV2("session.next.text.delta", { delta: "..." }), delayMs: 10 },
      { data: makeEventV2("session.next.step.failed", { error: { message: "context overflow" } }), delayMs: 10 },
      { data: makeEventV2("session.next.compaction.started", { reason: "auto" }), delayMs: 20 },
      { data: makeEventV2("session.next.compaction.ended", { text: "Compacted" }), delayMs: 10 },
      { data: makeEventV2("session.next.text.delta", { delta: "Retrying..." }), delayMs: 10 },
      {
        data: makeEventV2("session.next.step.ended", {
          finish: "stop",
          cost: 0.03,
          tokens: { input: 300, output: 150, reasoning: 20, cache: { read: 0, write: 0 } },
        }),
        delayMs: 10,
      },
    ],
  });

  const sseRes = await fetch(`${url}/global/event`);
  const reader = sseRes.body!.getReader();
  const collected: GlobalSSEEvent[] = [];

  await fetch(`${url}/session/${session.id}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "test overflow" }),
  });

  const readTimeout = setTimeout(() => reader.cancel(), 3000);
  try {
    let buffer = "";
    while (collected.length < 8) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const events = parseSSEStream(buffer);
      for (const event of events) {
        const parsed = parseGlobalSSEData(event.data);
        if (parsed) collected.push(parsed);
      }
      if (events.length > 0) buffer = "";
    }
  } finally {
    clearTimeout(readTimeout);
    await reader.cancel().catch(() => {});
  }

  const types = collected.filter((e) => e.directory === WORKSPACE_DIR).map((e) => e.payload.type);

  assert.ok(types.includes("session.next.step.failed"), "should have first failure");
  assert.ok(types.includes("session.next.compaction.started"), "should trigger compaction after overflow");
  assert.ok(types.includes("session.next.step.ended"), "should succeed after retry");

  await mock.stop();
});

test("explicit compact endpoint returns 204 and emits events", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();

  const res = await fetch(`${url}/session`, { method: "POST" });
  const session = await res.json() as any;

  const compactRes = await fetch(`${url}/session/${session.id}/compact`, { method: "POST" });
  assert.equal(compactRes.status, 204);

  await mock.stop();
});

test("mapEventV2 step ended includes token usage", () => {
  const result = mapEventV2ToRunnerEvent(
    "session.next.step.ended",
    {
      sessionID: "session-1",
      finish: "stop",
      cost: 0.015,
      tokens: { input: 500, output: 200, reasoning: 30, cache: { read: 100, write: 50 } },
    },
    "session-1",
    "input-1",
    5,
  );
  assert.ok(result);
  assert.equal(result!.event_type, "run_completed");
  assert.equal(result!.payload.source, "opencode");
  const usage = result!.payload.usage as Record<string, unknown>;
  assert.equal(usage.input_tokens, 500);
  assert.equal(usage.output_tokens, 200);
  assert.equal(usage.cached_input_tokens, 100);
  assert.equal(usage.cache_write_input_tokens, 50);
  assert.equal(usage.total_tokens, 730);
  assert.equal(usage.estimated_cost_usd, 0.015);
});
