/**
 * Real git repositories for the integration and E2E tests. Nothing here is
 * mocked: the app shells out to git, so the tests give it actual repos.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "../../src/services/proc";
import type { Sandbox } from "./sandbox";

/** Run git in `cwd`, throwing with stderr when it fails. */
export async function git(args: string[], cwd: string): Promise<string> {
  const { code, stdout, stderr } = await run(["git", ...args], { cwd });
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

export function writeFile(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Commit everything in the working tree. */
export async function commitAll(root: string, message: string): Promise<void> {
  await git(["add", "-A"], root);
  await git(["commit", "-m", message], root);
}

export interface MakeRepoOptions {
  /** Initial branch name. Default "main". */
  branch?: string;
  /** Extra worktrees to create, each on a new branch. */
  worktrees?: { branch: string; path?: string }[];
}

/** An initialized repo with one commit, at `root`. */
export async function makeRepo(root: string, opts: MakeRepoOptions = {}): Promise<string> {
  const branch = opts.branch ?? "main";
  mkdirSync(root, { recursive: true });
  await git(["init", "-b", branch], root);
  writeFile(root, "README.md", "# fixture\n");
  await commitAll(root, "init");

  for (const wt of opts.worktrees ?? []) {
    const path = wt.path ?? join(root, ".worktrees", wt.branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
    await git(["worktree", "add", path, "-b", wt.branch], root);
  }
  return root;
}

/**
 * A fixture remote the fake `gh repo clone` can clone from, standing in for
 * the repo as it exists on GitHub.
 */
export async function makeRemote(
  sandbox: Sandbox,
  nameWithOwner: string,
  opts: MakeRepoOptions = {},
): Promise<string> {
  const path = join(sandbox.remotes, nameWithOwner.replace(/\//g, "_"));
  await makeRepo(path, opts);
  return path;
}

/**
 * Publish a PR head in a fixture remote the way GitHub does: a commit reachable
 * only through `refs/pull/<n>/head`, with no branch of its own (as for a fork).
 */
export async function addPrHead(
  remote: string,
  prNumber: number,
  branch: string,
): Promise<string> {
  const tmpBranch = `pr-fixture-${prNumber}`;
  await git(["checkout", "-q", "-b", tmpBranch], remote);
  writeFile(remote, `pr-${prNumber}.txt`, `pr ${prNumber}\n`);
  await commitAll(remote, `pr ${prNumber}`);
  const sha = (await git(["rev-parse", "HEAD"], remote)).trim();
  await git(["update-ref", `refs/pull/${prNumber}/head`, sha], remote);
  await git(["checkout", "-q", "-"], remote);
  await git(["branch", "-D", tmpBranch], remote);
  return sha;
}

/** Give `root` an upstream it is `ahead` commits ahead / `behind` behind. */
export async function withUpstream(
  root: string,
  { ahead = 0, behind = 0 }: { ahead?: number; behind?: number } = {},
): Promise<void> {
  const remote = root + ".remote.git";
  await git(["init", "--bare", "-b", "main", remote], dirname(root));
  await git(["remote", "add", "origin", remote], root);
  await git(["push", "-u", "origin", "HEAD"], root);

  for (let i = 0; i < behind; i++) {
    // Commit on a scratch clone and push, so `root` falls behind its upstream.
    const scratch = `${root}.scratch`;
    if (i === 0) await git(["clone", remote, scratch], dirname(root));
    writeFile(scratch, `upstream-${i}.txt`, `${i}\n`);
    await commitAll(scratch, `upstream ${i}`);
    await git(["push", "origin", "HEAD:main"], scratch);
  }
  if (behind > 0) await git(["fetch", "origin"], root);

  for (let i = 0; i < ahead; i++) {
    writeFile(root, `local-${i}.txt`, `${i}\n`);
    await commitAll(root, `local ${i}`);
  }
}
