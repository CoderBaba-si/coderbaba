import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileToRoute, routesFor, serveStatic } from "./routes.js";

describe("fileToRoute", () => {
  it("maps common framework page files to URL paths", () => {
    expect(fileToRoute("src/pages/index.astro")).toBe("/");
    expect(fileToRoute("src/pages/services/cakes.astro")).toBe("/services/cakes");
    expect(fileToRoute("app/about/page.tsx")).toBe("/about");
    expect(fileToRoute("src/app/(marketing)/pricing/page.tsx")).toBe("/pricing");
    expect(fileToRoute("pages/contact.jsx")).toBe("/contact");
    expect(fileToRoute("about.html")).toBe("/about");
    expect(fileToRoute("index.html")).toBe("/");
  });

  it("skips layouts, dynamic routes and non-pages", () => {
    expect(fileToRoute("app/layout.tsx")).toBeUndefined();
    expect(fileToRoute("src/pages/blog/[slug].astro")).toBeUndefined();
    expect(fileToRoute("src/components/Header.tsx")).toBeUndefined();
    expect(fileToRoute("pages/_app.tsx")).toBeUndefined();
  });

  it("always includes the home page", () => {
    expect(routesFor(["src/pages/about.astro", "README.md"])).toEqual(["/", "/about"]);
  });
});

describe("serveStatic", () => {
  it("serves clean URLs from a build folder", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-static-"));
    await fs.mkdir(path.join(dir, "about"));
    await fs.writeFile(path.join(dir, "index.html"), "<h1>Home</h1>");
    await fs.writeFile(path.join(dir, "about", "index.html"), "<h1>About</h1>");
    const server = await serveStatic(dir);
    try {
      expect(await (await fetch(`${server.url}about`)).text()).toBe("<h1>About</h1>");
      expect((await fetch(`${server.url}nope`)).status).toBe(404);
      expect((await fetch(`${server.url}..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
