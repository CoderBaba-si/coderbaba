#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ProcessManager, createLlm } from "@coderbabasi/core";
import { createRunner } from "./server.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return value;
}

/** Starts the template's dev server so the builder page can show a live preview. */
async function startPreview(processes: ProcessManager, root: string, port: number): Promise<void> {
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return;
  }
  if (!scripts.dev) return;
  const pm = fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : "npm";
  const result = await processes.start({
    command: `${pm} run dev -- --host 0.0.0.0 --port ${port}`,
    cwd: root,
    name: "site",
    waitFor: { port },
  });
  console.log(result.ready ? `preview on port ${port}` : `preview did not start: ${result.error ?? result.output.slice(-500)}`);
}

async function main(): Promise<void> {
  const root = path.resolve(process.env.PROJECT_DIR ?? process.cwd());
  const secret = required("RUNNER_SECRET");
  const token = required("CODERBABA_TOKEN");
  const port = Number(process.env.RUNNER_PORT ?? 8080);
  const previewPort = Number(process.env.PREVIEW_PORT ?? 4321);
  const processes = new ProcessManager();
  const runner = createRunner({
    root,
    secret,
    llm: createLlm(token),
    model: process.env.CODERBABA_MODEL ?? "smart",
    previewPort,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
    processes,
    log: (line) => console.log(line),
  });
  const listening = await runner.listen(port);
  console.log(`runner listening on ${listening} for ${root}`);
  await startPreview(processes, root, previewPort);

  const shutdown = () => {
    void runner.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
