import assert from "node:assert/strict";
import test from "node:test";

import { opencodeHarnessDefinition } from "./opencode.js";

test("opencode harness definition has correct id and hostCommand", () => {
  assert.equal(opencodeHarnessDefinition.id, "opencode");
  assert.equal(opencodeHarnessDefinition.hostCommand, "run-opencode");
});

test("opencode harness capabilities match expected values", () => {
  assert.deepEqual(opencodeHarnessDefinition.runtimeAdapter.capabilities, {
    requiresBackend: false,
    supportsStructuredOutput: false,
    supportsWaitingUser: true,
    supportsSkills: true,
    supportsMcpTools: true,
  });
});

test("opencode harness prep plan matches expected values", () => {
  const prepPlan = opencodeHarnessDefinition.runtimeAdapter.buildRunnerPrepPlan({
    request: {
      workspace_id: "workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "test",
      debug: false,
    },
    bootstrap: {
      workspaceRoot: "/tmp",
      workspaceDir: "/tmp/workspace-1",
      requestedHarnessSessionId: null,
      persistedHarnessSessionId: null,
    },
  });
  assert.deepEqual(prepPlan, {
    stageWorkspaceSkills: false,
    stageWorkspaceCommands: false,
    prepareMcpTooling: true,
    startWorkspaceMcpSidecar: true,
    bootstrapResolvedApplications: true,
  });
});

test("opencode harness buildHarnessHostRequest produces correct shape", () => {
  const request = opencodeHarnessDefinition.runtimeAdapter.buildHarnessHostRequest({
    request: {
      workspace_id: "workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "Inspect the project",
      debug: false,
    },
    bootstrap: {
      workspaceRoot: "/tmp",
      workspaceDir: "/tmp/workspace-1",
      requestedHarnessSessionId: "requested-session-1",
      persistedHarnessSessionId: "persisted-session-1",
    },
    runtimeConfig: {
      provider_id: "openai",
      model_id: "gpt-5.4",
      mode: "code",
      system_prompt: "You are concise.",
      workspace_config_checksum: "checksum-1",
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token",
        base_url: "http://127.0.0.1:4000/openai/v1",
        default_headers: { "X-Test": "1" },
      },
      tools: { read: true, bash: true },
      workspace_tool_ids: [],
      workspace_skill_ids: [],
    },
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceSkills: [
      { skill_id: "skill-1", source_dir: "/tmp/workspace-1/skills/skill-1" },
    ],
    mcpServers: [
      {
        name: "workspace",
        config: {
          type: "remote" as const,
          enabled: true,
          url: "http://127.0.0.1:5000/mcp",
          headers: {},
          timeout: 30000,
        },
      },
    ],
    mcpToolRefs: [{ tool_id: "workspace.lookup", server_id: "workspace", tool_name: "lookup" }],
    runStartedPayload: { phase: "booting" },
    backendBaseUrl: "",
    timeoutSeconds: 60,
  });

  assert.equal(request.system_prompt, "You are concise.");
  assert.deepEqual(request.context_messages, []);
  assert.equal(request.workspace_id, "workspace-1");
  assert.equal(request.session_id, "session-1");
  assert.equal(request.input_id, "input-1");
  assert.equal(request.instruction, "Inspect the project");
  assert.equal(request.provider_id, "openai");
  assert.equal(request.model_id, "gpt-5.4");
  assert.equal(request.timeout_seconds, 60);
  assert.equal(request.harness_session_id, "requested-session-1");
  assert.equal(request.persisted_harness_session_id, "persisted-session-1");
  assert.deepEqual(request.workspace_skill_dirs, ["/tmp/workspace-1/skills/skill-1"]);
  assert.deepEqual(request.mcp_tool_refs, [{ tool_id: "workspace.lookup", server_id: "workspace", tool_name: "lookup" }]);
  assert.deepEqual(request.tools, { read: true, bash: true });
  assert.equal("output_format" in request, false);
});

test("opencode harness describeRuntimeStatus returns ready", async () => {
  const status = await opencodeHarnessDefinition.runtimeAdapter.describeRuntimeStatus({
    configLoaded: true,
    backendConfigPresent: false,
    backendReadinessTarget: null,
    probeBackendReadiness: async () => false,
  });
  assert.deepEqual(status, { ready: true, state: "ready" });
});
