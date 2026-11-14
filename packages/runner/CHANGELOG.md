# @coderbabasi/runner

## 0.2.0

### Minor Changes

- f34327c: Add `/seo`: audits a site for search engines, AI answers (GEO and AEO), performance and WCAG 2.2 AA accessibility, writes SEO_REPORT.md, and fixes findings with `/seo fix`. Edited pages get an automatic SEO check while a dev server runs, website projects (with site.json) get content rules in the system prompt, and `/seo cite` checks AI search citations. Adds `@coderbabasi/runner`, the server that runs the agent inside a website-builder sandbox.

### Patch Changes

- Updated dependencies [f34327c]
  - @coderbabasi/core@0.4.0
  - @coderbabasi/shared@0.3.0
