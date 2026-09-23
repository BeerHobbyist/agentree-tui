/**
 * Thin async wrappers over the `gh` CLI.
 */
import type { OpenPr, PrInfo, RepoSummary } from "../data/model";
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
export async function prForBranch(nameWithOwner: string, branch: string): Promise<PrInfo | null> {
  const out = await runOrThrow([
    "gh",
    "pr",
    "list",
    "-R",
    nameWithOwner,
    "--head",
    branch,
    "--state",
    "open",
    "--limit",
    "1",
    "--json",
    "number,title,url,isDraft,statusCheckRollup",
  ]);
  const [pr] = JSON.parse(out) as {
    number: number;
    title: string;
    url: string;
    isDraft: boolean;
    statusCheckRollup?: RawCheck[] | null;
  }[];
  if (!pr) return null;
  const checks = summarizeChecks((pr.statusCheckRollup ?? []).map(checkState));
  return {
    number: pr.number,
    title: pr.title ?? "",
    url: pr.url ?? "",
    draft: !!pr.isDraft,
    ...(checks ? { checks } : {}),
  };
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
