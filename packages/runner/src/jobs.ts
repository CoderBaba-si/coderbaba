import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { findBuildDir, runSeoAudit, serveStatic, type BrowserSession, type FetchText, type SeoAuditResult } from "@coderbabasi/core";
import { contentTypeFor, listProjectFiles, walkFiles } from "./files.js";
import { changesSince, pushToGitHub, restore, snapshot } from "./git.js";
import { importSite } from "./import.js";
import { inspectBuild } from "./inspect.js";
import { safeFetch } from "./net.js";
import type { JobRequest, JobState } from "./protocol.js";
import type { AgentSession } from "./session.js";
import { screenshots, writeTheme } from "./theme.js";
import { createZip } from "./zip.js";

const exec = promisify(execFile);

export type JobContext = {
  root: string;
  session: AgentSession;
  browser?: BrowserSession;
  /** URL of the running preview server inside the sandbox. */
  previewUrl: () => string | undefined;
  fetchImpl?: typeof fetch;
};

export type BuildResult = { ok: boolean; output: string; outDir?: string; files: { path: string; size: number; contentType: string }[] };

const MAX_JOBS = 50;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const UPLOAD_LIMIT = 2000;
const UPLOAD_BYTES = 100_000_000;

export function buildCommand(root: string): string {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm run build";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn build";
  return "npm run build";
}

/** Only public build-time values (PUBLIC_*) can be passed in; they end up in the site's HTML anyway. */
export function publicEnv(env: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => /^PUBLIC_[A-Z0-9_]+$/.test(key) && typeof value === "string" && value.length <= 2000));
}

export async function buildSite(root: string, env?: Record<string, string>): Promise<BuildResult> {
  const command = buildCommand(root);
  let output = "";
  let ok = true;
  try {
    const result = await exec("sh", ["-c", command], { cwd: root, timeout: BUILD_TIMEOUT_MS, maxBuffer: 20_000_000, env: { ...process.env, ...publicEnv(env), CI: "1" } });
    output = `${result.stdout}${result.stderr}`;
  } catch (error) {
    ok = false;
    const failed = error as { stdout?: string; stderr?: string; message: string };
    output = `${failed.stdout ?? ""}${failed.stderr ?? ""}` || failed.message;
  }
  output = output.slice(-20_000);
  if (!ok) return { ok, output, files: [] };
  const outDir = await findBuildDir(root);
  if (!outDir) return { ok: false, output: `${output}\nThe build finished but no index.html was found in dist/.`, files: [] };
  const files = walkFiles(outDir).map((file) => ({ path: file, size: fs.statSync(path.join(outDir, file)).size, contentType: contentTypeFor(file) }));
  for (const extra of ["redirects.json"]) {
    if (fs.existsSync(path.join(root, extra))) {
      fs.copyFileSync(path.join(root, extra), path.join(outDir, `_coderbaba_${extra}`));
      files.push({ path: `_coderbaba_${extra}`, size: fs.statSync(path.join(outDir, `_coderbaba_${extra}`)).size, contentType: "application/json" });
    }
  }
  return { ok, output, outDir: path.relative(root, outDir) || ".", files };
}

/** PUTs each built file to the presigned URL the cloud made for it. Hosting credentials never enter the sandbox. */
export async function uploadBuild(root: string, uploads: { path: string; url: string; contentType: string }[], fetchImpl: typeof fetch = fetch): Promise<{ uploaded: number; bytes: number }> {
  if (uploads.length > UPLOAD_LIMIT) throw new Error(`A site can have at most ${UPLOAD_LIMIT} files.`);
  const outDir = await findBuildDir(root);
  if (!outDir) throw new Error("Build the site before uploading it.");
  let bytes = 0;
  let index = 0;
  const worker = async () => {
    while (index < uploads.length) {
      const upload = uploads[index++]!;
      const full = path.resolve(outDir, upload.path);
      if (!full.startsWith(path.resolve(outDir) + path.sep)) throw new Error(`Refusing to upload ${upload.path}.`);
      const body = fs.readFileSync(full);
      bytes += body.length;
      if (bytes > UPLOAD_BYTES) throw new Error("The built site is larger than 100 MB.");
      const response = await fetchImpl(upload.url, { method: "PUT", body: new Uint8Array(body), headers: { "content-type": upload.contentType } });
      if (!response.ok) throw new Error(`Uploading ${upload.path} failed with ${response.status}.`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, uploads.length) }, worker));
  return { uploaded: uploads.length, bytes };
}

function safeFetchText(fetchImpl?: typeof fetch): FetchText {
  return async (url) => {
    try {
      const response = await safeFetch(url, { fetchImpl, maxBytes: 3_000_000, accept: "text/html,text/plain,application/xml;q=0.9,*/*;q=0.5" });
      return { status: response.status, text: response.body.toString("utf8"), contentType: response.contentType };
    } catch {
      return null;
    }
  };
}

/** Audits an external site (the public audit page) or this project's built output. */
export async function auditJob(ctx: JobContext, job: Extract<JobRequest, { type: "audit" }>): Promise<SeoAuditResult> {
  const browser = await ctx.browser?.get();
  if (job.url) {
    return runSeoAudit({ baseUrl: job.url, maxPages: Math.min(job.maxPages ?? 20, 50), browser, fetchText: safeFetchText(ctx.fetchImpl) });
  }
  const build = await buildSite(ctx.root, job.env);
  if (!build.ok || !build.outDir) throw new Error(`The site didn't build:\n${build.output.slice(-3000)}`);
  const server = await serveStatic(path.join(ctx.root, build.outDir));
  try {
    return await runSeoAudit({ baseUrl: server.url, maxPages: Math.min(job.maxPages ?? 50, 200), browser, strictRendering: job.strict ?? true });
  } finally {
    await server.close();
  }
}

export async function exportZip(root: string): Promise<Buffer> {
  const skip = new Set(["node_modules", ".git", ".coderbaba", ".astro", "dist", ".turbo", ".cache"]);
  const entries = listProjectFiles(root, skip)
    .filter((file) => !file.path.split("/").some((part) => part === ".env" || part.startsWith(".env.")))
    .map((file) => ({ name: `site/${file.path}`, data: fs.readFileSync(path.join(root, file.path)) }));
  return createZip(entries);
}

export async function runJob(ctx: JobContext, job: JobRequest): Promise<unknown> {
  switch (job.type) {
    case "build":
      return buildSite(ctx.root, job.env);
    case "upload":
      return uploadBuild(ctx.root, job.uploads, ctx.fetchImpl);
    case "audit":
      return auditJob(ctx, job);
    case "agent": {
      await ctx.session.idle();
      return ctx.session.run(job.task, { model: job.model });
    }
    case "snapshot":
      return { commit: await snapshot(ctx.root, job.tag, job.message) };
    case "restore":
      await ctx.session.idle();
      return { commit: await restore(ctx.root, job.tag) };
    case "changes":
      return changesSince(ctx.root, job.since);
    case "theme": {
      writeTheme(ctx.root, job.theme);
      const url = ctx.previewUrl();
      if (!job.screenshots || !url || !ctx.browser) return { written: true, screenshots: [] };
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { written: true, screenshots: await screenshots(ctx.browser, url) };
    }
    case "screenshot": {
      const url = ctx.previewUrl();
      if (!url || !ctx.browser) throw new Error("The preview isn't running.");
      const target = new URL(job.path ?? "/", url).toString();
      return { screenshots: await screenshots(ctx.browser, target, [{ device: "desktop", width: job.width ?? 1280, height: job.height ?? 800 }]) };
    }
    case "import":
      return importSite(ctx.root, job.url, { fetchImpl: ctx.fetchImpl, maxPages: job.maxPages });
    case "export": {
      const zip = await exportZip(ctx.root);
      const response = await (ctx.fetchImpl ?? fetch)(job.url, { method: "PUT", body: new Uint8Array(zip), headers: { "content-type": "application/zip" } });
      if (!response.ok) throw new Error(`Uploading the export failed with ${response.status}.`);
      return { bytes: zip.length };
    }
    case "github":
      return { commit: await pushToGitHub(ctx.root, job) };
    case "inspect": {
      const outDir = await findBuildDir(ctx.root);
      if (!outDir) throw new Error("Build the site before inspecting it.");
      return { pages: inspectBuild(outDir, job.origin) };
    }
    case "readSiteJson": {
      const file = path.join(ctx.root, "site.json");
      const pages = listProjectFiles(ctx.root).filter((entry) => /^src\/(pages|content)\/.+\.(astro|md|mdx)$/.test(entry.path));
      const read = (rel: string) => fs.readFileSync(path.join(ctx.root, rel), "utf8").slice(0, 40_000);
      const redirectsFile = path.join(ctx.root, "redirects.json");
      let redirects: unknown = [];
      try {
        redirects = fs.existsSync(redirectsFile) ? JSON.parse(fs.readFileSync(redirectsFile, "utf8")) : [];
      } catch {
        redirects = [];
      }
      return {
        redirects,
        site: fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as unknown) : null,
        pages: job.pages === false ? [] : pages.slice(0, 200).map((entry) => ({ path: entry.path, content: read(entry.path) })),
        uploads: listProjectFiles(ctx.root).filter((entry) => entry.path.startsWith("src/assets/uploads/")).map((entry) => entry.path),
      };
    }
    case "syncUpload": {
      const name = uploadName(job.name);
      const response = await (ctx.fetchImpl ?? fetch)(job.url);
      if (!response.ok) throw new Error(`Downloading the upload failed with ${response.status}.`);
      const dir = path.join(ctx.root, "src", "assets", "uploads");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), Buffer.from(await response.arrayBuffer()));
      writeUploadMeta(ctx.root, name, { alt: job.alt, attribution: job.attribution });
      return { file: `src/assets/uploads/${name}` };
    }
    case "uploadMeta": {
      const name = uploadName(job.name);
      if (job.remove) {
        fs.rmSync(path.join(ctx.root, "src", "assets", "uploads", name), { force: true });
        writeUploadMeta(ctx.root, name, null);
        return { removed: true };
      }
      writeUploadMeta(ctx.root, name, { alt: job.alt, attribution: job.attribution });
      return { file: `src/assets/uploads/${name}` };
    }
  }
}

function uploadName(raw: string): string {
  const name = path.basename(raw).replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!/\.(png|jpe?g|webp|gif|avif|pdf)$/i.test(name)) throw new Error("Only images (PNG, JPEG, WebP, GIF, AVIF) and PDFs can be uploaded.");
  return name;
}

export type UploadMeta = { file: string; alt?: string; attribution?: string };

/**
 * src/assets/uploads/uploads.json lists the owner's uploads with their alt text, so the agent
 * uses the owner's descriptions instead of inventing them.
 */
export function writeUploadMeta(root: string, name: string, meta: { alt?: string; attribution?: string } | null): void {
  const file = path.join(root, "src", "assets", "uploads", "uploads.json");
  let list: UploadMeta[] = [];
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8")) as UploadMeta[];
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  list = list.filter((entry) => entry.file !== name);
  if (meta) list.push({ file: name, ...(meta.alt ? { alt: meta.alt.slice(0, 300) } : {}), ...(meta.attribution ? { attribution: meta.attribution.slice(0, 300) } : {}) });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(list.sort((a, b) => a.file.localeCompare(b.file)), null, 2)}\n`);
}

/** Runs jobs in the background and keeps their results for the cloud to poll. */
export class JobRunner {
  private readonly jobs = new Map<string, JobState>();

  constructor(private readonly ctx: JobContext) {}

  start(job: JobRequest): JobState {
    const state: JobState = { id: randomUUID(), type: job.type, status: "running", startedAt: new Date().toISOString() };
    this.jobs.set(state.id, state);
    this.prune();
    runJob(this.ctx, job).then(
      (result) => Object.assign(state, { status: "done", result, finishedAt: new Date().toISOString() }),
      (error: unknown) => Object.assign(state, { status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() }),
    );
    return state;
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id);
  }

  running(): number {
    return [...this.jobs.values()].filter((job) => job.status === "running").length;
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((job) => job.status !== "running");
    for (const job of finished.slice(0, Math.max(0, this.jobs.size - MAX_JOBS))) this.jobs.delete(job.id);
  }
}
