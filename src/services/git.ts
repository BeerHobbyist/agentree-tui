/**
 * Thin async wrappers over `git`.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run, runOrThrow } from "./proc";

/**
 * Make git ignore our `.worktrees/` directory locally, so the main working copy
 * isn't reported dirty just because worktrees live inside the repo. Uses
 * `.git/info/exclude` (local, uncommitted) rather than the tracked `.gitignore`.
 */
export function ignoreWorktreesDir(root: string): void {
  try {
    const excludePath = join(root, ".git", "info", "exclude");
    const current = existsSync(excludePath)
      ? readFileSync(excludePath, "utf8")
      : "";
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
  const out = await runOrThrow(
    ["git", "worktree", "list", "--porcelain"],
    { cwd: root },
  );
  const worktrees: GitWorktree[] = [];
  let current: Partial<GitWorktree> | null = null;

  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) worktrees.push(finalizeWorktree(current));
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      if (current) current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      if (current)
        current.branch = line
          .slice("branch ".length)
          .replace(/^refs\/heads\//, "");
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

/** Add a worktree. `newBranch` creates the branch (`-b`), else checks out existing. */
export async function addWorktree(
  root: string,
  path: string,
  branch: string,
  opts: { newBranch: boolean },
): Promise<void> {
  const args = opts.newBranch
    ? ["git", "worktree", "add", path, "-b", branch]
    : ["git", "worktree", "add", path, branch];
  await runOrThrow(args, { cwd: root });
}

/** True if a local branch with this exact name exists. */
export async function localBranchExists(
  root: string,
  branch: string,
): Promise<boolean> {
  const { code } = await run(
    ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: root },
  );
  return code === 0;
}

export interface WorktreeStatus {
  dirty: boolean;
  added: number;
  removed: number;
  ahead: number;
  behind: number;
}

/** Compute live status for a worktree. Best-effort: failures degrade to zeros. */
export async function status(path: string): Promise<WorktreeStatus> {
  const result: WorktreeStatus = {
    dirty: false,
    added: 0,
    removed: 0,
    ahead: 0,
    behind: 0,
  };

  const porcelain = await run(["git", "status", "--porcelain"], { cwd: path });
  if (porcelain.code === 0) {
    result.dirty = porcelain.stdout.trim().length > 0;
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
  const rl = await run(
    ["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    { cwd: path },
  );
  if (rl.code === 0) {
    const [behind, ahead] = rl.stdout.trim().split(/\s+/);
    result.behind = parseInt(behind || "0", 10) || 0;
    result.ahead = parseInt(ahead || "0", 10) || 0;
  }

  return result;
}
