import type { AgentEvent, ProcessInfo, SecretRequest, SeoAuditResult, Todo } from "@coderbabasi/core";

/** Messages the builder page sends over the WebSocket. */
export type ClientMessage =
  | { type: "task"; text: string; model?: string }
  | { type: "stop" }
  | { type: "undo" }
  | { type: "listFiles" }
  | { type: "readFile"; path: string }
  | { type: "secret"; id: string; value: string | null }
  | { type: "audit" }
  | { type: "ping" };

/** Messages the runner sends to every connected page. */
export type ServerMessage =
  | { type: "hello"; busy: boolean; processes: ProcessInfo[]; todos: Todo[]; previewPort: number; history: HistoryItem[] }
  | { type: "event"; event: AgentEvent }
  | { type: "busy"; busy: boolean }
  | { type: "processes"; processes: ProcessInfo[] }
  | { type: "todos"; todos: Todo[] }
  | { type: "files"; files: FileEntry[] }
  | { type: "file"; path: string; content: string; truncated: boolean }
  | { type: "askSecret"; id: string; request: Omit<SecretRequest, "envPath"> }
  | { type: "undone"; restored: string[] }
  | { type: "audit"; result: SeoAuditResult }
  | { type: "error"; message: string }
  | { type: "pong" };

export type FileEntry = { path: string; size: number };

/** One past task in the session, so a reconnecting page can redraw the chat. */
export type HistoryItem = { task: string; reply: string; at: string; stopCode?: string };

/** Jobs the cloud starts over HTTP. They can outlive a serverless request, so the cloud polls for results. */
export type JobRequest =
  | { type: "build"; env?: Record<string, string> }
  | { type: "upload"; uploads: { path: string; url: string; contentType: string }[] }
  | { type: "audit"; url?: string; strict?: boolean; maxPages?: number; env?: Record<string, string> }
  | { type: "agent"; task: string; model?: string; label?: string }
  | { type: "snapshot"; tag: string; message?: string }
  | { type: "restore"; tag: string }
  | { type: "changes"; since: string }
  | { type: "theme"; theme: Record<string, string>; screenshots?: boolean }
  | { type: "import"; url: string; maxPages?: number }
  | { type: "export"; url: string }
  | { type: "github"; remote: string; token: string; branch?: string; message?: string }
  | { type: "syncUpload"; url: string; name: string; alt?: string; attribution?: string }
  | { type: "uploadMeta"; name: string; alt?: string; attribution?: string; remove?: boolean }
  | { type: "screenshot"; path?: string; width?: number; height?: number }
  | { type: "inspect"; origin?: string }
  | { type: "readSiteJson"; pages?: boolean };

export type JobState = {
  id: string;
  type: JobRequest["type"];
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
};

export function parseClientMessage(raw: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "task":
      return typeof message.text === "string" && message.text.trim()
        ? { type: "task", text: message.text.slice(0, 20_000), model: typeof message.model === "string" ? message.model : undefined }
        : undefined;
    case "readFile":
      return typeof message.path === "string" ? { type: "readFile", path: message.path } : undefined;
    case "secret":
      return typeof message.id === "string" && (typeof message.value === "string" || message.value === null)
        ? { type: "secret", id: message.id, value: message.value }
        : undefined;
    case "stop":
    case "undo":
    case "listFiles":
    case "audit":
    case "ping":
      return { type: message.type };
    default:
      return undefined;
  }
}

const JOB_TYPES = new Set<JobRequest["type"]>([
  "build",
  "upload",
  "audit",
  "agent",
  "snapshot",
  "restore",
  "changes",
  "theme",
  "import",
  "export",
  "github",
  "syncUpload",
  "uploadMeta",
  "screenshot",
  "inspect",
  "readSiteJson",
]);

export function parseJobRequest(value: unknown): JobRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !JOB_TYPES.has(type as JobRequest["type"])) return undefined;
  return value as JobRequest;
}
