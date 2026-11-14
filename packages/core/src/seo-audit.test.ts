import { describe, expect, it } from "vitest";
import { analyzeHtml, analyzeTabWalk, blockedCrawlers, findSitemapUrls, keyboardIssues, runSeoAudit, scoreIssues, type FetchText } from "./seo-audit.js";

const GOOD = `<!doctype html><html lang="en"><head>
<title>Sweet Crumb Bakery in Ljubljana</title>
<meta name="description" content="Fresh sourdough, cakes and pastries baked every morning in central Ljubljana.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="Sweet Crumb">
<link rel="canonical" href="https://sweetcrumb.example/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Bakery","name":"Sweet Crumb"}</script>
</head><body><h1>Sweet Crumb Bakery</h1>
<h2>What time do you open?</h2><p>${"We bake bread every day. ".repeat(40)}</p>
<img src="/a.jpg" alt="Sourdough loaf" width="10" height="10">
<a href="/about">About</a><a href="https://instagram.com/sweetcrumb">Instagram</a><a href="mailto:hi@x.si">Mail</a>
</body></html>`;

describe("analyzeHtml", () => {
  it("extracts the facts search and AI crawlers use", () => {
    const facts = analyzeHtml("https://sweetcrumb.example/", GOOD, 200);
    expect(facts.title).toBe("Sweet Crumb Bakery in Ljubljana");
    expect(facts.h1).toEqual(["Sweet Crumb Bakery"]);
    expect(facts.jsonLdTypes).toEqual(["Bakery"]);
    expect(facts.internalLinks).toEqual(["/about"]);
    expect(facts.externalLinks).toEqual(["https://instagram.com/sweetcrumb"]);
    expect(facts.questionHeadings).toBe(1);
    expect(facts.wordCount).toBeGreaterThan(150);
    expect(facts.lang).toBe("en");
    expect(facts.imagesWithoutAlt).toEqual([]);
  });

  it("flags broken JSON-LD and missing alt text", () => {
    const facts = analyzeHtml(
      "https://x.example/a/",
      `<html><head><script type="application/ld+json">{nope</script></head><body><img src="/b.png"></body></html>`,
    );
    expect(facts.path).toBe("/a");
    expect(facts.jsonLdErrors).toEqual(["a JSON-LD block is not valid JSON"]);
    expect(facts.imagesWithoutAlt).toEqual(["/b.png"]);
  });
});

describe("blockedCrawlers", () => {
  it("reads per-agent groups and falls back to the wildcard group", () => {
    const robots = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    expect(blockedCrawlers(robots)).toEqual(["GPTBot"]);
    expect(blockedCrawlers("User-agent: *\nDisallow: /\n")).toContain("ClaudeBot");
    expect(blockedCrawlers("User-agent: *\nDisallow: /admin\n")).toEqual([]);
  });
});

describe("runSeoAudit", () => {
  const site: Record<string, string> = {
    "/": GOOD,
    "/about": `<html lang="en"><head><title>Sweet Crumb Bakery in Ljubljana</title></head><body><p>Short.</p><a href="/missing">x</a></body></html>`,
    "/robots.txt": "User-agent: *\nAllow: /\nSitemap: https://sweetcrumb.example/sitemap.xml\n",
  };
  const fetchText: FetchText = async (url) => {
    const path = new URL(url).pathname;
    const text = site[path];
    if (text === undefined) return { status: 404, text: "<html>not found</html>", contentType: "text/html" };
    return { status: 200, text, contentType: path.endsWith(".txt") ? "text/plain" : "text/html" };
  };

  it("crawls internal links and reports page and site issues", async () => {
    const result = await runSeoAudit({ baseUrl: "https://sweetcrumb.example/", fetchText });
    expect(result.pages.map((page) => page.path)).toEqual(["/", "/about"]);
    const codes = result.issues.map((issue) => `${issue.page ?? "site"}:${issue.code}`);
    expect(codes).toContain("/about:missing-h1");
    expect(codes).toContain("/about:broken-link");
    expect(codes).toContain("site:missing-sitemap");
    expect(codes).toContain("site:missing-llms-txt");
    expect(codes).toContain("/:duplicate-title");
    expect(result.site.robots).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it("audits only the given paths when asked", async () => {
    const result = await runSeoAudit({ baseUrl: "https://sweetcrumb.example/", fetchText, onlyPaths: ["/"] });
    expect(result.pages.map((page) => page.path)).toEqual(["/"]);
    expect(result.issues.filter((issue) => issue.page === "/" && issue.severity === "error")).toEqual([]);
  });
});

describe("scoreIssues", () => {
  it("weights errors more than warnings", () => {
    const error = scoreIssues([{ code: "a", group: "search", severity: "error", message: "", fix: "" }]);
    const warning = scoreIssues([{ code: "a", group: "search", severity: "warning", message: "", fix: "" }]);
    expect(error.score).toBeLessThan(warning.score);
    expect(error.groupScores.ai).toBe(100);
  });
});

describe("findSitemapUrls", () => {
  it("follows robots.txt and sitemap indexes, mapping production URLs onto the audited origin", async () => {
    const files: Record<string, string> = {
      "http://127.0.0.1:5000/sitemap-index.xml": `<sitemapindex><sitemap><loc>https://shop.example/sitemap-0.xml</loc></sitemap></sitemapindex>`,
      "http://127.0.0.1:5000/sitemap-0.xml": `<urlset><url><loc>https://shop.example/</loc></url><url><loc>https://shop.example/menu/</loc></url><url><loc>https://other.example/x</loc></url></urlset>`,
    };
    const fetchText: FetchText = async (url) => (files[url] ? { status: 200, text: files[url]!, contentType: "application/xml" } : { status: 404, text: "", contentType: "text/plain" });
    const result = await findSitemapUrls("http://127.0.0.1:5000", "User-agent: *\nAllow: /\nSitemap: https://shop.example/sitemap-index.xml\n", fetchText);
    expect(result).toEqual({ found: true, paths: ["/", "/menu"] });
    expect((await findSitemapUrls("http://127.0.0.1:5000", "", fetchText)).found).toBe(true);
  });
});

describe("keyboard checks", () => {
  const step = (id: string, visibleFocus = true) => ({ id, label: `a "${id}"`, visibleFocus });

  it("passes a normal walk that wraps to the start", () => {
    const result = analyzeTabWalk([step("a"), step("b"), step("c"), step("body"), step("a")], 3);
    expect(result).toEqual({ trappedAt: undefined, noFocusStyle: [], checked: 3 });
    expect(keyboardIssues("/", result)).toEqual([]);
  });

  it("flags focus stuck in a menu before the rest of the page", () => {
    const result = analyzeTabWalk([step("logo"), step("m1"), step("m2"), step("m1"), step("m2"), step("m1")], 6);
    expect(result.trappedAt).toBe('a "m1"');
    expect(keyboardIssues("/", result)[0]).toMatchObject({ code: "a11y-keyboard-trap", severity: "error" });
  });

  it("is an error when nothing shows focus and a warning when some elements don't", () => {
    const none = analyzeTabWalk([step("a", false), step("b", false)], 2);
    expect(keyboardIssues("/", none)[0]).toMatchObject({ code: "a11y-focus-visible", severity: "error" });
    const some = analyzeTabWalk([step("a"), step("b", false)], 2);
    expect(keyboardIssues("/", some)[0]).toMatchObject({ code: "a11y-focus-visible", severity: "warning" });
  });
});
