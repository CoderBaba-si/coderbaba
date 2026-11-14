# @coderbabasi/core

## 0.4.0

### Minor Changes

- f34327c: Add `/seo`: audits a site for search engines, AI answers (GEO and AEO), performance and WCAG 2.2 AA accessibility, writes SEO_REPORT.md, and fixes findings with `/seo fix`. Edited pages get an automatic SEO check while a dev server runs, website projects (with site.json) get content rules in the system prompt, and `/seo cite` checks AI search citations. Adds `@coderbabasi/runner`, the server that runs the agent inside a website-builder sandbox.

### Patch Changes

- Updated dependencies [f34327c]
  - @coderbabasi/shared@0.3.0

## 0.3.0

### Minor Changes

- 5166375: CoderBaba Security. `/security` scans the project in phases (threat model, one review per app folder, then dedupe and ranking) and writes `SECURITY_REPORT.md`. `/security validate` reproduces findings against the app on localhost, `/security fix <id>` fixes one and checks the fix, `/security diff [base]` reviews recent changes, and `/security status` lists findings. Edits to `package.json`, lockfiles or `requirements.txt` now run a dependency audit that warns without blocking. The agent follows secure-coding defaults, `npm audit`, `pnpm audit`, `yarn audit`, project-venv `pip-audit` and `git ls-files` run without asking, and requests with your own OpenRouter key only go to providers that don't collect prompt data.
- ae3e8bb: Long chats are summarized automatically, and `/compact` does it on demand. A project's `AGENTS.md` is read every turn, and `/init` writes one. After edits, CoderBaba runs the project's typecheck, lint or Django checks and fixes failures. The new `read_url` tool reads documentation pages, and the new `check_page` tool loads local pages in headless Chrome or Edge to catch browser errors. Bigger tasks get a todo list. Also new: `!command` runs a command yourself, messages typed while CoderBaba works are queued, and `/export` saves the chat as Markdown.
- 5166375: Open models only. Fast now uses `cohere/north-mini-code:free` and Smart uses `qwen/qwen3-coder-next`. Claude is no longer offered. No sign-in is needed for everyday use: anonymous devices get far more free tasks, `/security` works without logging in, and the status line no longer asks you to log in. Logging in (free) unlocks the Smart model.

### Patch Changes

- Updated dependencies [5166375]
  - @coderbabasi/shared@0.2.0

## 0.2.0

### Minor Changes

- ee534c3: Build Next.js, MERN, and Django + React MVPs end to end: named background processes with port readiness (`/ps`, `/stop`, `/restart`), live progress for long commands, a safe-command allow-list with global and per-project rules (`/allow`), secrets entered in the CLI and hidden from the model, automatic Python venv activation, and Windows support.

## 0.1.1

### Patch Changes

- Updated dependencies [bbf97fe]
  - @coderbabasi/shared@0.1.1
