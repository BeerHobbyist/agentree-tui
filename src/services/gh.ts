/**
 * Thin async wrappers over the `gh` CLI.
 */
import type { RepoSummary } from "../data/model";
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
