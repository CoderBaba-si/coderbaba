import { groupLabel, type SeoGroup, type SeoSeverity } from "../seo-audit.js";
import type { SeoFinding, SeoState } from "./store.js";

const SEVERITY_ORDER: Record<SeoSeverity, number> = { error: 0, warning: 1, info: 2 };
const GROUPS: SeoGroup[] = ["search", "ai", "performance", "accessibility"];

export function sortSeoFindings(findings: SeoFinding[]): SeoFinding[] {
  return findings
    .slice()
    .sort(
      (a, b) =>
        Number(b.code === "client-rendered") - Number(a.code === "client-rendered") ||
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        Number(a.id.slice(1)) - Number(b.id.slice(1)),
    );
}

function block(finding: SeoFinding): string {
  return [`### ${finding.id}: ${finding.message}`, "", `**${finding.severity}** · \`${finding.page ?? "whole site"}\`${finding.source === "diff" ? " · from diff review" : ""}`, "", `**Fix:** ${finding.fix}`].join("\n");
}

export function renderSeoReport(state: SeoState): string {
  const open = sortSeoFindings(state.findings.filter((finding) => finding.status === "open"));
  const fixed = state.findings.filter((finding) => finding.status === "fixed").length;
  const out = [
    "# SEO report",
    "",
    `Written by CoderBaba on ${state.updatedAt.slice(0, 16).replace("T", " ")} UTC${state.baseUrl ? ` for ${state.baseUrl}` : ""}. It covers search engines (SEO), AI answers such as ChatGPT, Perplexity and Google AI Overviews (GEO and AEO), performance, and accessibility.`,
    "",
    "## Summary",
    "",
  ];
  if (state.score !== undefined && state.groupScores) {
    out.push(`Score: **${state.score}/100** across ${state.pages} page${state.pages === 1 ? "" : "s"}.`, "");
    out.push(GROUPS.map((group) => `- ${groupLabel(group)}: ${state.groupScores![group]}/100`).join("\n"), "");
  }
  out.push(open.length ? `${open.length} open finding${open.length === 1 ? "" : "s"}${fixed ? `, ${fixed} fixed` : ""}.` : "No open findings.");
  if (open.length) out.push("", "Next: `/seo fix <id>` to fix one, starting with the first below.");
  if (state.site) {
    out.push(
      "",
      "## Crawlers",
      "",
      `- robots.txt: ${state.site.robots ? "found" : "missing"}`,
      `- sitemap.xml: ${state.site.sitemap ? "found" : "missing"}`,
      `- llms.txt: ${state.site.llmsTxt ? "found" : "missing"}`,
      `- AI crawlers blocked: ${state.site.blockedAiCrawlers.length ? state.site.blockedAiCrawlers.join(", ") : "none"}`,
    );
  }
  for (const group of GROUPS) {
    const list = open.filter((finding) => finding.group === group);
    if (list.length) out.push("", `## ${groupLabel(group)}`, "", list.map(block).join("\n\n"));
  }
  if (state.citations) {
    const { results, citationRate, checkedAt } = state.citations;
    out.push("", "## AI citations", "", `Checked ${checkedAt.slice(0, 16).replace("T", " ")} UTC. Cited in ${Math.round(citationRate * 100)}% of answers.`, "");
    out.push("| Question | Engine | Cited | Cited instead |", "| --- | --- | --- | --- |");
    for (const result of results) {
      out.push(`| ${result.prompt.replace(/\|/g, "/")} | ${result.engine} | ${result.cited ? `yes${result.position ? ` (#${result.position})` : ""}` : "no"} | ${result.competitors.slice(0, 3).join(", ") || "-"} |`);
    }
  }
  out.push("", "This audit is automated. Rankings also depend on things it can't see, such as links from other sites, reviews, and competition.");
  return `${out.join("\n")}\n`;
}

export function seoStatusTable(findings: SeoFinding[]): string {
  const open = sortSeoFindings(findings.filter((finding) => finding.status === "open"));
  if (!open.length) return findings.length ? "No open SEO findings." : "No findings yet. Type /seo to audit this site.";
  return open.map((finding) => `${finding.id.padEnd(4)} ${finding.severity.padEnd(8)} ${groupLabel(finding.group).padEnd(14)} ${(finding.page ?? "site").padEnd(18)} ${finding.message}`).join("\n");
}
