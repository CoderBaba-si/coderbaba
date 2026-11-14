import { createRequire } from "node:module";
import fs from "node:fs/promises";
import type { Browser, Page } from "playwright-core";

export type SeoSeverity = "error" | "warning" | "info";
export type SeoGroup = "search" | "ai" | "performance" | "accessibility";

export type SeoIssue = {
  code: string;
  group: SeoGroup;
  severity: SeoSeverity;
  /** Page path such as /about, or undefined for site-wide issues. */
  page?: string;
  message: string;
  fix: string;
};

export type PageFacts = {
  url: string;
  path: string;
  status?: number;
  title: string;
  description: string;
  canonical?: string;
  robots: string;
  lang: string;
  h1: string[];
  h2: string[];
  questionHeadings: number;
  wordCount: number;
  /** Words visible after JavaScript ran, when a browser rendered the page. */
  renderedWordCount?: number;
  imagesWithoutAlt: string[];
  imagesWithoutSize: number;
  internalLinks: string[];
  externalLinks: string[];
  jsonLdTypes: string[];
  jsonLdErrors: string[];
  hasViewport: boolean;
  hasOpenGraph: boolean;
  passwordFields: number;
  formActions: string[];
  blockingScripts: number;
  htmlBytes: number;
  loadMs?: number;
};

export type SeoAuditResult = {
  baseUrl: string;
  checkedAt: string;
  pages: PageFacts[];
  issues: SeoIssue[];
  score: number;
  groupScores: Record<SeoGroup, number>;
  site: { robots: boolean; sitemap: boolean; llmsTxt: boolean; blockedAiCrawlers: string[] };
};

export type FetchText = (url: string) => Promise<{ status: number; text: string; contentType: string } | null>;

export type SeoAuditOptions = {
  baseUrl: string;
  /** Extra paths to audit besides the ones found by crawling, such as changed pages. */
  paths?: string[];
  /** Audit only these paths instead of crawling. */
  onlyPaths?: string[];
  maxPages?: number;
  browser?: Browser;
  accessibility?: boolean;
  fetchText?: FetchText;
  /** Treat client-rendered pages as errors (website projects) instead of warnings. */
  strictRendering?: boolean;
  onProgress?: (text: string) => void;
};

export const AI_CRAWLERS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot", "Google-Extended"] as const;

const MIN_WORDS = 150;
const CSR_RATIO = 3;
const MAX_TITLE = 60;
const MAX_DESCRIPTION = 160;
const MIN_DESCRIPTION = 50;
const SLOW_LOAD_MS = 3_000;
const HEAVY_HTML = 500_000;
const DEFAULT_MAX_PAGES = 30;
const FETCH_TIMEOUT_MS = 15_000;

const GROUP_LABEL: Record<SeoGroup, string> = {
  search: "Search",
  ai: "AI answers",
  performance: "Performance",
  accessibility: "Accessibility",
};

export function groupLabel(group: SeoGroup): string {
  return GROUP_LABEL[group];
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (!match) return undefined;
  return decode(match[1] ?? match[2] ?? match[3] ?? "");
}

function tags(html: string, name: string): string[] {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];
}

function inner(html: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "gi");
  for (let match = re.exec(html); match; match = re.exec(html)) out.push(decode(match[1]!.replace(/<[^>]+>/g, " ")));
  return out;
}

function meta(html: string, key: string, by: "name" | "property" = "name"): string | undefined {
  for (const tag of tags(html, "meta")) {
    if (attr(tag, by)?.toLowerCase() === key) return attr(tag, "content") ?? "";
  }
  return undefined;
}

/** Visible text: scripts, styles, templates, and tags removed. */
export function visibleText(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return decode(
    body
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function words(text: string): number {
  return text ? text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length : 0;
}

function jsonLd(html: string): { types: string[]; errors: string[] } {
  const types: string[] = [];
  const errors: string[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      const collect = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") {
          const record = value as Record<string, unknown>;
          if (record["@graph"]) collect(record["@graph"]);
          const type = record["@type"];
          if (typeof type === "string") types.push(type);
          else if (Array.isArray(type)) types.push(...type.filter((item): item is string => typeof item === "string"));
          else if (!record["@graph"]) errors.push("a JSON-LD block has no @type");
        }
      };
      collect(parsed);
    } catch {
      errors.push("a JSON-LD block is not valid JSON");
    }
  }
  return { types, errors };
}

/** Contact, legal and confirmation pages are short by nature, so they aren't flagged as thin. */
const UTILITY_PAGE = /\/(contact|kontakt|privacy|terms|imprint|impressum|legal|cookies|accessibility|thanks|thank-you|rsvp|login|cart|checkout|404)(\/|$)/i;

function normalizePath(url: URL): string {
  const path = url.pathname.replace(/\/index\.html?$/i, "/");
  return path.length > 1 ? path.replace(/\/$/, "") : "/";
}

/** Facts about one page from its HTML as served, before any JavaScript runs. */
export function analyzeHtml(pageUrl: string, html: string, status?: number): PageFacts {
  const url = new URL(pageUrl);
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
  const internal = new Set<string>();
  const external = new Set<string>();
  for (const tag of tags(html, "a")) {
    const href = attr(tag, "href");
    if (!href || /^(?:#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let target: URL;
    try {
      target = new URL(href, url);
    } catch {
      continue;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") continue;
    if (target.origin === url.origin) internal.add(normalizePath(target));
    else external.add(target.href);
  }
  const images = tags(html, "img");
  const ld = jsonLd(html);
  const h2 = inner(html, "h2");
  const h3 = inner(html, "h3");
  const headTags = tags(head, "script");
  return {
    url: url.href,
    path: normalizePath(url),
    status,
    title: inner(head || html, "title")[0] ?? "",
    description: meta(html, "description") ?? "",
    canonical: tags(html, "link").map((tag) => (attr(tag, "rel")?.toLowerCase() === "canonical" ? attr(tag, "href") : undefined)).find(Boolean),
    robots: (meta(html, "robots") ?? "").toLowerCase(),
    lang: attr(tags(html, "html")[0] ?? "", "lang") ?? "",
    h1: inner(html, "h1"),
    h2,
    questionHeadings: [...h2, ...h3].filter((heading) => /\?\s*$/.test(heading) || /^(?:how|what|why|when|where|who|which|can|do|does|is|are|should)\b/i.test(heading)).length,
    wordCount: words(visibleText(html)),
    imagesWithoutAlt: images.filter((tag) => attr(tag, "alt") === undefined).map((tag) => attr(tag, "src") ?? "(no src)"),
    imagesWithoutSize: images.filter((tag) => !attr(tag, "width") || !attr(tag, "height")).length,
    internalLinks: [...internal],
    externalLinks: [...external],
    jsonLdTypes: ld.types,
    jsonLdErrors: ld.errors,
    hasViewport: meta(html, "viewport") !== undefined,
    hasOpenGraph: meta(html, "og:title", "property") !== undefined,
    passwordFields: tags(html, "input").filter((tag) => attr(tag, "type")?.toLowerCase() === "password").length,
    formActions: tags(html, "form").map((tag) => attr(tag, "action") ?? ""),
    blockingScripts: headTags.filter((tag) => attr(tag, "src") && !/\s(?:defer|async)\b/i.test(tag) && attr(tag, "type") !== "module").length,
    htmlBytes: Buffer.byteLength(html),
  };
}

/** User agents that robots.txt blocks from the whole site. */
export function blockedCrawlers(robotsTxt: string, agents: readonly string[] = AI_CRAWLERS): string[] {
  const groups: { agents: string[]; disallowAll: boolean; allowAll: boolean }[] = [];
  let current: { agents: string[]; disallowAll: boolean; allowAll: boolean } | undefined;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallowAll: false, allowAll: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "disallow" && value === "/") current.disallowAll = true;
    if (key === "allow" && value === "/") current.allowAll = true;
  }
  const wildcard = groups.find((group) => group.agents.includes("*"));
  return agents.filter((agent) => {
    const own = groups.find((group) => group.agents.includes(agent.toLowerCase()));
    const rules = own ?? wildcard;
    return Boolean(rules && rules.disallowAll && !rules.allowAll);
  });
}

function pageIssues(page: PageFacts, strictRendering: boolean): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const add = (issue: Omit<SeoIssue, "page">) => issues.push({ ...issue, page: page.path });
  if (page.status !== undefined && page.status >= 400) {
    add({ code: "http-error", group: "search", severity: "error", message: `The page returns HTTP ${page.status}.`, fix: "Fix the route or remove links to it." });
    return issues;
  }
  if (page.renderedWordCount !== undefined && page.renderedWordCount >= MIN_WORDS && page.wordCount * CSR_RATIO < page.renderedWordCount) {
    add({
      code: "client-rendered",
      group: "ai",
      severity: strictRendering ? "error" : "warning",
      message: `Only ${page.wordCount} words are in the HTML before JavaScript runs, out of ${page.renderedWordCount} on the finished page. Most AI crawlers and some search crawlers don't run JavaScript, so they see an almost empty page.`,
      fix: "Render the content on the server or at build time (static generation, SSR, or a framework such as Astro or Next.js with server components).",
    });
  }
  if (!page.title) add({ code: "missing-title", group: "search", severity: "error", message: "The page has no <title>.", fix: "Add a unique title of 30 to 60 characters that names the page topic and the business." });
  else if (page.title.length > MAX_TITLE) add({ code: "long-title", group: "search", severity: "warning", message: `The title is ${page.title.length} characters, so search results cut it off.`, fix: `Shorten it to ${MAX_TITLE} characters or fewer.` });
  if (!page.description) add({ code: "missing-description", group: "search", severity: "warning", message: "The page has no meta description.", fix: "Add a meta description of 50 to 160 characters that answers what the page offers." });
  else if (page.description.length > MAX_DESCRIPTION || page.description.length < MIN_DESCRIPTION) {
    add({ code: "description-length", group: "search", severity: "info", message: `The meta description is ${page.description.length} characters.`, fix: `Aim for ${MIN_DESCRIPTION} to ${MAX_DESCRIPTION} characters.` });
  }
  if (page.h1.length === 0) add({ code: "missing-h1", group: "search", severity: "error", message: "The page has no H1 heading.", fix: "Add exactly one H1 that states the main topic of the page." });
  else if (page.h1.length > 1) add({ code: "multiple-h1", group: "search", severity: "warning", message: `The page has ${page.h1.length} H1 headings.`, fix: "Keep one H1 and turn the others into H2s." });
  if (/\bnoindex\b/.test(page.robots)) add({ code: "noindex", group: "search", severity: "error", message: "The page tells search engines not to index it (robots noindex).", fix: "Remove noindex unless the page should stay out of search." });
  if (!page.canonical) add({ code: "missing-canonical", group: "search", severity: "info", message: "The page has no canonical URL.", fix: "Add <link rel=\"canonical\"> with the page's full preferred URL." });
  if (!page.lang) add({ code: "missing-lang", group: "accessibility", severity: "warning", message: "The <html> tag has no lang attribute.", fix: "Set lang to the page language, such as lang=\"en\"." });
  if (!page.hasViewport) add({ code: "missing-viewport", group: "performance", severity: "warning", message: "The page has no viewport meta tag, so phones show a zoomed-out desktop layout.", fix: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">." });
  if (!page.hasOpenGraph) add({ code: "missing-open-graph", group: "search", severity: "info", message: "The page has no Open Graph tags, so shared links show no preview.", fix: "Add og:title, og:description, og:image and og:url." });
  if (page.imagesWithoutAlt.length) {
    add({
      code: "image-alt",
      group: "accessibility",
      severity: "warning",
      message: `${page.imagesWithoutAlt.length} image${page.imagesWithoutAlt.length === 1 ? " has" : "s have"} no alt text (${page.imagesWithoutAlt.slice(0, 3).join(", ")}).`,
      fix: "Describe each image in its alt attribute, or use alt=\"\" for purely decorative images.",
    });
  }
  if (page.imagesWithoutSize) add({ code: "image-size", group: "performance", severity: "info", message: `${page.imagesWithoutSize} image${page.imagesWithoutSize === 1 ? " has" : "s have"} no width and height, which makes the layout jump while loading.`, fix: "Set width and height on images, or use the framework's image component." });
  for (const error of page.jsonLdErrors) add({ code: "invalid-json-ld", group: "ai", severity: "error", message: `Structured data is broken: ${error}.`, fix: "Fix the JSON-LD so it parses and every item has an @type." });
  if (!page.jsonLdTypes.length && page.path === "/") add({ code: "missing-json-ld", group: "ai", severity: "warning", message: "The home page has no structured data (JSON-LD).", fix: "Add JSON-LD for the business (LocalBusiness or Organization) and the WebSite." });
  const words = Math.max(page.wordCount, page.renderedWordCount ?? 0);
  if (words < MIN_WORDS && !UTILITY_PAGE.test(page.path)) add({ code: "thin-content", group: "search", severity: "warning", message: `The page has only ${words} words.`, fix: `Add useful, specific content (at least ${MIN_WORDS} words) that answers what visitors want to know.` });
  if (words >= 300 && page.questionHeadings === 0) add({ code: "no-question-headings", group: "ai", severity: "info", message: "No headings are phrased as questions, so AI answers have nothing to match against.", fix: "Phrase some H2s as the questions customers ask, with a short direct answer right below each." });
  if (page.blockingScripts) add({ code: "blocking-scripts", group: "performance", severity: "info", message: `${page.blockingScripts} script${page.blockingScripts === 1 ? "" : "s"} in <head> block rendering.`, fix: "Add defer or async to scripts in <head>, or move them to the end of <body>." });
  if (page.htmlBytes > HEAVY_HTML) add({ code: "heavy-html", group: "performance", severity: "warning", message: `The HTML is ${Math.round(page.htmlBytes / 1000)} KB.`, fix: "Move inline data and large inline scripts out of the HTML." });
  if (page.loadMs !== undefined && page.loadMs > SLOW_LOAD_MS) add({ code: "slow-load", group: "performance", severity: "warning", message: `The page took ${(page.loadMs / 1000).toFixed(1)} seconds to load.`, fix: "Compress images, remove unused scripts, and lazy-load what's below the fold." });
  return issues;
}

function siteIssues(pages: PageFacts[], site: SeoAuditResult["site"]): SeoIssue[] {
  const issues: SeoIssue[] = [];
  if (!site.robots) issues.push({ code: "missing-robots", group: "search", severity: "warning", message: "There is no robots.txt.", fix: "Add robots.txt that allows crawling and points to the sitemap." });
  if (!site.sitemap) issues.push({ code: "missing-sitemap", group: "search", severity: "warning", message: "There is no sitemap.xml.", fix: "Generate sitemap.xml listing every public page, and reference it in robots.txt." });
  if (!site.llmsTxt) issues.push({ code: "missing-llms-txt", group: "ai", severity: "info", message: "There is no llms.txt.", fix: "Add /llms.txt: a short Markdown summary of the business and links to its key pages, for AI assistants." });
  if (site.blockedAiCrawlers.length) {
    issues.push({
      code: "ai-crawlers-blocked",
      group: "ai",
      severity: "warning",
      message: `robots.txt blocks ${site.blockedAiCrawlers.join(", ")}, so those AI tools can't read or cite the site.`,
      fix: "Allow AI search crawlers in robots.txt unless you deliberately opted out.",
    });
  }
  for (const [field, code, label] of [
    ["title", "duplicate-title", "title"],
    ["description", "duplicate-description", "meta description"],
  ] as const) {
    const seen = new Map<string, string[]>();
    for (const page of pages) {
      const value = page[field].trim().toLowerCase();
      if (value) seen.set(value, [...(seen.get(value) ?? []), page.path]);
    }
    for (const paths of seen.values()) {
      if (paths.length > 1) issues.push({ code, group: "search", severity: "warning", page: paths[0], message: `${paths.length} pages share the same ${label}: ${paths.slice(0, 4).join(", ")}.`, fix: `Give each page its own ${label}.` });
    }
  }
  return issues;
}

export function scoreIssues(issues: SeoIssue[]): { score: number; groupScores: Record<SeoGroup, number> } {
  const penalty = (list: SeoIssue[]) => list.reduce((sum, issue) => sum + (issue.severity === "error" ? 12 : issue.severity === "warning" ? 4 : 1), 0);
  const groupScores = Object.fromEntries(
    (Object.keys(GROUP_LABEL) as SeoGroup[]).map((group) => [group, Math.max(0, 100 - penalty(issues.filter((issue) => issue.group === group)))]),
  ) as Record<SeoGroup, number>;
  return { score: Math.max(0, 100 - penalty(issues)), groupScores };
}

const defaultFetch: FetchText = async (url) => {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "CoderBaba-SEO-Audit/1.0" } });
    return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") ?? "" };
  } catch {
    return null;
  }
};

let axeSource: string | undefined;
async function loadAxe(): Promise<string | undefined> {
  if (axeSource !== undefined) return axeSource;
  try {
    axeSource = await fs.readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    axeSource = "";
  }
  return axeSource || undefined;
}

type AxeViolation = { id: string; impact?: string | null; help: string; helpUrl: string; nodes: unknown[] };

/** One Tab press: which element got focus, and whether its look changed compared with unfocused. */
export type TabStep = { id: string; label: string; visibleFocus: boolean };
export type KeyboardResult = { trappedAt?: string; noFocusStyle: string[]; checked: number };

/**
 * Focus is trapped when Tab keeps landing on elements already visited, other than wrapping back to
 * the first one, before every focusable element was reached (menus that never release focus).
 */
export function analyzeTabWalk(steps: TabStep[], focusableCount: number): KeyboardResult {
  const seen = new Set<string>();
  let trappedAt: string | undefined;
  let repeats = 0;
  let loopStart = "";
  for (const step of steps) {
    if (step.id === "body") continue;
    if (seen.has(step.id)) {
      if (step.id === steps.find((s) => s.id !== "body")?.id) break;
      if (repeats === 0) loopStart = step.label;
      repeats += 1;
      if (repeats >= 2 && seen.size < focusableCount) {
        trappedAt = loopStart;
        break;
      }
      continue;
    }
    repeats = 0;
    seen.add(step.id);
  }
  const unique = new Map(steps.filter((s) => s.id !== "body").map((s) => [s.id, s]));
  return { trappedAt, noFocusStyle: [...unique.values()].filter((s) => !s.visibleFocus).map((s) => s.label), checked: unique.size };
}

const MAX_TABS = 40;

async function walkKeyboard(page: Page): Promise<KeyboardResult> {
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  const focusable = await page.evaluate(() => {
    const nodes = document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex='-1'])");
    let count = 0;
    nodes.forEach((node) => {
      const el = node as HTMLElement;
      if (!el.hasAttribute("disabled") && el.offsetParent !== null) count += 1;
    });
    return count;
  });
  const steps: TabStep[] = [];
  for (let i = 0; i < Math.min(MAX_TABS, focusable + 2); i++) {
    await page.keyboard.press("Tab");
    steps.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return { id: "body", label: "body", visibleFocus: true };
        if (!el.dataset.cbTab) el.dataset.cbTab = String(Math.random()).slice(2);
        const look = () => {
          const s = getComputedStyle(el);
          return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.backgroundColor, s.borderColor, s.color, s.textDecorationLine].join("|");
        };
        const focused = look();
        el.blur();
        const unfocused = look();
        el.focus();
        const text = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
        return { id: el.dataset.cbTab, label: `${el.tagName.toLowerCase()} "${text}"`, visibleFocus: focused !== unfocused };
      }),
    );
  }
  return analyzeTabWalk(steps, focusable);
}

export function keyboardIssues(page: string, result: KeyboardResult): SeoIssue[] {
  const issues: SeoIssue[] = [];
  if (result.trappedAt) {
    issues.push({ code: "a11y-keyboard-trap", group: "accessibility", severity: "error", page, message: `Keyboard focus gets stuck at ${result.trappedAt}; people using Tab can't reach the rest of the page.`, fix: "Let Tab move out of menus and dialogs, and close them with Escape." });
  }
  if (result.noFocusStyle.length) {
    const all = result.noFocusStyle.length === result.checked;
    issues.push({
      code: "a11y-focus-visible",
      group: "accessibility",
      severity: all ? "error" : "warning",
      page,
      message: `${all ? "No" : `${result.noFocusStyle.length} of ${result.checked}`} links and buttons show where keyboard focus is${all ? "" : ` (for example ${result.noFocusStyle.slice(0, 2).join(", ")})`}.`,
      fix: "Add a visible :focus-visible style, such as a 2px outline in the accent color, and don't remove outlines without a replacement.",
    });
  }
  return issues;
}

async function renderPage(browser: Browser, url: string, accessibility: boolean): Promise<{ words: number; loadMs?: number; violations: AxeViolation[]; keyboard?: KeyboardResult } | undefined> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const started = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: FETCH_TIMEOUT_MS });
    const loadMs = Date.now() - started;
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const html = await page.content();
    let violations: AxeViolation[] = [];
    const source = accessibility ? await loadAxe() : undefined;
    if (source) {
      await page.addScriptTag({ content: source });
      violations = (await page.evaluate(async () => {
        const axe = (globalThis as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
        const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
        return result.violations.map((violation) => ({ id: violation.id, impact: violation.impact, help: violation.help, helpUrl: violation.helpUrl, nodes: violation.nodes.slice(0, 3) }));
      })) as AxeViolation[];
    }
    const keyboard = accessibility ? await walkKeyboard(page).catch(() => undefined) : undefined;
    return { words: words(visibleText(html)), loadMs, violations, keyboard };
  } catch {
    return undefined;
  } finally {
    await context.close().catch(() => undefined);
  }
}

function axeIssue(page: string, violation: AxeViolation): SeoIssue {
  const serious = violation.impact === "critical" || violation.impact === "serious";
  return {
    code: `a11y-${violation.id}`,
    group: "accessibility",
    severity: serious ? "error" : "warning",
    page,
    message: `${violation.help} (${violation.nodes.length}${violation.nodes.length >= 3 ? "+" : ""} element${violation.nodes.length === 1 ? "" : "s"}).`,
    fix: `See ${violation.helpUrl}`,
  };
}

/** Crawl a site from its base URL and audit each page for search, AI answers, performance, and accessibility. */
const MAX_SITEMAPS = 6;

/**
 * Finds sitemaps the way search engines do: `Sitemap:` lines in robots.txt, then /sitemap.xml and
 * /sitemap-index.xml, following sitemap indexes. Locations on the sitemap's own host map to local
 * paths, so a production sitemap still works when auditing a locally served build.
 */
export async function findSitemapUrls(origin: string, robotsTxt: string, fetchText: FetchText): Promise<{ found: boolean; paths: string[] }> {
  const declared = [...robotsTxt.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((match) => match[1]!);
  const hosts = new Set([new URL(origin).host]);
  const toLocal = (raw: string): string | undefined => {
    try {
      const url = new URL(raw, origin);
      return hosts.has(url.host) ? `${origin}${url.pathname}${url.search}` : undefined;
    } catch {
      return undefined;
    }
  };
  for (const raw of declared) {
    try {
      hosts.add(new URL(raw).host);
    } catch {
      // ignore malformed lines
    }
  }
  const queue = [...declared.map(toLocal).filter((url): url is string => Boolean(url)), `${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`];
  const seen = new Set<string>();
  const paths: string[] = [];
  let found = false;
  while (queue.length && seen.size < MAX_SITEMAPS) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const response = await fetchText(url);
    if (!response || response.status >= 400 || !/<(?:urlset|sitemapindex)\b/i.test(response.text)) continue;
    found = true;
    const isIndex = /<sitemapindex\b/i.test(response.text);
    for (const match of response.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const local = toLocal(match[1]!.replace(/&amp;/g, "&"));
      if (!local) continue;
      if (isIndex) queue.push(local);
      else paths.push(normalizePath(new URL(local)));
    }
    if (!isIndex && declared.length === 0) break;
  }
  return { found, paths };
}

export async function runSeoAudit(opts: SeoAuditOptions): Promise<SeoAuditResult> {
  const fetchText = opts.fetchText ?? defaultFetch;
  const base = new URL(opts.baseUrl);
  const origin = base.origin;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const queue: string[] = opts.onlyPaths?.length ? [...opts.onlyPaths] : [normalizePath(base), ...(opts.paths ?? [])];
  const crawl = !opts.onlyPaths?.length;
  const seen = new Set<string>();
  const linkedFrom = new Map<string, string>();
  const broken = new Set<string>();
  const pages: PageFacts[] = [];
  const issues: SeoIssue[] = [];

  const [robots, llms] = await Promise.all([fetchText(`${origin}/robots.txt`), fetchText(`${origin}/llms.txt`)]);
  const found = (result: Awaited<ReturnType<FetchText>>) => Boolean(result && result.status < 400 && result.text.trim() && !/<html/i.test(result.text.slice(0, 500)));
  const sitemap = await findSitemapUrls(origin, found(robots) ? robots!.text : "", fetchText);
  const site: SeoAuditResult["site"] = {
    robots: found(robots),
    sitemap: sitemap.found,
    llmsTxt: found(llms),
    blockedAiCrawlers: found(robots) ? blockedCrawlers(robots!.text) : [],
  };
  if (crawl) queue.push(...sitemap.paths);

  while (queue.length && pages.length < maxPages) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const url = `${origin}${path}`;
    opts.onProgress?.(`checking ${path}`);
    const response = await fetchText(url);
    if (!response) {
      issues.push({ code: "unreachable", group: "search", severity: "error", page: path, message: "The page could not be loaded.", fix: "Make sure the server is running and the route exists." });
      continue;
    }
    const referrer = linkedFrom.get(path);
    if (referrer && response.status >= 400) {
      broken.add(path);
      issues.push({ code: "broken-link", group: "search", severity: "error", page: referrer, message: `The link to ${path} is broken (HTTP ${response.status}).`, fix: "Fix the link target or remove the link." });
      continue;
    }
    if (response.contentType && !/html/i.test(response.contentType)) continue;
    const facts = analyzeHtml(url, response.text, response.status);
    if (opts.browser && response.status < 400) {
      const rendered = await renderPage(opts.browser, url, opts.accessibility ?? true);
      if (rendered) {
        facts.renderedWordCount = rendered.words;
        facts.loadMs = rendered.loadMs;
        for (const violation of rendered.violations) issues.push(axeIssue(path, violation));
        if (rendered.keyboard) issues.push(...keyboardIssues(path, rendered.keyboard));
      }
    }
    pages.push(facts);
    issues.push(...pageIssues(facts, opts.strictRendering ?? false));
    if (crawl) {
      for (const link of facts.internalLinks) {
        if (seen.has(link) || /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|zip|xml|txt|ico|css|js)$/i.test(link)) continue;
        if (!linkedFrom.has(link)) linkedFrom.set(link, path);
        queue.push(link);
      }
    }
  }

  const audited = new Set(pages.map((page) => page.path));
  for (const page of pages) {
    for (const link of page.internalLinks) {
      if (audited.has(link) || broken.has(link) || /\.(?:jpe?g|png|gif|webp|avif|svg|ico|css|js)$/i.test(link)) continue;
      if (broken.size + audited.size > maxPages * 3) break;
      const response = await fetchText(`${origin}${link}`);
      if (!response || response.status >= 400) {
        broken.add(link);
        issues.push({ code: "broken-link", group: "search", severity: "error", page: page.path, message: `The link to ${link} is broken${response ? ` (HTTP ${response.status})` : ""}.`, fix: "Fix the link target or remove the link." });
      } else audited.add(link);
    }
  }

  issues.push(...siteIssues(pages, site));
  const deduped = dedupeAxe(issues);
  const { score, groupScores } = scoreIssues(deduped);
  return { baseUrl: origin, checkedAt: new Date().toISOString(), pages, issues: deduped, score, groupScores, site };
}

const AXE_TWINS: Record<string, string> = { "missing-lang": "a11y-html-has-lang", "image-alt": "a11y-image-alt" };

/** Drop the HTML-only checks that axe-core reported again for the same page. */
function dedupeAxe(issues: SeoIssue[]): SeoIssue[] {
  const axe = new Set(issues.filter((issue) => issue.code.startsWith("a11y-")).map((issue) => `${issue.page}\0${issue.code}`));
  return issues.filter((issue) => {
    const twin = AXE_TWINS[issue.code];
    return !twin || !axe.has(`${issue.page}\0${twin}`);
  });
}

export function auditErrors(result: SeoAuditResult): SeoIssue[] {
  return result.issues.filter((issue) => issue.severity === "error");
}

/** Short text for the model or a person: score, then each error and warning. */
export function describeAudit(result: SeoAuditResult, opts: { includeInfo?: boolean; max?: number } = {}): string {
  const shown = result.issues.filter((issue) => opts.includeInfo || issue.severity !== "info").slice(0, opts.max ?? 40);
  const lines = [
    `SEO audit of ${result.baseUrl}: score ${result.score}/100 (${(Object.keys(GROUP_LABEL) as SeoGroup[]).map((group) => `${GROUP_LABEL[group]} ${result.groupScores[group]}`).join(", ")}), ${result.pages.length} page${result.pages.length === 1 ? "" : "s"}.`,
  ];
  for (const issue of shown) lines.push(`- [${issue.severity}] ${issue.page ?? "site"}: ${issue.message} Fix: ${issue.fix}`);
  if (!shown.length) lines.push("No problems found.");
  return lines.join("\n");
}
