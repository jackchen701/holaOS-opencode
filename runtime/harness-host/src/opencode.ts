import type { HarnessHostOpencodeRequest } from "./opencode-contracts.js";
import type { RunnerOutputEvent, RunnerEventType } from "./contracts.js";

function emitRunnerEvent(event: RunnerOutputEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function runOpencode(request: HarnessHostOpencodeRequest): Promise<number> {
  const startTime = Date.now();
  let sequence = 0;
  const { timeout_seconds } = request;

  const hardTimeout = setTimeout(() => {}, timeout_seconds * 1000);

  try {
    emitRunnerEvent({
      session_id: request.session_id,
      input_id: request.input_id,
      sequence: sequence++,
      event_type: "run_started" as RunnerEventType,
      payload: { ...request.run_started_payload },
    });

    emitRunnerEvent({
      session_id: request.session_id,
      input_id: request.input_id,
      sequence: sequence++,
      event_type: "run_failed" as RunnerEventType,
      payload: {
        error: "opencode harness adapter not yet implemented",
        duration_ms: Date.now() - startTime,
      },
    });

    return 1;
  } finally {
    clearTimeout(hardTimeout);
  }
}
