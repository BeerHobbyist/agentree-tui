/**
 * Thin async wrappers over the `gh` CLI.
 */
import type { RepoSummary } from "../data/model";
import { run, runOrThrow } from "./proc";

/** List the authenticated user's repositories, most-recently-updated first. */
export async function listRepos(limit = 200): Promise<RepoSummary[]> {
  const out = await runOrThrow([
    "gh",
    "repo",
    "list",
    "--limit",
    String(limit),
    "--json",
    "name,nameWithOwner,description,isPrivate,updatedAt,url",
  ]);
  const parsed = JSON.parse(out) as RepoSummary[];
  // gh already sorts by pushed/updated; keep as-is but ensure shape.
  return parsed.map((r) => ({
    name: r.name,
    nameWithOwner: r.nameWithOwner,
    description: r.description ?? "",
    isPrivate: !!r.isPrivate,
    updatedAt: r.updatedAt ?? "",
    url: r.url ?? "",
  }));
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
