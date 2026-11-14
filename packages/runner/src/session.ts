import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "@coderbabasi/shared";
import {
  Checkpoints,
  runTurn,
  type AgentEvent,
  type BrowserSession,
  type Llm,
  type PermissionDecision,
  type PermissionRequest,
  type ProcessManager,
  type SecretRequest,
  type Todo,
} from "@coderbabasi/core";
import type { HistoryItem } from "./protocol.js";

export type SessionOptions = {
  root: string;
  llm: Llm;
  model: string;
  processes: ProcessManager;
  browser?: BrowserSession;
  maxSteps?: number;
  onEvent: (event: AgentEvent) => void;
  onBusy: (busy: boolean) => void;
  onTodos: (todos: Todo[]) => void;
  askSecret: (id: string, request: SecretRequest) => void;
};

type SavedSession = { messages: ChatMessage[]; todos: Todo[]; history: HistoryItem[] };

const MAX_HISTORY = 200;

/** Inside the sandbox every action is allowed, except touching files outside the project. */
export function sandboxPermission(request: PermissionRequest): PermissionDecision {
  return request.kind === "outside" ? "deny" : "always";
}

/** One builder project's agent: a single conversation, one task at a time. */
export class AgentSession {
  private messages: ChatMessage[] = [];
  private todos: { items: Todo[] } = { items: [] };
  private history: HistoryItem[] = [];
  private readonly allows = new Set<string>();
  private readonly checkpoints: Checkpoints;
  private readonly secrets = new Map<string, (value: string | null) => void>();
  private abort?: AbortController;
  private current?: Promise<TaskOutcome>;

  constructor(private readonly opts: SessionOptions) {
    this.checkpoints = new Checkpoints(path.join(opts.root, ".coderbaba", "checkpoints"));
  }

  private get file(): string {
    return path.join(this.opts.root, ".coderbaba", "runner-session.json");
  }

  async load(): Promise<void> {
    await this.checkpoints.load();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<SavedSession>;
      this.messages = Array.isArray(saved.messages) ? saved.messages : [];
      this.todos.items = Array.isArray(saved.todos) ? saved.todos : [];
      this.history = Array.isArray(saved.history) ? saved.history : [];
    } catch {
      // New project.
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const saved: SavedSession = { messages: this.messages, todos: this.todos.items, history: this.history.slice(-MAX_HISTORY) };
    fs.writeFileSync(this.file, JSON.stringify(saved));
  }

  get busy(): boolean {
    return this.current !== undefined;
  }

  get state(): { todos: Todo[]; history: HistoryItem[] } {
    return { todos: this.todos.items, history: this.history };
  }

  /** Runs one task. Rejects when another task is still running. */
  run(task: string, opts: { model?: string; onEvent?: (event: AgentEvent) => void } = {}): Promise<TaskOutcome> {
    if (this.current) return Promise.reject(new Error("Another task is still running."));
    const abort = new AbortController();
    this.abort = abort;
    this.opts.onBusy(true);
    const run = this.execute(task, abort.signal, opts).finally(() => {
      this.current = undefined;
      this.abort = undefined;
      this.opts.onBusy(false);
    });
    this.current = run;
    return run;
  }

  private async execute(task: string, signal: AbortSignal, opts: { model?: string; onEvent?: (event: AgentEvent) => void }): Promise<TaskOutcome> {
    let reply = "";
    const files = new Set<string>();
    const onEvent = (event: AgentEvent) => {
      if (event.type === "text") reply += event.text;
      if (event.type === "tool" && event.event.path && !event.event.denied && (event.event.added !== undefined || event.event.removed !== undefined)) {
        files.add(event.event.path);
      }
      this.opts.onEvent(event);
      opts.onEvent?.(event);
    };
    const before = JSON.stringify(this.todos.items);
    const result = await runTurn({
      task,
      cwd: this.opts.root,
      model: opts.model || this.opts.model,
      taskId: randomUUID(),
      messages: this.messages,
      llm: this.opts.llm,
      askPermission: async (request) => sandboxPermission(request),
      allows: this.allows,
      checkpoints: this.checkpoints,
      maxSteps: this.opts.maxSteps ?? 60,
      onEvent,
      processes: this.opts.processes,
      browser: this.opts.browser,
      askSecret: (request) => this.askSecret(request),
      signal,
      todos: this.todos,
    });
    this.messages = result.messages;
    if (JSON.stringify(this.todos.items) !== before) this.opts.onTodos(this.todos.items);
    const item: HistoryItem = { task, reply: reply.trim(), at: new Date().toISOString(), stopCode: result.stopCode };
    this.history.push(item);
    this.save();
    return { reply: item.reply, stopCode: result.stopCode, files: [...files] };
  }

  stop(): boolean {
    if (!this.abort) return false;
    this.abort.abort();
    for (const [id, resolve] of this.secrets) {
      resolve(null);
      this.secrets.delete(id);
    }
    return true;
  }

  /** Waits for the running task, if any, to finish. */
  async idle(): Promise<void> {
    await this.current?.catch(() => undefined);
  }

  async undo(): Promise<{ restored: string[] } | null> {
    if (this.current) throw new Error("Wait for the current task to finish before undoing.");
    return this.checkpoints.undoLast();
  }

  private askSecret(request: SecretRequest): Promise<string | null> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.secrets.set(id, resolve);
      this.opts.askSecret(id, request);
    });
  }

  answerSecret(id: string, value: string | null): boolean {
    const resolve = this.secrets.get(id);
    if (!resolve) return false;
    this.secrets.delete(id);
    resolve(value);
    return true;
  }
}

export type TaskOutcome = { reply: string; stopCode?: string; files: string[] };
