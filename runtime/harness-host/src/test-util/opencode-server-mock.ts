import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockSSEEvent {
  event?: string;
  data: string;
  id?: string;
  delayMs?: number;
}

export interface MockSession {
  id: string;
  messages: Array<Record<string, unknown>>;
  status: "idle" | "busy";
}

export interface MockScenario {
  events: MockSSEEvent[];
  sessionId?: string;
}

export class OpenCodeServerMock {
  private server: Server;
  private port: number = 0;
  private sessions = new Map<string, MockSession>();
  private pendingScenarios = new Map<string, MockScenario>();
  private sseConnections: Array<{ res: ServerResponse; ended: boolean }> = [];
  private directory: string;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(directory: string) {
    this.directory = directory;
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        this.startHeartbeat();
        resolve(this.url);
      });
      this.server.on("error", reject);
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const conn of this.sseConnections) {
      if (!conn.ended) {
        conn.res.end();
        conn.ended = true;
      }
    }
    this.sseConnections = [];
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  enqueueScenario(sessionId: string, scenario: MockScenario): void {
    this.pendingScenarios.set(sessionId, { ...scenario, sessionId });
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.broadcastSSE({
        event: "message",
        data: JSON.stringify({
          directory: this.directory,
          payload: { id: "heartbeat-1", type: "server.heartbeat", properties: {} },
        }),
      });
    }, 10000);
  }

  private broadcastSSE(sseEvent: { event?: string; data: string; id?: string }): void {
    for (const conn of this.sseConnections) {
      if (conn.ended) continue;
      this.writeSSE(conn.res, sseEvent);
    }
  }

  private writeSSE(res: ServerResponse, sseEvent: { event?: string; data: string; id?: string }): void {
    if (sseEvent.event) res.write(`event: ${sseEvent.event}\n`);
    if (sseEvent.id) res.write(`id: ${sseEvent.id}\n`);
    res.write(`data: ${sseEvent.data}\n\n`);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (url.pathname === "/global/health") {
      this.json(res, { healthy: true, version: "0.0.0-mock" });
      return;
    }

    if (url.pathname === "/global/event" && req.method === "GET") {
      this.handleSSE(req, res);
      return;
    }

    if (url.pathname === "/session" && req.method === "POST") {
      await this.handleCreateSession(req, res);
      return;
    }

    if (url.pathname.match(/^\/session\/[^/]+\/prompt(_async)?$/) && req.method === "POST") {
      await this.handlePrompt(req, res, url);
      return;
    }

    if (url.pathname.match(/^\/session\/[^/]+\/abort$/) && req.method === "POST") {
      this.handleAbort(req, res, url);
      return;
    }

    if (url.pathname.match(/^\/session\/[^/]+\/compact$/) && req.method === "POST") {
      this.handleCompact(req, res, url);
      return;
    }

    if (url.pathname.match(/^\/session\/[^/]+$/) && req.method === "GET") {
      this.handleGetSession(req, res, url);
      return;
    }

    if (url.pathname.match(/^\/session\/[^/]+\/context$/) && req.method === "GET") {
      this.json(res, []);
      return;
    }

    if (url.pathname.match(/^\/session\/[^/]+\/message$/) && req.method === "GET") {
      this.json(res, []);
      return;
    }

    this.json(res, { error: "not found" }, 404);
  }

  private handleSSE(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });

    const conn = { res, ended: false };
    this.sseConnections.push(conn);

    this.writeSSE(res, {
      event: "message",
      data: JSON.stringify({
        directory: this.directory,
        payload: { id: "connected-1", type: "server.connected", properties: {} },
      }),
    });

    req: {
      _req.on("close", () => {
        conn.ended = true;
      });
    }
  }

  private async handleCreateSession(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = `mock-session-${Date.now()}`;
    const session: MockSession = {
      id: sessionId,
      messages: [],
      status: "idle",
    };
    this.sessions.set(sessionId, session);
    this.json(res, { id: sessionId, title: "", created_at: new Date().toISOString() });
  }

  private async handlePrompt(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split("/");
    const sessionId = parts[2];
    const isAsync = url.pathname.endsWith("/prompt_async");
    const session = this.sessions.get(sessionId);

    if (!session) {
      this.json(res, { error: "session not found" }, 404);
      return;
    }

    session.status = "busy";

    if (isAsync) {
      this.json(res, null, 204);
    }

    const scenario = this.pendingScenarios.get(sessionId);
    if (scenario) {
      this.playScenario(sessionId, scenario);
      if (!isAsync) {
        await this.waitScenarioDone(scenario);
        session.status = "idle";
        this.json(res, { id: "msg-response", role: "assistant", parts: [] });
      }
      return;
    }

    if (!isAsync) {
      session.status = "idle";
      this.json(res, { id: "msg-response", role: "assistant", parts: [] });
    }
  }

  private handleAbort(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    const parts = url.pathname.split("/");
    const sessionId = parts[2];
    const session = this.sessions.get(sessionId);
    if (session) session.status = "idle";
    this.json(res, true);
  }

  private handleCompact(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    const parts = url.pathname.split("/");
    const sessionId = parts[2];
    this.broadcastSSE({
      event: "message",
      data: JSON.stringify({
        directory: this.directory,
        payload: {
          id: "compact-1",
          type: "session.next.compaction.started",
          properties: { sessionID: sessionId, reason: "manual" },
        },
      }),
    });
    this.broadcastSSE({
      event: "message",
      data: JSON.stringify({
        directory: this.directory,
        payload: {
          id: "compact-2",
          type: "session.next.compaction.ended",
          properties: { sessionID: sessionId, text: "Compacted" },
        },
      }),
    });
    this.json(res, null, 204);
  }

  private handleGetSession(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    const parts = url.pathname.split("/");
    const sessionId = parts[2];
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.json(res, { error: "session not found" }, 404);
      return;
    }
    this.json(res, { id: session.id, title: "", status: session.status });
  }

  private async playScenario(sessionId: string, scenario: MockScenario): Promise<void> {
    for (const event of scenario.events) {
      if (event.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, event.delayMs));
      }
      this.broadcastSSE({
        event: event.event ?? "message",
        data: event.data,
        id: event.id,
      });
    }
  }

  private async waitScenarioDone(scenario: MockScenario): Promise<void> {
    const totalDelay = scenario.events.reduce((sum, e) => sum + (e.delayMs ?? 0), 0);
    await new Promise((resolve) => setTimeout(resolve, totalDelay + 10));
  }

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
}
