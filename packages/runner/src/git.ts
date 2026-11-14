import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 20_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}

export async function ensureRepo(root: string): Promise<void> {
  if (!fs.existsSync(path.join(root, ".git"))) {
    await git(root, ["init", "-q", "-b", "main"]);
  }
  await git(root, ["config", "user.name", "CoderBaba"]);
  await git(root, ["config", "user.email", "builder@coderbaba.si"]);
  const ignore = path.join(root, ".gitignore");
  const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  const needed = ["node_modules/", "dist/", ".astro/", ".coderbaba/", ".env", ".env.*"].filter((line) => !current.split(/\r?\n/).includes(line));
  if (needed.length) fs.writeFileSync(ignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${needed.join("\n")}\n`);
}

/** Commits the project as it is now and tags it, so it can be restored later. Returns the commit hash. */
export async function snapshot(root: string, tag: string, message = tag): Promise<string> {
  if (!TAG.test(tag)) throw new Error(`Invalid snapshot name: ${tag}`);
  await ensureRepo(root);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "--allow-empty", "-m", message]);
  await git(root, ["tag", "-f", tag]);
  return git(root, ["rev-parse", "HEAD"]);
}

/** Puts the files back the way they were at a snapshot, as a new commit on top. */
export async function restore(root: string, tag: string): Promise<string> {
  if (!TAG.test(tag)) throw new Error(`Invalid snapshot name: ${tag}`);
  await ensureRepo(root);
  await git(root, ["rev-parse", "--verify", `refs/tags/${tag}`]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "--allow-empty", "-m", `Before restoring ${tag}`]);
  await git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "."]);
  await git(root, ["checkout", tag, "--", "."]);
  const tracked = new Set((await git(root, ["ls-tree", "-r", "--name-only", tag])).split("\n").filter(Boolean));
  for (const file of (await git(root, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean)) {
    if (!tracked.has(file)) fs.rmSync(path.join(root, file), { force: true });
  }
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "--allow-empty", "-m", `Restore ${tag}`]);
  return git(root, ["rev-parse", "HEAD"]);
}

/** Files changed since a snapshot, with a unified diff for the draft review page. */
export async function changesSince(root: string, tag: string): Promise<{ files: { path: string; status: string }[]; diff: string }> {
  if (!TAG.test(tag)) throw new Error(`Invalid snapshot name: ${tag}`);
  await ensureRepo(root);
  await git(root, ["add", "-A"]);
  const names = await git(root, ["diff", "--cached", "--name-status", tag]);
  const diff = await git(root, ["diff", "--cached", tag]);
  await git(root, ["reset", "-q"]);
  const files = names
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status ?? "M", path: rest[rest.length - 1] ?? "" };
    });
  return { files, diff: diff.length > 400_000 ? `${diff.slice(0, 400_000)}\n(diff truncated)` : diff };
}

/** Pushes the project to a GitHub repo with a short-lived token that is never written to disk. */
export async function pushToGitHub(root: string, opts: { remote: string; token: string; branch?: string; message?: string }): Promise<string> {
  const remote = new URL(opts.remote);
  if (remote.protocol !== "https:" || remote.hostname !== "github.com") throw new Error("Only https://github.com repositories are supported.");
  await ensureRepo(root);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "--allow-empty", "-m", opts.message ?? "Export from CoderBaba"]);
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`;
  await git(root, ["-c", `http.extraHeader=${header}`, "push", "-q", remote.toString(), `HEAD:refs/heads/${opts.branch ?? "main"}`]);
  return git(root, ["rev-parse", "HEAD"]);
}
