import fs from "node:fs";
import path from "node:path";
import { walkFiles } from "./files.js";

export type PageRisk = {
  path: string;
  /** Form action URLs, resolved against the site. */
  formActions: string[];
  passwordFields: number;
  cardFields: number;
  externalLinks: string[];
  /** Phishing phrases found in the visible text. */
  phrases: string[];
};

const PHRASES = [
  /verify your (account|identity)/i,
  /confirm your (password|account|card)/i,
  /(account|wallet) (has been )?(suspended|locked|limited)/i,
  /enter your (seed|recovery) phrase/i,
  /update your (billing|payment) (details|information)/i,
  /unusual (sign-?in|login) activity/i,
  /claim your (prize|reward|airdrop)/i,
];

const CARD_FIELD = /autocomplete\s*=\s*["']?cc-(number|csc|exp)|name\s*=\s*["']?(card[-_ ]?number|cardnumber|cvv|cvc|ccnum)/i;

/** What the abuse scan needs from one built page, read from its HTML. */
export function inspectHtml(pagePath: string, html: string, siteOrigin = "https://site.invalid"): PageRisk {
  const base = new URL(pagePath, siteOrigin);
  const resolve = (href: string) => {
    try {
      return new URL(href, base).toString();
    } catch {
      return undefined;
    }
  };
  const formActions: string[] = [];
  for (const match of html.matchAll(/<form\b([^>]*)>/gi)) {
    const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(match[1]!)?.[1] ?? "";
    const resolved = resolve(action || pagePath);
    if (resolved) formActions.push(resolved);
  }
  const passwordFields = (html.match(/<input\b[^>]*type\s*=\s*["']?password/gi) ?? []).length;
  const cardFields = (html.match(/<input\b[^>]*>/gi) ?? []).filter((tag) => CARD_FIELD.test(tag)).length;
  const externalLinks = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1]!;
    if (!/^https?:/i.test(href)) continue;
    const url = resolve(href);
    if (url && new URL(url).origin !== base.origin) externalLinks.add(url);
  }
  const text = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  const phrases = PHRASES.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  return { path: pagePath, formActions, passwordFields, cardFields, externalLinks: [...externalLinks], phrases };
}

/** Inspects every HTML page in a build folder. */
export function inspectBuild(outDir: string, siteOrigin?: string): PageRisk[] {
  return walkFiles(outDir)
    .filter((file) => file.endsWith(".html"))
    .map((file) => inspectHtml(`/${file.replace(/index\.html$/, "")}`, fs.readFileSync(path.join(outDir, file), "utf8"), siteOrigin));
}
