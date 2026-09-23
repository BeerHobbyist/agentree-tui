/** Domain fixtures for tests that do not need a real repo on disk. */
import type { Project, Worktree } from "../../src/data/model";

export function worktree(id: string, extra: Partial<Worktree> = {}): Worktree {
  return {
    id,
    name: id,
    branch: id,
    path: `/tmp/${id}`,
    dirty: false,
    changed: 0,
    added: 0,
    removed: 0,
    ahead: 0,
    behind: 0,
    agent: "none",
    ...extra,
  };
}

export function project(id: string, worktrees: Worktree[] = [], extra: Partial<Project> = {}): Project {
  const [, name = id] = id.split("/");
  return { id, name, root: `/tmp/${name}`, worktrees, ...extra };
}
