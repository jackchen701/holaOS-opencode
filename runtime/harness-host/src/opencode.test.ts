import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeServerMock } from "./test-util/opencode-server-mock.js";
import { parseGlobalSSEData, parseSSEStream, type GlobalSSEEvent } from "./test-util/opencode-sse-parser.js";
import { decodeHarnessHostOpencodeRequestBase64 } from "./opencode-contracts.js";

const WORKSPACE_DIR = `/tmp/hb-opencode-test-${Date.now()}`;

function makeEventV2(type: string, properties: Record<string, unknown>, directory = WORKSPACE_DIR): string {
  return JSON.stringify({
    directory,
    payload: { id: `evt-${Date.now()}`, type, properties: { sessionID: "session-1", ...properties } },
  });
}

test("decodeHarnessHostOpencodeRequestBase64 decodes valid request", () => {
  const payload = {
    workspace_id: "ws-1",
    workspace_dir: "/tmp/ws",
    session_id: "sess-1",
    input_id: "in-1",
    instruction: "hello",
    debug: false,
    provider_id: "openai",
    model_id: "gpt-4",
    timeout_seconds: 60,
    system_prompt: "test",
    workspace_skill_dirs: [],
    mcp_servers: [],
    mcp_tool_refs: [],
    workspace_config_checksum: "chk",
    run_started_payload: {},
    model_client: { model_proxy_provider: "openai", api_key: "key" },
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const decoded = decodeHarnessHostOpencodeRequestBase64(encoded);
  assert.equal(decoded.workspace_id, "ws-1");
  assert.equal(decoded.session_id, "sess-1");
  assert.equal(decoded.instruction, "hello");
});

test("decodeHarnessHostOpencodeRequestBase64 rejects invalid payload", () => {
  assert.throws(() => decodeHarnessHostOpencodeRequestBase64(Buffer.from("{}").toString("base64")), /missing workspace_id/);
  assert.throws(() => decodeHarnessHostOpencodeRequestBase64(Buffer.from("null").toString("base64")), /invalid/);
});

test("parseSSEStream splits raw SSE into events", () => {
  const raw = "event: message\ndata: {\"ok\":true}\n\ndata: {\"ok\":false}\n\n";
  const events = parseSSEStream(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.event, "message");
  assert.equal(events[0]!.data, '{"ok":true}');
  assert.equal(events[1]!.data, '{"ok":false}');
});

test("parseGlobalSSEData extracts typed events", () => {
  const data = makeEventV2("session.next.text.delta", { delta: "hello" });
  const parsed = parseGlobalSSEData(data);
  assert.ok(parsed);
  assert.equal(parsed!.directory, WORKSPACE_DIR);
  assert.equal(parsed!.payload.type, "session.next.text.delta");
  assert.equal((parsed!.payload.properties as any).delta, "hello");
});

test("parseGlobalSSEData returns null for invalid data", () => {
  assert.equal(parseGlobalSSEData("not json"), null);
  assert.equal(parseGlobalSSEData("{}"), null);
});

test("OpenCodeServerMock starts, creates session, and stops", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();
  assert.ok(url.startsWith("http://"));

  const res = await fetch(`${url}/session`, { method: "POST" });
  const session = await res.json() as any;
  assert.ok(session.id);
  assert.equal(typeof session.id, "string");

  await mock.stop();
});

test("OpenCodeServerMock health endpoint returns healthy", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();

  const res = await fetch(`${url}/global/health`);
  const body = await res.json() as any;
  assert.equal(body.healthy, true);

  await mock.stop();
});

test("OpenCodeServerMock emits scenario events via SSE", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();

  const res = await fetch(`${url}/session`, { method: "POST" });
  const session = await res.json() as any;
  const sessionId = session.id;

  mock.enqueueScenario(sessionId, {
    events: [
      { data: makeEventV2("session.next.prompted", {}), delayMs: 10 },
      { data: makeEventV2("session.next.text.delta", { delta: "Hello" }), delayMs: 10 },
      { data: makeEventV2("session.next.text.delta", { delta: " world" }), delayMs: 10 },
      { data: makeEventV2("session.next.text.ended", { text: "Hello world" }), delayMs: 10 },
      {
        data: makeEventV2("session.next.step.ended", {
          finish: "stop",
          cost: 0.01,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        delayMs: 10,
      },
    ],
  });

  const sseResponse = await fetch(`${url}/global/event`);
  const reader = sseResponse.body!.getReader();
  const collected: GlobalSSEEvent[] = [];

  const promptRes = await fetch(`${url}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "Say hello" }),
  });
  assert.equal(promptRes.status, 204);

  const readTimeout = setTimeout(() => reader.cancel(), 2000);
  try {
    let buffer = "";
    while (collected.length < 6) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const events = parseSSEStream(buffer);
      for (const event of events) {
        const parsed = parseGlobalSSEData(event.data);
        if (parsed) collected.push(parsed);
      }
      if (events.length > 0) {
        buffer = "";
      }
    }
  } finally {
    clearTimeout(readTimeout);
    await reader.cancel().catch(() => {});
  }

  const types = collected.map((e) => e.payload.type);
  assert.ok(types.includes("server.connected"), `should include connected, got: ${types.join(", ")}`);
  assert.ok(types.includes("session.next.prompted"), `should include prompted`);
  assert.ok(types.includes("session.next.text.delta"), `should include text delta`);
  assert.ok(types.includes("session.next.step.ended"), `should include step ended`);

  await mock.stop();
});

test("OpenCodeServerMock filters events by directory", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();

  const res = await fetch(`${url}/session`, { method: "POST" });
  const session = await res.json() as any;

  const otherDirEvent = JSON.stringify({
    directory: "/other/workspace",
    payload: { id: "other-1", type: "session.next.text.delta", properties: { delta: "other" } },
  });

  const matchingEvent = makeEventV2("session.next.text.delta", { delta: "matching" });

  mock.enqueueScenario(session.id, {
    events: [
      { data: otherDirEvent, delayMs: 10 },
      { data: matchingEvent, delayMs: 10 },
    ],
  });

  const sseResponse = await fetch(`${url}/global/event`);
  const reader = sseResponse.body!.getReader();
  const collected: GlobalSSEEvent[] = [];

  await fetch(`${url}/session/${session.id}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "test" }),
  });

  const readTimeout = setTimeout(() => reader.cancel(), 1500);
  try {
    let buffer = "";
    while (collected.length < 4) {
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

  const matchingEvents = collected.filter((e) => e.directory === WORKSPACE_DIR);
  const otherEvents = collected.filter((e) => e.directory !== WORKSPACE_DIR);
  assert.ok(otherEvents.length > 0, "should receive events from other directories");
  assert.ok(matchingEvents.length > 0, "should receive matching directory events");

  const matchingDeltas = matchingEvents.filter((e) => e.payload.type === "session.next.text.delta");
  assert.equal(matchingDeltas.length, 1);
  assert.equal((matchingDeltas[0]!.payload.properties as any).delta, "matching");

  await mock.stop();
});

test("OpenCodeServerMock abort sets session idle", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();

  const res = await fetch(`${url}/session`, { method: "POST" });
  const session = await res.json() as any;

  const abortRes = await fetch(`${url}/session/${session.id}/abort`, { method: "POST" });
  const abortBody = await abortRes.json();
  assert.equal(abortBody, true);

  await mock.stop();
});

test("OpenCodeServerMock compact endpoint emits compaction events", async () => {
  const mock = new OpenCodeServerMock(WORKSPACE_DIR);
  const url = await mock.start();

  const res = await fetch(`${url}/session`, { method: "POST" });
  const session = await res.json() as any;

  const sseResponse = await fetch(`${url}/global/event`);
  const reader = sseResponse.body!.getReader();
  const collected: GlobalSSEEvent[] = [];

  await fetch(`${url}/session/${session.id}/compact`, { method: "POST" });

  const readTimeout = setTimeout(() => reader.cancel(), 1000);
  try {
    let buffer = "";
    while (collected.length < 3) {
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

  const types = collected.map((e) => e.payload.type);
  assert.ok(types.includes("session.next.compaction.started"), `should include compaction started`);
  assert.ok(types.includes("session.next.compaction.ended"), `should include compaction ended`);

  await mock.stop();
});
