/**
 * Thin async wrappers over `git`.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { run, runOrThrow } from "./proc";

/**
 * A path with its symlinks resolved, the way git reports worktree paths — for
 * comparing a path agentree has with one from git, never for storing. A repo
 * reached through a symlink (a code folder on another disk, `/home` →
 * `/var/home` on Fedora Silverblue, macOS's `/tmp` → `/private/tmp`) is listed
 * by git under its real path. For a path that's gone, its nearest existing
 * parent is resolved.
 */
export function canonicalPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
  }
}

/**
 * Make git ignore our `.worktrees/` directory locally, so the main working copy
 * isn't reported dirty just because worktrees live inside the repo. Uses
 * `.git/info/exclude` (local, uncommitted) rather than the tracked `.gitignore`.
 */
export function ignoreWorktreesDir(root: string): void {
  try {
    const excludePath = join(root, ".git", "info", "exclude");
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (current.split("\n").some((l) => l.trim() === ".worktrees/")) return;
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    appendFileSync(excludePath, prefix + ".worktrees/\n");
  } catch {
    // Best-effort; a non-standard .git layout just means main may show dirty.
  }
}

export interface GitWorktree {
  path: string;
  /** Branch name (without refs/heads/), or undefined if detached. */
  branch?: string;
  head?: string;
  detached: boolean;
}

/** Parse `git worktree list --porcelain`. First entry is the main working copy. */
export async function listWorktrees(root: string): Promise<GitWorktree[]> {
  const out = await runOrThrow(["git", "worktree", "list", "--porcelain"], { cwd: root });
  const worktrees: GitWorktree[] = [];
  let current: Partial<GitWorktree> | null = null;

  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) worktrees.push(finalizeWorktree(current));
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      if (current) current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      if (current) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      if (current) current.detached = true;
    }
  }
  if (current?.path) worktrees.push(finalizeWorktree(current));
  return worktrees;
}

function finalizeWorktree(w: Partial<GitWorktree>): GitWorktree {
  return {
    path: w.path!,
    branch: w.branch,
    head: w.head,
    detached: !!w.detached,
  };
}

/**
 * Add a worktree. `newBranch` creates the branch (`-b`); `base` (only meaningful
 * with `newBranch`) is the ref it starts from, default the current HEAD.
 */
export async function addWorktree(
  root: string,
  path: string,
  branch: string,
  opts: { newBranch: boolean; base?: string },
): Promise<void> {
  const args = opts.newBranch
    ? ["git", "worktree", "add", path, "-b", branch, ...(opts.base ? [opts.base] : [])]
    : ["git", "worktree", "add", path, branch];
  await runOrThrow(args, { cwd: root });
}

/**
 * Remove a worktree: deletes its directory and git's bookkeeping for it.
 * `force` also discards uncommitted changes, which callers must confirm with
 * the user first since this is destructive and cannot be undone. A path git
 * no longer tracks (removed or pruned outside agentree) is left alone, since
 * `git worktree remove` fails on it.
 */
export async function removeWorktree(root: string, path: string, opts: { force?: boolean } = {}): Promise<void> {
  const key = canonicalPath(path);
  if (!(await listWorktrees(root)).some((w) => canonicalPath(w.path) === key)) return;
  const args = ["git", "worktree", "remove", path];
  if (opts.force) args.push("--force");
  await runOrThrow(args, { cwd: root });
}

/**
 * Fetch a PR's head commit into local branch `branch` (created or moved to
 * match). Uses GitHub's `refs/pull/<n>/head`, which works for PRs from forks
 * too, unlike fetching `headRefName` directly off `origin`.
 */
export async function fetchPrBranch(root: string, prNumber: number, branch: string): Promise<void> {
  await runOrThrow(["git", "fetch", "origin", `+refs/pull/${prNumber}/head:refs/heads/${branch}`], { cwd: root });
}

/**
 * Best-effort base branch ref for "diff vs base": the remote's default branch
 * (origin/HEAD) if known, else origin/main, else main/master.
 */
export async function baseRef(path: string): Promise<string> {
  const head = await run(["git", "rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd: path });
  if (head.code === 0) {
    const ref = head.stdout.trim();
    if (ref && ref !== "origin/HEAD") return ref;
  }
  for (const cand of ["origin/main", "origin/master", "main", "master"]) {
    const { code } = await run(["git", "rev-parse", "--verify", "--quiet", cand], { cwd: path });
    if (code === 0) return cand;
  }
  return "main";
}

/** The commit a worktree has checked out, or null. */
export async function headCommit(path: string): Promise<string | null> {
  const { code, stdout } = await run(["git", "rev-parse", "HEAD"], { cwd: path });
  return code === 0 ? stdout.trim() : null;
}

/** True if `commit` is `head` or in its history — false if not, or if git doesn't have `commit`. */
export async function isAncestor(path: string, commit: string, head: string): Promise<boolean> {
  const { code } = await run(["git", "merge-base", "--is-ancestor", commit, head], { cwd: path });
  return code === 0;
}

/** True if a local branch with this exact name exists. */
export async function localBranchExists(root: string, branch: string): Promise<boolean> {
  const { code } = await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root });
  return code === 0;
}

export interface WorktreeStatus {
  dirty: boolean;
  /** Files with uncommitted changes, untracked included. */
  changed: number;
  added: number;
  removed: number;
  ahead: number;
  behind: number;
}

/** Compute live status for a worktree. Best-effort: failures degrade to zeros. */
export async function status(path: string): Promise<WorktreeStatus> {
  const result: WorktreeStatus = {
    dirty: false,
    changed: 0,
    added: 0,
    removed: 0,
    ahead: 0,
    behind: 0,
  };

  const porcelain = await run(["git", "status", "--porcelain"], { cwd: path });
  if (porcelain.code === 0) {
    result.changed = porcelain.stdout.split("\n").filter((l) => l.trim()).length;
    result.dirty = result.changed > 0;
  }

  const numstat = await run(["git", "diff", "--numstat", "HEAD"], { cwd: path });
  if (numstat.code === 0) {
    for (const line of numstat.stdout.split("\n")) {
      const [a, r] = line.split("\t");
      if (a && a !== "-") result.added += parseInt(a, 10) || 0;
      if (r && r !== "-") result.removed += parseInt(r, 10) || 0;
    }
  }

  // ahead/behind vs upstream; errors (no upstream) leave zeros.
  const rl = await run(["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd: path });
  if (rl.code === 0) {
    const [behind, ahead] = rl.stdout.trim().split(/\s+/);
    result.behind = parseInt(behind || "0", 10) || 0;
    result.ahead = parseInt(ahead || "0", 10) || 0;
  }

  return result;
}
