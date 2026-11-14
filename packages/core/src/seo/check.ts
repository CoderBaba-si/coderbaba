import path from "node:path";
import type { BrowserSession } from "../browser.js";
import type { ProcessManager } from "../processes.js";
import { auditErrors, runSeoAudit, type SeoAuditResult, type SeoIssue } from "../seo-audit.js";
import { PAGE_FILE, isWebsiteProject, routesFor, runningSiteUrl } from "./routes.js";

const CHECK_MAX_PAGES = 10;

export type SeoCheckResult = { url: string; result: SeoAuditResult; failures: SeoIssue[] };

/** Issues that fail the automatic check. Outside website projects only clear search errors count, so normal apps aren't nagged. */
export function blockingIssues(result: SeoAuditResult, website: boolean): SeoIssue[] {
  const errors = auditErrors(result);
  if (website) return errors;
  return errors.filter((issue) => issue.group === "search" && issue.code !== "noindex" && issue.code !== "unreachable");
}

/** Audit the pages behind the edited files on the running dev server. Undefined when nothing applies. */
export async function runSeoCheck(opts: {
  root: string;
  editedFiles: string[];
  processes?: ProcessManager;
  browser?: BrowserSession;
  onProgress?: (text: string) => void;
}): Promise<SeoCheckResult | undefined> {
  const rel = opts.editedFiles.map((file) => path.relative(opts.root, file).split(path.sep).join("/")).filter((file) => !file.startsWith(".."));
  const website = isWebsiteProject(opts.root);
  if (!rel.some((file) => PAGE_FILE.test(file) || (website && /(?:^|\/)site\.json$/.test(file)))) return undefined;
  const url = runningSiteUrl(opts.processes);
  if (!url) return undefined;
  const browser = await opts.browser?.get();
  const result = await runSeoAudit({
    baseUrl: url,
    onlyPaths: routesFor(rel),
    maxPages: CHECK_MAX_PAGES,
    browser,
    accessibility: Boolean(browser),
    strictRendering: website,
    onProgress: opts.onProgress,
  });
  return { url, result, failures: blockingIssues(result, website) };
}

export function seoFailureMessage(check: SeoCheckResult): string {
  const lines = check.failures.slice(0, 20).map((issue) => `- ${issue.page ?? "site"}: ${issue.message} Fix: ${issue.fix}`);
  return `The SEO and accessibility check found problems on ${check.url} after your edits:\n${lines.join("\n")}\n\nFix them, then finish. The check runs again automatically.`;
}
