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
let repoCache: RepoSummary[] | null = null;

export async function listRepos(force = false): Promise<RepoSummary[]> {
  if (repoCache && !force) return repoCache;
  const out = await runOrThrow([
    "gh",
    "api",
    "--paginate",
    "--slurp",
    "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
  ]);
  const pages = JSON.parse(out) as ApiRepo[][];
  repoCache = pages.flat().map((r) => ({
    name: r.name,
    nameWithOwner: r.full_name,
    description: r.description ?? "",
    isPrivate: !!r.private,
    updatedAt: r.pushed_at ?? r.updated_at ?? "",
    url: r.html_url ?? "",
  }));
  return repoCache;
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
