import fs from "node:fs";
import path from "node:path";
import { resolveInProject } from "@coderbabasi/core";
import type { FileEntry } from "./protocol.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".coderbaba", ".astro", "dist", ".turbo", ".cache", ".netlify", ".vercel"]);
const MAX_FILES = 2000;
const MAX_READ = 200_000;

/** Files the owner can browse under Advanced, without dependencies or build output. */
export function listProjectFiles(root: string, skip: Set<string> = SKIP_DIRS): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        out.push({ path: path.relative(root, full).split(path.sep).join("/"), size: fs.statSync(full).size });
      }
    }
  };
  walk(root);
  return out;
}

export async function readProjectFile(root: string, file: string): Promise<{ path: string; content: string; truncated: boolean }> {
  const resolved = await resolveInProject(root, file);
  if (!resolved.inside) throw new Error(`${file} is outside the project.`);
  const full = resolved.full;
  const rel = path.relative(resolved.root, full).split(path.sep).join("/");
  if (rel.split("/").some((part) => part === ".env" || part.startsWith(".env.")) || rel.startsWith(".coderbaba/")) {
    throw new Error(`${rel} holds private settings and isn't shown here.`);
  }
  const buffer = fs.readFileSync(full);
  if (buffer.subarray(0, 8000).includes(0)) return { path: rel, content: "(binary file)", truncated: false };
  return { path: rel, content: buffer.subarray(0, MAX_READ).toString("utf8"), truncated: buffer.length > MAX_READ };
}

/** Every file under a folder, as paths relative to it. */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
