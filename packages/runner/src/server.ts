import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserSession, ProcessManager, runningSiteUrl, type Llm } from "@coderbabasi/core";
import { listProjectFiles, readProjectFile } from "./files.js";
import { JobRunner, auditJob } from "./jobs.js";
import { parseClientMessage, parseJobRequest, type ServerMessage } from "./protocol.js";
import { AgentSession } from "./session.js";

export type RunnerOptions = {
  root: string;
  secret: string;
  llm: Llm;
  model: string;
  previewPort: number;
  /** Browser origins allowed to open the WebSocket, such as https://coderbaba.si. Empty allows any. */
  allowedOrigins?: string[];
  processes?: ProcessManager;
  browser?: BrowserSession;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

export type Runner = {
  server: http.Server;
  session: AgentSession;
  jobs: JobRunner;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
};

const PROTOCOL = "coderbaba";
const MAX_BODY = 5_000_000;

export function secretMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads the secret from `Sec-WebSocket-Protocol: coderbaba, <secret>`, since browsers can't set headers on WebSockets. */
export function protocolSecret(header: string | undefined): string | undefined {
  const parts = (header ?? "").split(",").map((part) => part.trim());
  return parts[0] === PROTOCOL ? parts[1] : undefined;
}

function bearer(request: http.IncomingMessage): string | undefined {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createRunner(opts: RunnerOptions): Runner {
  const processes = opts.processes ?? new ProcessManager();
  const browser = opts.browser ?? new BrowserSession();
  const clients = new Set<WebSocket>();
  const log = opts.log ?? (() => undefined);

  const broadcast = (message: ServerMessage) => {
    const data = JSON.stringify(message);
    for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(data);
  };

  const session = new AgentSession({
    root: opts.root,
    llm: opts.llm,
    model: opts.model,
    processes,
    browser,
    onEvent: (event) => broadcast({ type: "event", event }),
    onBusy: (busy) => broadcast({ type: "busy", busy }),
    onTodos: (todos) => broadcast({ type: "todos", todos }),
    askSecret: (id, request) => broadcast({ type: "askSecret", id, request: { name: request.name, hint: request.hint } }),
  });

  const previewUrl = () => runningSiteUrl(processes) ?? `http://127.0.0.1:${opts.previewPort}`;
  const jobs = new JobRunner({ root: opts.root, session, browser, previewUrl, fetchImpl: opts.fetchImpl });
  const unsubscribe = processes.on(() => broadcast({ type: "processes", processes: processes.list() }));

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://runner");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, busy: session.busy, jobs: jobs.running() });
      }
      if (!secretMatches(opts.secret, bearer(request))) return sendJson(response, 401, { error: "unauthorized" });
      if (request.method === "POST" && url.pathname === "/jobs") {
        const job = parseJobRequest(await readBody(request));
        if (!job) return sendJson(response, 400, { error: "invalid job" });
        log(`job ${job.type}`);
        return sendJson(response, 202, jobs.start(job));
      }
      const match = /^\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (request.method === "GET" && match) {
        const job = jobs.get(match[1]!);
        return job ? sendJson(response, 200, job) : sendJson(response, 404, { error: "not found" });
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        return sendJson(response, 200, { stopped: session.stop() });
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      return sendJson(response, 400, { error: (error as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000, handleProtocols: () => PROTOCOL });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://runner");
    if (url.pathname !== "/ws") return reject(socket, 404, "Not Found");
    const origin = request.headers.origin;
    if (opts.allowedOrigins?.length && (!origin || !opts.allowedOrigins.includes(origin))) return reject(socket, 403, "Forbidden");
    if (!secretMatches(opts.secret, protocolSecret(request.headers["sec-websocket-protocol"]))) return reject(socket, 401, "Unauthorized");
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    const send = (message: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));
    send({ type: "hello", busy: session.busy, processes: processes.list(), todos: session.state.todos, previewPort: opts.previewPort, history: session.state.history.slice(-50) });
    ws.on("close", () => clients.delete(ws));
    ws.on("message", async (data) => {
      const message = parseClientMessage(data.toString());
      if (!message) return send({ type: "error", message: "Unknown message." });
      try {
        switch (message.type) {
          case "ping":
            return send({ type: "pong" });
          case "task":
            if (session.busy) return send({ type: "error", message: "Another change is still being made. Wait for it to finish or press Stop." });
            void session.run(message.text, { model: message.model }).catch((error: Error) => send({ type: "error", message: error.message }));
            return;
          case "stop":
            session.stop();
            return;
          case "undo": {
            const result = await session.undo();
            return send(result ? { type: "undone", restored: result.restored } : { type: "error", message: "There's nothing to undo." });
          }
          case "listFiles":
            return send({ type: "files", files: listProjectFiles(opts.root) });
          case "readFile":
            return send({ type: "file", ...(await readProjectFile(opts.root, message.path)) });
          case "secret":
            session.answerSecret(message.id, message.value);
            return;
          case "audit":
            return send({ type: "audit", result: await auditJob({ root: opts.root, session, browser, previewUrl }, { type: "audit" }) });
        }
      } catch (error) {
        send({ type: "error", message: (error as Error).message });
      }
    });
  });

  return {
    server,
    session,
    jobs,
    async listen(port, host = "0.0.0.0") {
      await session.load();
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
      const address = server.address();
      return typeof address === "object" && address ? address.port : port;
    },
    async close() {
      unsubscribe();
      session.stop();
      for (const client of clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await processes.stopAll();
      await browser.close();
    },
  };
}
