/**
 * Thin async wrappers over the `gh` CLI.
 */
import type { OpenPr, PrInfo, RepoSummary } from "../data/model";
import { headCommit, isAncestor } from "./git";
import { run, runOrThrow } from "./proc";
import { checkState, summarizeChecks, type RawCheck } from "./pr";

/** Shape of the GitHub REST `/user/repos` items we care about. */
interface ApiRepo {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  pushed_at: string | null;
  updated_at: string | null;
  html_url: string | null;
}

/**
 * List every repository the token can access — owned, collaborator, and org
 * repos — most-recently-pushed first. Uses the REST `/user/repos` endpoint
 * (`gh repo list` only returns the user's own repos). `--slurp` returns one
 * array per page, so the result is flattened.
 */
const PER_PAGE = 100;

export interface RepoPage {
  repos: RepoSummary[];
  page: number;
  /** Whether another page likely exists (this page was full). */
  hasMore: boolean;
}

/** Fetch a single page of accessible repos, most-recently-pushed first. */
export async function fetchRepoPage(page: number): Promise<RepoPage> {
  const out = await runOrThrow([
    "gh",
    "api",
    `user/repos?per_page=${PER_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
  ]);
  const arr = JSON.parse(out) as ApiRepo[];
  return {
    repos: arr.map((r) => ({
      name: r.name,
      nameWithOwner: r.full_name,
      description: r.description ?? "",
      isPrivate: !!r.private,
      updatedAt: r.pushed_at ?? r.updated_at ?? "",
      url: r.html_url ?? "",
    })),
    page,
    hasMore: arr.length === PER_PAGE,
  };
}

/** Clone a repo (owner/name) into `dest`. Throws with stderr on failure. */
export async function clone(nameWithOwner: string, dest: string): Promise<void> {
  await runOrThrow(["gh", "repo", "clone", nameWithOwner, dest]);
}

/** True if `gh` is installed and authenticated. */
export async function isAuthenticated(): Promise<boolean> {
  const { code } = await run(["gh", "auth", "status"]);
  return code === 0;
}

/**
 * The open PR whose head is `branch`, or null when there is none. A failed
 * lookup throws rather than answering "no PR", so a cache holding the last good
 * answer (src/queries.ts) keeps showing it through a network hiccup.
 */
export async function prForBranch(
  nameWithOwner: string,
  branch: string,
  worktreePath?: string,
): Promise<PrInfo | null> {
  const out = await runOrThrow([
    "gh",
    "pr",
    "list",
    "-R",
    nameWithOwner,
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "5",
    "--json",
    "number,title,url,isDraft,statusCheckRollup,state,headRefOid,mergeCommit,commits",
  ]);
  const prs = JSON.parse(out) as BranchPr[];
  const open = prs.find((pr) => pr.state === "OPEN");
  if (open) {
    const checks = summarizeChecks((open.statusCheckRollup ?? []).map(checkState));
    return { ...prInfo(open), ...(checks ? { checks } : {}) };
  }
  if (!worktreePath) return null;
  for (const pr of prs) {
    if (pr.state === "MERGED" && (await isThisBranchsPr(worktreePath, pr))) return { ...prInfo(pr), merged: true };
  }
  return null;
}

/** A PR as `gh pr list --head` lists it. */
interface BranchPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  statusCheckRollup?: RawCheck[] | null;
  headRefOid?: string;
  mergeCommit?: { oid: string } | null;
  commits?: { oid: string }[];
}

function prInfo(pr: BranchPr): PrInfo {
  return { number: pr.number, title: pr.title ?? "", url: pr.url ?? "", draft: !!pr.isDraft };
}

/**
 * Whether a merged PR with this branch's name was made from this worktree's
 * branch — not an older one that happened to have the same name, and not a
 * fork's `main` merged into ours. Its commits are this branch's (it's at one
 * of them, or past the PR's head), and what the merge made isn't in it yet
 * (as it is in a branch started from main after the merge).
 */
async function isThisBranchsPr(worktreePath: string, pr: BranchPr): Promise<boolean> {
  const head = await headCommit(worktreePath);
  if (!head) return false;
  const ours =
    pr.headRefOid === head ||
    (pr.commits ?? []).some((c) => c.oid === head) ||
    (!!pr.headRefOid && (await isAncestor(worktreePath, pr.headRefOid, head)));
  if (!ours) return false;
  return !(pr.mergeCommit && (await isAncestor(worktreePath, pr.mergeCommit.oid, head)));
}

/** All open PRs for a repo, most-recently-updated first. Best-effort: [] on failure. */
export async function listOpenPrs(nameWithOwner: string): Promise<OpenPr[]> {
  try {
    const { code, stdout } = await run([
      "gh",
      "pr",
      "list",
      "-R",
      nameWithOwner,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,isDraft,headRefName",
    ]);
    if (code !== 0) return [];
    const arr = JSON.parse(stdout) as {
      number: number;
      title: string;
      url: string;
      isDraft: boolean;
      headRefName: string;
    }[];
    return arr.map((pr) => ({
      number: pr.number,
      title: pr.title ?? "",
      url: pr.url ?? "",
      draft: !!pr.isDraft,
      headRefName: pr.headRefName,
    }));
  } catch {
    return [];
  }
}
