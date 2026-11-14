# @coderbabasi/shared

## 0.3.0

### Minor Changes

- f34327c: Add `/seo`: audits a site for search engines, AI answers (GEO and AEO), performance and WCAG 2.2 AA accessibility, writes SEO_REPORT.md, and fixes findings with `/seo fix`. Edited pages get an automatic SEO check while a dev server runs, website projects (with site.json) get content rules in the system prompt, and `/seo cite` checks AI search citations. Adds `@coderbabasi/runner`, the server that runs the agent inside a website-builder sandbox.

## 0.2.0

### Minor Changes

- 5166375: Open models only. Fast now uses `cohere/north-mini-code:free` and Smart uses `qwen/qwen3-coder-next`. Claude is no longer offered. No sign-in is needed for everyday use: anonymous devices get far more free tasks, `/security` works without logging in, and the status line no longer asks you to log in. Logging in (free) unlocks the Smart model.

## 0.1.1

### Patch Changes

- bbf97fe: Fast model now uses `qwen/qwen3-coder-next` instead of `google/gemini-2.5-flash`.
