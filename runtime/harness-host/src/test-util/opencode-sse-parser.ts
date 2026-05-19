export interface ParsedSSEEvent {
  event?: string;
  id?: string;
  data: string;
}

export function parseSSEStream(raw: string): ParsedSSEEvent[] {
  const events: ParsedSSEEvent[] = [];
  const chunks = raw.split("\n\n");
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    let event: string | undefined;
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("id: ")) {
        id = line.slice(4);
      } else if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      }
    }
    if (dataLines.length > 0) {
      events.push({ event, id, data: dataLines.join("\n") });
    }
  }
  return events;
}

export interface GlobalSSEEvent {
  directory: string;
  project?: string;
  workspace?: string;
  payload: {
    id: string;
    type: string;
    properties: Record<string, unknown>;
  };
}

export function parseGlobalSSEData(data: string): GlobalSSEEvent | null {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && parsed.payload) {
      return parsed as GlobalSSEEvent;
    }
  } catch {}
  return null;
}
