import { randomUUID } from "node:crypto";
import path from "node:path";
import { isErrorResponse, type GeoBusiness, type GeoCiteResponse } from "@coderbabasi/shared";
import { runTurn, type TurnOptions } from "../agent.js";
import { CoderBabaError } from "../errors.js";
import { apiBaseUrl } from "../llm.js";
import { runSeoAudit, type SeoAuditResult } from "../seo-audit.js";
import { runShell } from "../tools.js";
import { seoFixTask } from "./prompts.js";
import { sortSeoFindings } from "./report.js";
import { findBuildDir, isWebsiteProject, routesFor, runningSiteUrl, serveStatic } from "./routes.js";
import { SEO_REPORT_FILE, SeoStore, loadBusiness, saveBusiness, type SeoFinding } from "./store.js";

export type SeoTurnBase = Omit<TurnOptions, "task" | "messages" | "taskId" | "extraTools" | "todos">;

export type SeoRunResult = { summary: string; ranModel: boolean; stopCode?: string };

type Target = { url: string; close?: () => Promise<void>; from: "server" | "build" };

/** The dev server CoderBaba is running, or the build folder served locally. */
async function resolveTarget(root: string, base: Pick<SeoTurnBase, "processes">): Promise<Target | undefined> {
  const running = runningSiteUrl(base.processes);
  if (running) return { url: running, from: "server" };
  const dir = await findBuildDir(root);
  if (!dir) return undefined;
  const served = await serveStatic(dir);
  return { url: served.url, close: served.close, from: "build" };
}

const NO_TARGET =
  "Nothing to audit yet. Start the site's dev server (ask CoderBaba to run it) or build it so there's a dist/, out/ or build/ folder with index.html, then type /seo again.";

async function audit(root: string, base: SeoTurnBase, target: Target, extra: { onlyPaths?: string[]; onProgress?: (text: string) => void } = {}): Promise<SeoAuditResult> {
  const browser = await base.browser?.get();
  return runSeoAudit({
    baseUrl: target.url,
    onlyPaths: extra.onlyPaths,
    browser,
    accessibility: Boolean(browser),
    strictRendering: isWebsiteProject(root),
    onProgress: extra.onProgress,
  });
}

function describe(finding: SeoFinding): string {
  return `${finding.id} [${finding.severity}] ${finding.page ?? "site"}: ${finding.message}`;
}

export function seoSummary(store: SeoStore): string {
  const state = store.snapshot();
  const open = sortSeoFindings(state.findings.filter((finding) => finding.status === "open"));
  const head = state.score !== undefined ? `SEO score ${state.score}/100 across ${state.pages} page${state.pages === 1 ? "" : "s"}. ` : "";
  if (!open.length) return `${head}No open findings. Report: ${SEO_REPORT_FILE}`;
  const errors = open.filter((finding) => finding.severity === "error").length;
  return [
    `${head}${open.length} open finding${open.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}). Report: ${SEO_REPORT_FILE}`,
    ...open.slice(0, 5).map((finding) => `  ${describe(finding)}`),
    `Next: /seo fix ${open[0]!.id}`,
  ].join("\n");
}

export async function runSeoScan(base: SeoTurnBase, opts: { onProgress?: (text: string) => void } = {}): Promise<SeoRunResult> {
  const root = path.resolve(base.cwd);
  const target = await resolveTarget(root, base);
  if (!target) return { summary: NO_TARGET, ranModel: false };
  try {
    const result = await audit(root, base, target, { onProgress: opts.onProgress });
    const store = await SeoStore.open(root);
    await store.applyAudit(result, "scan");
    const note = target.from === "build" ? "Audited the build folder. Rebuild after changes so the audit sees them.\n" : "";
    return { summary: note + seoSummary(store), ranModel: false };
  } finally {
    await target.close?.();
  }
}

export async function runSeoFix(base: SeoTurnBase, id: string): Promise<SeoRunResult> {
  const root = path.resolve(base.cwd);
  const store = await SeoStore.open(root);
  const finding = store.get(id);
  if (!finding) return { summary: `There is no finding ${id}. Type /seo status to list them.`, ranModel: false };
  if (finding.status !== "open") return { summary: `${finding.id} is already ${finding.status}.`, ranModel: false };
  const target = await resolveTarget(root, base);
  if (!target) return { summary: NO_TARGET, ranModel: false };
  try {
    const turn = await runTurn({ ...base, task: seoFixTask(finding, target.url), messages: [], taskId: randomUUID() });
    if (turn.stopCode) return { summary: `The fix stopped early. ${finding.id} is still open.`, ranModel: true, stopCode: turn.stopCode };
    if (target.from === "build") {
      return { summary: `Changed the source for ${finding.id}. Rebuild the site, then type /seo to confirm the fix.`, ranModel: true };
    }
    const after = await audit(root, base, target, { onlyPaths: [finding.page ?? "/"] });
    await store.applyAudit(after, "scan", { partial: true });
    const updated = store.get(finding.id)!;
    return {
      summary: updated.status === "fixed" ? `${updated.id} is fixed. Type /undo to revert the change. Report: ${SEO_REPORT_FILE}` : `${updated.id} is still open after the change: ${updated.message}`,
      ranModel: true,
    };
  } finally {
    await target.close?.();
  }
}

const GIT_REF = /^[\w./@^~-]+$/;

export async function runSeoDiff(base: SeoTurnBase, ref?: string): Promise<SeoRunResult> {
  const root = path.resolve(base.cwd);
  if (ref && (!GIT_REF.test(ref) || ref.startsWith("-"))) return { summary: `${ref} doesn't look like a branch or commit name.`, ranModel: false };
  const repo = await runShell("git rev-parse --is-inside-work-tree", root, { timeoutMs: 10_000 });
  if (repo.code !== 0) return { summary: "This project isn't a git repository, so there is no diff. Type /seo for a full audit.", ranModel: false };
  const commands = ref ? [`git diff --name-only ${ref}...HEAD`] : ["git diff --name-only", "git diff --name-only --cached", "git ls-files --others --exclude-standard"];
  const files = new Set<string>();
  for (const command of commands) {
    const out = await runShell(command, root, { timeoutMs: 10_000 });
    for (const line of out.output.split("\n")) if (line.trim()) files.add(line.trim());
  }
  if (!files.size) return { summary: ref ? `No changes against ${ref}.` : "No uncommitted changes. Pass a base branch, such as /seo diff main.", ranModel: false };
  const routes = routesFor([...files]);
  const target = await resolveTarget(root, base);
  if (!target) return { summary: NO_TARGET, ranModel: false };
  try {
    const result = await audit(root, base, target, { onlyPaths: routes });
    const store = await SeoStore.open(root);
    const added = await store.applyAudit(result, "diff", { partial: true });
    const open = sortSeoFindings(store.findings().filter((finding) => finding.status === "open" && (!finding.page || routes.includes(finding.page))));
    if (!open.length) return { summary: `No SEO problems on the changed pages (${routes.join(", ")}).`, ranModel: false };
    return {
      summary: [
        `${open.length} open finding${open.length === 1 ? "" : "s"} on the changed pages (${routes.join(", ")})${added.length ? `, ${added.length} new` : ""}. Report: ${SEO_REPORT_FILE}`,
        ...open.slice(0, 8).map((finding) => `  ${describe(finding)}`),
        `Fix with /seo fix ${open[0]!.id}.`,
      ].join("\n"),
      ranModel: false,
    };
  } finally {
    await target.close?.();
  }
}

/** Parse "Name, category, location[, website]" typed after /seo cite. */
export function parseBusinessArgs(text: string): GeoBusiness | undefined {
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return undefined;
  return { name: parts[0]!, category: parts[1]!, location: parts[2]!, website: parts[3] ?? "" };
}

export async function runSeoCite(opts: { cwd: string; token?: string; args?: string; fetchImpl?: typeof fetch }): Promise<SeoRunResult> {
  const root = path.resolve(opts.cwd);
  let business = await loadBusiness(root);
  const typed = opts.args ? parseBusinessArgs(opts.args) : undefined;
  if (typed) {
    business = typed;
    await saveBusiness(root, typed);
  }
  if (!business) {
    return {
      summary: "Which business should CoderBaba check? Type /seo cite <name>, <category>, <city or area>, <website>, for example:\n  /seo cite Sweet Crumb, bakery, Ljubljana, sweetcrumb.si\nIt's saved to .coderbaba/seo.json for next time.",
      ranModel: false,
    };
  }
  if (!business.website) return { summary: "Add the site's domain so citations can be matched, for example /seo cite Sweet Crumb, bakery, Ljubljana, sweetcrumb.si", ranModel: false };
  if (!opts.token) return { summary: "AI citation checks need a free login. Type /login", ranModel: false, stopCode: "UNAUTHORIZED" };
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(`${apiBaseUrl()}/api/geo/cite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ business }),
    });
  } catch {
    throw new CoderBabaError("OFFLINE", "No internet connection. Check your network and try again.");
  }
  const payload = (await response.json().catch(() => null)) as GeoCiteResponse | unknown;
  if (!response.ok) {
    if (isErrorResponse(payload)) return { summary: payload.error.message, ranModel: false, stopCode: payload.error.code };
    return { summary: `The citation check failed (${response.status}). Try again later.`, ranModel: false };
  }
  const citations = payload as GeoCiteResponse;
  const store = await SeoStore.open(root);
  await store.saveCitations(citations);
  const cited = citations.results.filter((result) => result.cited);
  const competitors = new Map<string, number>();
  for (const result of citations.results) for (const domain of result.competitors) competitors.set(domain, (competitors.get(domain) ?? 0) + 1);
  const top = [...competitors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([domain]) => domain);
  return {
    summary: [
      `${business.name} was cited in ${cited.length} of ${citations.results.length} AI answers (${Math.round(citations.citationRate * 100)}%).`,
      top.length ? `Cited instead: ${top.join(", ")}.` : "",
      `Details are in ${SEO_REPORT_FILE}. ${citations.checksLeftToday} check${citations.checksLeftToday === 1 ? "" : "s"} left today.`,
    ]
      .filter(Boolean)
      .join("\n"),
    ranModel: false,
  };
}
