import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SeoAuditResult, SeoIssue } from "../seo-audit.js";
import { parseBusinessArgs } from "./scan.js";
import { SEO_REPORT_FILE, SeoStore, loadBusiness } from "./store.js";

function result(issues: SeoIssue[], paths = ["/", "/about"]): SeoAuditResult {
  return {
    baseUrl: "http://127.0.0.1:4321",
    checkedAt: new Date().toISOString(),
    pages: paths.map((p) => ({ path: p }) as SeoAuditResult["pages"][number]),
    issues,
    score: 80,
    groupScores: { search: 80, ai: 90, performance: 100, accessibility: 100 },
    site: { robots: true, sitemap: false, llmsTxt: false, blockedAiCrawlers: [] },
  };
}

const h1: SeoIssue = { code: "missing-h1", group: "search", severity: "error", page: "/about", message: "No H1.", fix: "Add one." };
const llms: SeoIssue = { code: "missing-llms-txt", group: "ai", severity: "info", message: "No llms.txt.", fix: "Add it." };

describe("SeoStore", () => {
  it("keeps ids across scans and marks issues that disappeared as fixed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-seo-"));
    const store = await SeoStore.open(root);
    const added = await store.applyAudit(result([h1, llms]), "scan");
    expect(added.map((finding) => finding.id)).toEqual(["O1", "O2"]);

    await store.applyAudit(result([llms]), "scan");
    expect(store.get("O1")?.status).toBe("fixed");
    expect(store.get("o2")?.status).toBe("open");

    const reopened = await SeoStore.open(root);
    expect(reopened.findings()).toHaveLength(2);
    expect(await fs.readFile(path.join(root, SEO_REPORT_FILE), "utf8")).toContain("O2: No llms.txt.");
  });

  it("leaves pages outside a partial audit alone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-seo-"));
    const store = await SeoStore.open(root);
    await store.applyAudit(result([h1, llms]), "scan");
    await store.applyAudit(result([], ["/"]), "diff", { partial: true });
    expect(store.get("O1")?.status).toBe("open");
    expect(store.get("O2")?.status).toBe("open");
  });
});

describe("business details", () => {
  it("parses /seo cite arguments and reads site.json", async () => {
    expect(parseBusinessArgs("Sweet Crumb, bakery, Ljubljana, sweetcrumb.si")).toEqual({ name: "Sweet Crumb", category: "bakery", location: "Ljubljana", website: "sweetcrumb.si" });
    expect(parseBusinessArgs("just a name")).toBeUndefined();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-seo-"));
    await fs.writeFile(path.join(root, "site.json"), JSON.stringify({ name: "Bloom", category: "florist", location: { city: "Maribor" }, domain: "bloom.si" }));
    expect(await loadBusiness(root)).toEqual({ name: "Bloom", category: "florist", location: "Maribor", website: "bloom.si" });
  });
});
