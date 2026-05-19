export interface HarnessHostOpencodeRequest {
  workspace_id: string;
  workspace_dir: string;
  session_id: string;
  input_id: string;
  instruction: string;
  context_messages?: string[];
  tools?: Record<string, boolean>;
  attachments?: Array<{
    id: string;
    kind: "image" | "file" | "folder";
    name: string;
    mime_type: string;
    size_bytes: number;
    workspace_path: string;
  }>;
  image_urls?: string[];
  thinking_value?: string | null;
  debug: boolean;
  harness_session_id?: string | null;
  persisted_harness_session_id?: string | null;
  provider_id: string;
  model_id: string;
  timeout_seconds: number;
  runtime_api_base_url?: string | null;
  system_prompt: string;
  workspace_skill_dirs: string[];
  mcp_servers: Array<Record<string, unknown>>;
  mcp_tool_refs: Array<{ tool_id: string; server_id: string; tool_name: string }>;
  workspace_config_checksum: string;
  run_started_payload: Record<string, unknown>;
  model_client: {
    model_proxy_provider: string;
    api_key: string;
    base_url?: string | null;
    default_headers?: Record<string, string> | null;
  };
}

export function decodeHarnessHostOpencodeRequestBase64(encoded: string): HarnessHostOpencodeRequest {
  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid opencode harness host request payload");
  }
  if (typeof parsed.workspace_id !== "string") throw new Error("missing workspace_id");
  if (typeof parsed.session_id !== "string") throw new Error("missing session_id");
  if (typeof parsed.input_id !== "string") throw new Error("missing input_id");
  if (typeof parsed.instruction !== "string") throw new Error("missing instruction");
  if (typeof parsed.workspace_dir !== "string") throw new Error("missing workspace_dir");
  return parsed as HarnessHostOpencodeRequest;
}
