import type { SeoFinding } from "./store.js";

export function seoFixTask(finding: SeoFinding, url: string): string {
  return `Fix SEO finding ${finding.id} on ${finding.page ? `the page ${finding.page}` : "the whole site"} (served at ${url}).
Problem: ${finding.message}
Suggested fix: ${finding.fix}

Find the source file that renders it (for example under src/pages, app, or pages), then make the smallest change that fixes the cause with edit_file.
- Titles, descriptions and headings must stay true to the business; don't invent facts, prices, reviews, or locations.
- If the page is rendered only in the browser, prefer static generation or server rendering in the framework already used, and explain the trade-off before large changes.
- Keep the app working; the checks run automatically after edits.
Finish with one sentence saying what changed on the page.`;
}
