import fs from "node:fs";
import path from "node:path";
import type { BrowserSession } from "@coderbabasi/core";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FONT = /^[A-Za-z0-9 ,'"-]{1,80}$/;
const KEY = /^[a-zA-Z][a-zA-Z0-9]{0,40}$/;

/** Text and background pairs every theme must keep readable (WCAG AA). */
export const CONTRAST_PAIRS: [text: string, background: string, min: number][] = [
  ["text", "background", 4.5],
  ["muted", "background", 4.5],
  ["onBrand", "brand", 4.5],
  ["text", "surface", 4.5],
  ["onAccent", "accent", 4.5],
];

function channels(hex: string): [number, number, number] {
  let value = hex.slice(1);
  if (value.length === 3) value = value.replace(/./g, (c) => c + c);
  return [0, 2, 4].map((start) => parseInt(value.slice(start, start + 2), 16) / 255) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

export type ContrastProblem = { text: string; background: string; ratio: number; min: number };

/** Pairs in a theme whose contrast is below WCAG AA. */
export function contrastProblems(theme: Record<string, string>): ContrastProblem[] {
  const problems: ContrastProblem[] = [];
  for (const [text, background, min] of CONTRAST_PAIRS) {
    const fg = theme[text];
    const bg = theme[background];
    if (!fg || !bg || !HEX.test(fg) || !HEX.test(bg)) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio < min) problems.push({ text, background, ratio, min });
  }
  return problems;
}

export function validateTheme(theme: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(theme)) {
    if (!KEY.test(key)) errors.push(`${key} is not a valid theme key.`);
    else if (/font/i.test(key) ? !FONT.test(value) : !HEX.test(value) && !/radius|shadow|style/i.test(key)) errors.push(`${key} has an invalid value.`);
    else if (/radius|shadow|style/i.test(key) && !/^[A-Za-z0-9 .,()#%-]{1,80}$/.test(value)) errors.push(`${key} has an invalid value.`);
  }
  for (const problem of contrastProblems(theme)) {
    errors.push(`${problem.text} on ${problem.background} has contrast ${problem.ratio}:1; it needs at least ${problem.min}:1 to be readable.`);
  }
  return errors;
}

/** Writes src/theme.ts, which the templates read for colors, fonts and corner style. */
export function writeTheme(root: string, theme: Record<string, string>): void {
  const errors = validateTheme(theme);
  if (errors.length) throw new Error(errors.join(" "));
  const file = path.join(root, "src", "theme.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `// Colors, fonts and shapes for the whole site. Every text color keeps WCAG AA contrast.\nexport const theme = ${JSON.stringify(theme, null, 2)} as const;\n\nexport type Theme = typeof theme;\n`);
}

export type Screenshot = { device: "desktop" | "mobile"; width: number; height: number; jpegBase64: string };

/** Takes desktop and mobile screenshots of a page on the preview server. */
export async function screenshots(browserSession: BrowserSession, url: string, devices: { device: Screenshot["device"]; width: number; height: number }[] = [
  { device: "desktop", width: 1280, height: 800 },
  { device: "mobile", width: 390, height: 844 },
]): Promise<Screenshot[]> {
  const browser = await browserSession.get();
  if (!browser) throw new Error("No browser is available for screenshots.");
  const out: Screenshot[] = [];
  for (const { device, width, height } of devices) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: device === "mobile" });
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      const image = await page.screenshot({ type: "jpeg", quality: 70 });
      out.push({ device, width, height, jpegBase64: image.toString("base64") });
    } finally {
      await context.close();
    }
  }
  return out;
}
