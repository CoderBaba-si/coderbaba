import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Llm, LlmResult } from "@coderbabasi/core";
import { changesSince, restore, snapshot } from "./git.js";
import { extractPage, importTask, slugForPath } from "./import.js";
import { inspectHtml } from "./inspect.js";
import { writeUploadMeta } from "./jobs.js";
import { parseClientMessage, parseJobRequest, type ServerMessage } from "./protocol.js";
import { createRunner, protocolSecret, secretMatches, type Runner } from "./server.js";
import { sandboxPermission } from "./session.js";
import { contrastProblems, contrastRatio, validateTheme, writeTheme } from "./theme.js";
import { createZip, crc32 } from "./zip.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cb-runner-"));

describe("protocol", () => {
  it("parses client messages and rejects junk", () => {
    expect(parseClientMessage('{"type":"task","text":"Add a menu page"}')).toEqual({ type: "task", text: "Add a menu page", model: undefined });
    expect(parseClientMessage('{"type":"task","text":"  "}')).toBeUndefined();
    expect(parseClientMessage('{"type":"secret","id":"a","value":null}')).toEqual({ type: "secret", id: "a", value: null });
    expect(parseClientMessage("not json")).toBeUndefined();
    expect(parseClientMessage('{"type":"rm -rf"}')).toBeUndefined();
    expect(parseJobRequest({ type: "build" })).toEqual({ type: "build" });
    expect(parseJobRequest({ type: "shell" })).toBeUndefined();
  });

  it("checks the session secret", () => {
    expect(protocolSecret("coderbaba, abc")).toBe("abc");
    expect(protocolSecret("other, abc")).toBeUndefined();
    expect(secretMatches("abc", "abc")).toBe(true);
    expect(secretMatches("abc", "abd")).toBe(false);
    expect(secretMatches("abc", undefined)).toBe(false);
  });

  it("allows everything in the sandbox except files outside the project", () => {
    expect(sandboxPermission({ kind: "shell", command: "npm i", summary: "" })).toBe("always");
    expect(sandboxPermission({ kind: "outside", path: "/etc/passwd", summary: "" })).toBe("deny");
  });
});

describe("zip", () => {
  it("writes entries that inflate back to the original bytes", () => {
    const data = Buffer.from("hello hello hello hello hello");
    const zip = createZip([{ name: "site/a.txt", data }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const method = zip.readUInt16LE(8);
    const size = zip.readUInt32LE(18);
    const nameLength = zip.readUInt16LE(26);
    const body = zip.subarray(30 + nameLength, 30 + nameLength + size);
    expect((method === 8 ? zlib.inflateRawSync(body) : body).toString()).toBe(data.toString());
    expect(zip.readUInt32LE(14)).toBe(crc32(data));
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("import", () => {
  it("extracts content, images, links and business facts", () => {
    const html = `<html><head><title>Ana's Bakery | Ljubljana</title><meta name="description" content="Fresh bread daily">
      <script type="application/ld+json">{"@type":"Bakery","name":"Ana's Bakery","address":{"streetAddress":"Main 1","addressLocality":"Ljubljana"},"openingHours":["Mo-Fr 07:00-18:00"]}</script></head>
      <body><h1>Fresh bread</h1><img src="/img/bread.jpg" alt="Sourdough loaf"><a href="tel:+386 1 234">Call</a>
      <a href="mailto:ana@example.com">Mail</a><a href="/menu#top">Menu</a><a href="https://other.com">x</a></body></html>`;
    const page = extractPage("https://ana.si/", html);
    expect(page.title).toBe("Ana's Bakery | Ljubljana");
    expect(page.description).toBe("Fresh bread daily");
    expect(page.headings).toEqual(["# Fresh bread"]);
    expect(page.images).toEqual([{ src: "https://ana.si/img/bread.jpg", alt: "Sourdough loaf" }]);
    expect(page.links).toEqual(["https://ana.si/menu"]);
    expect(page.facts).toMatchObject({ name: "Ana's Bakery", phone: "+386 1 234", email: "ana@example.com", address: "Main 1, Ljubljana", hours: ["Mo-Fr 07:00-18:00"] });
    expect(slugForPath("/about-us/team.html")).toBe("about-us__team");
    expect(slugForPath("/")).toBe("home");
    expect(importTask({ origin: "https://ana.si", pages: [], images: [], facts: {}, skipped: [] })).toContain("redirects.json");
  });
});

describe("upload manifest", () => {
  it("adds, replaces and removes entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-uploads-"));
    writeUploadMeta(root, "b.jpg", { alt: "Sourdough loaves" });
    writeUploadMeta(root, "a.png", { alt: "Shop front", attribution: "Photo: Ana" });
    writeUploadMeta(root, "b.jpg", { alt: "Two sourdough loaves" });
    const file = path.join(root, "src", "assets", "uploads", "uploads.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([
      { file: "a.png", alt: "Shop front", attribution: "Photo: Ana" },
      { file: "b.jpg", alt: "Two sourdough loaves" },
    ]);
    writeUploadMeta(root, "a.png", null);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveLength(1);
  });
});

describe("inspect", () => {
  it("finds form targets, password and card fields, outbound links and phishing phrases", () => {
    const risk = inspectHtml(
      "/login/",
      `<form action="https://evil.example/steal"><input type="password" name="p"><input autocomplete="cc-number"></form>
       <form><input name="q"></form><a href="https://bank.example/x">Bank</a><a href="/about">About</a>
       <p>Please verify your account within 24 hours.</p>`,
      "https://shop.coderbaba.app",
    );
    expect(risk.formActions).toEqual(["https://evil.example/steal", "https://shop.coderbaba.app/login/"]);
    expect(risk.passwordFields).toBe(1);
    expect(risk.cardFields).toBe(1);
    expect(risk.externalLinks).toEqual(["https://bank.example/x"]);
    expect(risk.phrases).toHaveLength(1);
  });
});

describe("theme", () => {
  it("rejects unreadable color pairs", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastProblems({ text: "#777777", background: "#ffffff" })).toHaveLength(1);
    expect(validateTheme({ text: "#111111", background: "#ffffff", fontBody: "Inter", brand: "url(x)" })).toEqual(["brand has an invalid value."]);
    const root = temp();
    expect(() => writeTheme(root, { text: "#cccccc", background: "#ffffff" })).toThrow(/contrast/);
    writeTheme(root, { text: "#111111", background: "#ffffff" });
    expect(fs.readFileSync(path.join(root, "src/theme.ts"), "utf8")).toContain('"text": "#111111"');
  });
});

describe("git snapshots", () => {
  it("restores a snapshot and lists changes since it", async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "index.html"), "v1");
    await snapshot(root, "deploy-1");
    fs.writeFileSync(path.join(root, "index.html"), "v2");
    fs.writeFileSync(path.join(root, "new.html"), "new");
    const changes = await changesSince(root, "deploy-1");
    expect(changes.files.map((file) => file.path).sort()).toEqual(["index.html", "new.html"]);
    expect(changes.diff).toContain("+v2");
    await restore(root, "deploy-1");
    expect(fs.readFileSync(path.join(root, "index.html"), "utf8")).toBe("v1");
    expect(fs.existsSync(path.join(root, "new.html"))).toBe(false);
    expect(execFileSync("git", ["log", "--oneline"], { cwd: root }).toString()).toContain("Restore deploy-1");
    await expect(snapshot(root, "bad tag; rm")).rejects.toThrow(/Invalid/);
  });
});

describe("runner server", () => {
  let runner: Runner | undefined;
  afterEach(async () => {
    await runner?.close();
    runner = undefined;
  });

  const fakeLlm = (reply: string): Llm => ({
    async chat(input): Promise<LlmResult> {
      input.onText?.(reply);
      return { content: reply, toolCalls: [], finishReason: "stop" };
    },
  });

  it("streams a task over the WebSocket and serves jobs with the secret", async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "index.html"), "<h1>Hi</h1>");
    runner = createRunner({ root, secret: "s3cret", llm: fakeLlm("All done."), model: "test", previewPort: 4321, allowedOrigins: ["https://coderbaba.si"] });
    const port = await runner.listen(0, "127.0.0.1");

    const denied = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["coderbaba", "wrong"], { origin: "https://coderbaba.si" });
    await new Promise((resolve) => denied.on("error", resolve));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["coderbaba", "s3cret"], { origin: "https://coderbaba.si" });
    const messages: ServerMessage[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({ type: "task", text: "Make the headline bigger" }));
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (messages.some((message) => message.type === "event" && message.event.type === "done")) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    expect(messages[0]?.type).toBe("hello");
    expect(messages.some((message) => message.type === "event" && message.event.type === "text" && message.event.text === "All done.")).toBe(true);
    ws.send(JSON.stringify({ type: "listFiles" }));
    await new Promise<void>((resolve) => ws.once("message", () => resolve()));
    ws.close();

    const unauthorized = await fetch(`http://127.0.0.1:${port}/jobs`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    const started = await fetch(`http://127.0.0.1:${port}/jobs`, {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
      body: JSON.stringify({ type: "snapshot", tag: "deploy-1" }),
    });
    expect(started.status).toBe(202);
    const job = (await started.json()) as { id: string };
    let state: { status: string; result?: { commit: string } } = { status: "running" };
    for (let i = 0; i < 50 && state.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = (await (await fetch(`http://127.0.0.1:${port}/jobs/${job.id}`, { headers: { authorization: "Bearer s3cret" } })).json()) as typeof state;
    }
    expect(state.status).toBe("done");
    expect(state.result?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".coderbaba/runner-session.json"), "utf8")).history).toHaveLength(1);
  });
});
