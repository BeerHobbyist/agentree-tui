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
 * with `newBranch`) is the ref it starts from, default the current HEAD. A new
 * branch never tracks its base: started from `origin/main` it would otherwise
 * push to main, and report ahead/behind against it.
 */
export async function addWorktree(
  root: string,
  path: string,
  branch: string,
  opts: { newBranch: boolean; base?: string },
): Promise<void> {
  const args = opts.newBranch
    ? [
        "git",
        "worktree",
        "add",
        ...(opts.base ? ["--no-track"] : []),
        path,
        "-b",
        branch,
        ...(opts.base ? [opts.base] : []),
      ]
    : ["git", "worktree", "add", path, branch];
  await runOrThrow(args, { cwd: root });
}

/** Long enough for a slow network, short enough that being offline doesn't stall creating a worktree. */
const FETCH_TIMEOUT_MS = 20_000;

export interface FreshBase {
  /** The ref to start from: `base`, or its upstream when that has `base` and more. */
  ref?: string;
  /** Why `ref` may not be the latest: the fetch failed, or the local branch and its upstream have diverged. */
  warning?: string;
}

/**
 * The latest version of `base` (a branch or other ref; omitted = what the main
 * copy has checked out), to start a new branch from. Its branch is fetched
 * from the remote first. A local branch behind its upstream gives way to the
 * upstream, so the local branch itself is never moved; one with commits the
 * upstream lacks is kept. A tag, a commit, or a branch with no remote comes
 * back unchanged.
 */
export async function freshBase(root: string, base?: string): Promise<FreshBase> {
  const resolved = await run(["git", "rev-parse", "--symbolic-full-name", base ?? "HEAD"], { cwd: root });
  const full = resolved.code === 0 ? resolved.stdout.trim() : "";

  if (full.startsWith("refs/heads/")) {
    const out = await run(
      ["git", "for-each-ref", "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)", full],
      { cwd: root },
    );
    const [upstream = "", remote = "", remoteRef = ""] = out.stdout.trim().split("\0");
    // `.` is a local branch tracking another local branch: nothing to fetch.
    if (!upstream || !remote || remote === ".") return { ref: base };
    const fetchError = await fetchInto(root, remote, remoteRef, upstream);
    const behind = await isAncestor(root, full, upstream);
    const ref = behind ? upstream : base;
    if (fetchError) return { ref, warning: stale(ref ?? full, fetchError) };
    // Neither has all of the other's commits: the upstream's are left out.
    if (!behind && !(await isAncestor(root, upstream, full))) {
      const [local, theirs] = [shortRef(full), shortRef(upstream)];
      return {
        ref,
        warning: `${local} and ${theirs} have diverged, so this starts from ${local} without ${theirs}'s new commits`,
      };
    }
    return { ref };
  }

  if (full.startsWith("refs/remotes/")) {
    const remotes = (await run(["git", "remote"], { cwd: root })).stdout.split("\n").filter(Boolean);
    // The longest match, as a remote's name can be a prefix of another's (`origin`, `origin/fork`).
    const remote = remotes.filter((r) => full.startsWith(`refs/remotes/${r}/`)).sort((a, b) => b.length - a.length)[0];
    if (!remote) return { ref: base };
    const branch = full.slice(`refs/remotes/${remote}/`.length);
    const fetchError = await fetchInto(root, remote, `refs/heads/${branch}`, full);
    return fetchError ? { ref: base, warning: stale(full, fetchError) } : { ref: base };
  }

  return { ref: base };
}

function stale(ref: string, fetchError: string): string {
  return `Couldn't fetch, so ${shortRef(ref)} is as of the last fetch: ${fetchError}`;
}

/** `main` for `refs/heads/main`, `origin/main` for `refs/remotes/origin/main`. */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, "");
}

/** Fetch `remote`'s `src` into `dst`, giving up after FETCH_TIMEOUT_MS. Git's error when it fails. */
async function fetchInto(root: string, remote: string, src: string, dst: string): Promise<string | undefined> {
  const error = await gitFetch(root, [remote, `+${src}:${dst}`], FETCH_TIMEOUT_MS);
  return error === "" ? `git fetch ${remote} gave up after ${FETCH_TIMEOUT_MS / 1000}s` : error;
}

/**
 * `git fetch` with nothing allowed to prompt: over HTTPS git would ask for
 * credentials, over SSH ssh would ask for a passphrase or to trust a host key,
 * on the terminal the TUI is drawing on. It runs with no terminal to prompt
 * on, so every prompt goes to an askpass instead: the user's own (a GUI one)
 * if they have one, else one that fails, which makes the prompt an error.
 * Undefined on success, else git's error (empty when git said nothing, as
 * when killed by the timeout).
 */
async function gitFetch(root: string, args: string[], timeoutMs?: number): Promise<string | undefined> {
  const { code, stderr } = await run(["git", "fetch", "--quiet", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS: process.env.SSH_ASKPASS || "false",
      SSH_ASKPASS_REQUIRE: "force",
    },
    timeoutMs,
    detached: true,
  });
  if (code === 0) return undefined;
  // Our failing askpass's own complaint says nothing about why the fetch failed.
  const why = stderr
    .split("\n")
    .filter((l) => !l.includes("askpass response from 'false'"))
    .join("\n")
    .trim();
  // A refused prompt reads like a missing key or account; say what would have answered it.
  // ssh's own "Permission denied" lists the methods it tried, `(publickey)`; a file's doesn't.
  return /Permission denied \(|Host key verification failed|terminal prompts disabled/.test(why)
    ? `${why}\nagentree can't answer a login or passphrase prompt: load your key with ssh-add, or fetch once in a terminal.`
    : why;
}

export interface Branches {
  /** The branch the working copy has checked out, or null when detached. */
  current: string | null;
  /** Local branches, most recently committed first. */
  local: string[];
  /** Remote-tracking branches (`origin/main`), most recently committed first. */
  remote: string[];
}

/** Every branch a new one could start from, as of the last fetch. */
export async function listBranches(root: string): Promise<Branches> {
  const [head, refs] = await Promise.all([
    run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }),
    runOrThrow(["git", "for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"], {
      cwd: root,
    }),
  ]);
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of refs.split("\n")) {
    if (ref.startsWith("refs/heads/")) local.push(ref.slice("refs/heads/".length));
    // `origin/HEAD` only points at another remote branch.
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) remote.push(ref.slice("refs/remotes/".length));
  }
  return { current: head.code === 0 ? head.stdout.trim() || null : null, local, remote };
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
  const error = await gitFetch(root, ["origin", `+refs/pull/${prNumber}/head:refs/heads/${branch}`]);
  if (error !== undefined) throw new Error(error || `git fetch origin failed for PR #${prNumber}`);
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

export interface Commit {
  sha: string;
  /** The abbreviated sha, as git shows it. */
  short: string;
  subject: string;
  /** What the commit is diffed against: its first parent, or the empty tree for a repo's first commit. */
  parent: string;
}

/**
 * The commits a diff can be picked from, newest first: the branch's own
 * (`base..HEAD`), or — when it has none, as on the base branch itself — HEAD's
 * latest. First parents only, so each commit's parent is the next one listed
 * and a run of them is one range: a merged-in branch is its merge commit.
 * Empty when git fails (no commits yet, not a repo).
 */
export async function branchCommits(path: string, base: string, limit = 200, fallback = 50): Promise<Commit[]> {
  const log = async (args: string[]) => {
    const { code, stdout } = await run(["git", "log", "--first-parent", "--format=%H%x1f%h%x1f%P%x1f%s", ...args], {
      cwd: path,
    });
    return code === 0 ? stdout.split("\n").filter(Boolean) : [];
  };
  let lines = await log([`--max-count=${limit}`, `${base}..HEAD`]);
  if (lines.length === 0) lines = await log([`--max-count=${fallback}`, "HEAD"]);

  let emptyTree: string | undefined;
  const commits: Commit[] = [];
  for (const line of lines) {
    const [sha = "", short = "", parents = "", subject = ""] = line.split("\x1f");
    let parent = parents.split(" ")[0];
    if (!parent) {
      emptyTree ??= (await runOrThrow(["git", "hash-object", "-t", "tree", "/dev/null"], { cwd: path })).trim();
      parent = emptyTree;
    }
    commits.push({ sha, short, subject, parent });
  }
  return commits;
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
