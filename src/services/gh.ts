/**
 * Thin async wrappers over the `gh` CLI.
 */
import type { OpenPr, PrInfo, RepoSummary } from "../data/model";
import { run, runOrThrow } from "./proc";

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

// Full accumulated list, cached so reopening the modal is instant.
let repoCache: RepoSummary[] | null = null;
export function getCachedRepos(): RepoSummary[] | null {
  return repoCache;
}
export function setRepoCache(repos: RepoSummary[]): void {
  repoCache = repos;
}
export function clearRepoCache(): void {
  repoCache = null;
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

// Cache PR lookups per repo+branch for the session (network calls are slow).
const prCache = new Map<string, PrInfo | null>();

/** Drop every cached PR lookup (tests, and a future manual refresh). */
export function clearPrCache(): void {
  prCache.clear();
}

/** The open PR whose head is `branch`, or null. Cached; `force` refetches. */
export async function prForBranch(
  nameWithOwner: string,
  branch: string,
  force = false,
): Promise<PrInfo | null> {
  const key = `${nameWithOwner}#${branch}`;
  if (!force && prCache.has(key)) return prCache.get(key)!;
  let result: PrInfo | null = null;
  try {
    const { code, stdout } = await run([
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
      "number,title,url,isDraft",
    ]);
    if (code === 0) {
      const arr = JSON.parse(stdout) as {
        number: number;
        title: string;
        url: string;
        isDraft: boolean;
      }[];
      const pr = arr[0];
      if (pr)
        result = {
          number: pr.number,
          title: pr.title ?? "",
          url: pr.url ?? "",
          draft: !!pr.isDraft,
        };
    }
  } catch {
    result = null;
  }
  prCache.set(key, result);
  return result;
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
