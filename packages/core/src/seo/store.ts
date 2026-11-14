import fs from "node:fs/promises";
import path from "node:path";
import type { GeoBusiness, GeoCiteResponse } from "@coderbabasi/shared";
import type { SeoAuditResult, SeoGroup, SeoIssue, SeoSeverity } from "../seo-audit.js";
import { renderSeoReport } from "./report.js";

export const SEO_REPORT_FILE = "SEO_REPORT.md";

export type SeoFindingStatus = "open" | "fixed" | "ignored";

export type SeoFinding = {
  id: string;
  code: string;
  group: SeoGroup;
  severity: SeoSeverity;
  page?: string;
  message: string;
  fix: string;
  status: SeoFindingStatus;
  source: "scan" | "diff";
  createdAt: string;
  updatedAt: string;
};

export type SeoState = {
  version: 1;
  updatedAt: string;
  baseUrl?: string;
  score?: number;
  groupScores?: Record<SeoGroup, number>;
  pages: number;
  site?: SeoAuditResult["site"];
  findings: SeoFinding[];
  citations?: GeoCiteResponse;
};

export function seoDir(root: string): string {
  return path.join(root, ".coderbaba", "seo");
}

function emptyState(): SeoState {
  return { version: 1, updatedAt: new Date().toISOString(), pages: 0, findings: [] };
}

function idNumber(id: string): number {
  const match = /^O(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function key(issue: { code: string; page?: string }): string {
  return `${issue.code}\0${issue.page ?? ""}`;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export class SeoStore {
  private constructor(
    readonly root: string,
    private state: SeoState,
  ) {}

  static async open(root: string): Promise<SeoStore> {
    const parsed = await readJson<Partial<SeoState>>(path.join(seoDir(root), "findings.json"));
    const state = parsed && Array.isArray(parsed.findings) ? { ...emptyState(), ...parsed, version: 1 as const, findings: parsed.findings } : emptyState();
    return new SeoStore(root, state);
  }

  get reportPath(): string {
    return path.join(this.root, SEO_REPORT_FILE);
  }

  snapshot(): SeoState {
    return structuredClone(this.state);
  }

  findings(): SeoFinding[] {
    return this.state.findings.slice();
  }

  get(id: string): SeoFinding | undefined {
    const wanted = id.trim().toUpperCase();
    return this.state.findings.find((finding) => finding.id === wanted);
  }

  /**
   * Merge an audit: issues seen before keep their id, new ones get the next id, and open findings on
   * audited pages that no longer appear are marked fixed.
   */
  async applyAudit(result: SeoAuditResult, source: SeoFinding["source"], opts: { partial?: boolean } = {}): Promise<SeoFinding[]> {
    const now = new Date().toISOString();
    const audited = new Set(result.pages.map((page) => page.path));
    const current = new Map(result.issues.map((issue) => [key(issue), issue]));
    const added: SeoFinding[] = [];
    for (const finding of this.state.findings) {
      const issue = current.get(key(finding));
      if (issue) {
        if (finding.status === "fixed") finding.status = "open";
        finding.message = issue.message;
        finding.fix = issue.fix;
        finding.severity = issue.severity;
        finding.updatedAt = now;
        current.delete(key(finding));
      } else if (finding.status === "open" && (finding.page ? audited.has(finding.page) : !opts.partial)) {
        finding.status = "fixed";
        finding.updatedAt = now;
      }
    }
    let next = Math.max(0, ...this.state.findings.map((finding) => idNumber(finding.id))) + 1;
    for (const issue of current.values()) {
      const finding = this.create(issue, source, next++, now);
      this.state.findings.push(finding);
      added.push(finding);
    }
    if (!opts.partial) {
      this.state.baseUrl = result.baseUrl;
      this.state.score = result.score;
      this.state.groupScores = result.groupScores;
      this.state.pages = result.pages.length;
      this.state.site = result.site;
    }
    await this.save();
    return added;
  }

  private create(issue: SeoIssue, source: SeoFinding["source"], n: number, now: string): SeoFinding {
    return { id: `O${n}`, code: issue.code, group: issue.group, severity: issue.severity, page: issue.page, message: issue.message, fix: issue.fix, status: "open", source, createdAt: now, updatedAt: now };
  }

  async setStatus(id: string, status: SeoFindingStatus): Promise<SeoFinding | undefined> {
    const finding = this.get(id);
    if (!finding) return undefined;
    finding.status = status;
    finding.updatedAt = new Date().toISOString();
    await this.save();
    return finding;
  }

  async saveCitations(citations: GeoCiteResponse): Promise<void> {
    this.state.citations = citations;
    await this.save();
  }

  async save(): Promise<void> {
    const dir = seoDir(this.root);
    await fs.mkdir(dir, { recursive: true });
    const ignore = path.join(dir, ".gitignore");
    try {
      await fs.access(ignore);
    } catch {
      await fs.writeFile(ignore, "*\n");
    }
    this.state.updatedAt = new Date().toISOString();
    await fs.writeFile(path.join(dir, "findings.json"), `${JSON.stringify(this.state, null, 2)}\n`);
    await fs.writeFile(this.reportPath, renderSeoReport(this.state));
  }
}

const BUSINESS_FILE = "seo.json";

/** Business details for citation checks: site.json first, then .coderbaba/seo.json. */
export async function loadBusiness(root: string): Promise<GeoBusiness | undefined> {
  const site = await readJson<Record<string, unknown>>(path.join(root, "site.json"));
  if (site) {
    const location = site.location as Record<string, unknown> | string | undefined;
    const business = {
      name: String(site.name ?? ""),
      category: String(site.category ?? ""),
      location: typeof location === "string" ? location : String(location?.city ?? location?.area ?? ""),
      website: String(site.domain ?? site.website ?? site.url ?? ""),
    };
    if (business.name && business.category && business.location) return business;
  }
  const saved = await readJson<GeoBusiness>(path.join(root, ".coderbaba", BUSINESS_FILE));
  return saved?.name && saved.category && saved.location ? saved : undefined;
}

export async function saveBusiness(root: string, business: GeoBusiness): Promise<void> {
  const dir = path.join(root, ".coderbaba");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, BUSINESS_FILE), `${JSON.stringify(business, null, 2)}\n`);
}
