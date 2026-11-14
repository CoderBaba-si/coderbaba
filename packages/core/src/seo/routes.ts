import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { isLocalPageUrl } from "../browser.js";
import type { ProcessManager } from "../processes.js";

export const PAGE_FILE = /\.(?:astro|html?|mdx?|[cm]?[jt]sx|vue|svelte)$/i;
const PAGE_DIRS = ["src/pages/", "pages/", "src/app/", "app/", "src/routes/", "routes/", "src/content/", "content/", "public/"];
const BUILD_DIRS = ["dist", "out", "build", "_site", ".output/public", "public"];

export const SITE_FILE = "site.json";

/** A website project made by the builder or the website templates. */
export function isWebsiteProject(root: string): boolean {
  return fs.existsSync(path.join(root, SITE_FILE));
}

/** Best guess at the URL path a source file renders, or undefined when it isn't a page. */
export function fileToRoute(relFile: string): string | undefined {
  const rel = relFile.split(path.sep).join("/").replace(/^\.\//, "");
  if (!PAGE_FILE.test(rel)) return undefined;
  const dir = PAGE_DIRS.find((prefix) => rel.startsWith(prefix) || rel.includes(`/${prefix}`));
  if (!dir) return rel.endsWith(".html") || rel.endsWith(".htm") ? `/${rel.replace(/(?:^|\/)index\.html?$/, "").replace(/\.html?$/, "")}`.replace(/\/$/, "") || "/" : undefined;
  let route = rel.slice(rel.indexOf(dir) + dir.length).replace(PAGE_FILE, "");
  if (/(?:^|\/)(?:layout|template|loading|error|not-found|_app|_document)$/.test(route)) return undefined;
  if (route.includes("[")) return undefined;
  route = route
    .replace(/\(.*?\)\//g, "")
    .replace(/(?:^|\/)(?:index|page)$/, "")
    .replace(/^\/+|\/+$/g, "");
  if (route.startsWith("_") || route.split("/").some((part) => part.startsWith("_"))) return undefined;
  return `/${route}`;
}

/** Routes for the changed files, always including the home page. */
export function routesFor(relFiles: string[]): string[] {
  const routes = new Set<string>(["/"]);
  for (const file of relFiles) {
    const route = fileToRoute(file);
    if (route) routes.add(route);
  }
  return [...routes];
}

/** URL of a dev server CoderBaba started for this project, if one is serving pages. */
export function runningSiteUrl(processes?: ProcessManager): string | undefined {
  const running = processes?.running() ?? [];
  const withUrl = running.filter((info) => info.url && isLocalPageUrl(info.url));
  const preferred = withUrl.find((info) => /^(?:web|site|client|dev|astro|preview)$/i.test(info.name)) ?? withUrl[0];
  return preferred?.url;
}

/** The first build output folder that has an index.html. */
export async function findBuildDir(root: string): Promise<string | undefined> {
  for (const dir of BUILD_DIRS) {
    const full = path.join(root, dir);
    try {
      await fsp.access(path.join(full, "index.html"));
      return full;
    } catch {
      // try the next one
    }
  }
  return undefined;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Serve a static build folder on 127.0.0.1 for auditing. Paths resolve like most static hosts. */
export async function serveStatic(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const root = path.resolve(dir);
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const candidates = [pathname, `${pathname.replace(/\/$/, "")}/index.html`, `${pathname}.html`];
    for (const candidate of candidates) {
      const file = path.resolve(root, `.${candidate}`);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) break;
      try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) continue;
        response.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
        response.end(await fsp.readFile(file));
        return;
      } catch {
        // try the next candidate
      }
    }
    const notFound = path.join(root, "404.html");
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end(fs.existsSync(notFound) ? await fsp.readFile(notFound) : "<html><body>Not found</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
