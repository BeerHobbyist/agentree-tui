/**
 * Core domain types shared by the real (git/gh-backed) data layer and the UI.
 *
 * Kept UI-agnostic: the sidebar renders `Project[]`, the store/services produce
 * it. Volatile git status lives on `Worktree` but is computed at runtime, never
 * persisted.
 */

export type AgentStatus = "none" | "working" | "waiting";

export interface Worktree {
  id: string;
  /** Short label shown in the list, usually the branch's leaf name. */
  name: string;
  /** Full git branch. */
  branch: string;
  /** Working-tree path on disk. */
  path: string;
  /** Uncommitted changes present. */
  dirty: boolean;
  /** Staged/working line stats, for the "+12 −3" badge (0 until computed). */
  added: number;
  removed: number;
  /** Commits ahead / behind the upstream. */
  ahead: number;
  behind: number;
  /** State of the agent running in this worktree, if any. */
  agent: AgentStatus;
  /** Registered in state but its directory is gone on disk. */
  missing?: boolean;
}

export interface Project {
  id: string;
  name: string;
  /** Repo root path (the main clone). */
  root: string;
  worktrees: Worktree[];
}

/** A GitHub repository as returned by `gh repo list --json`. */
export interface RepoSummary {
  name: string;
  nameWithOwner: string;
  description: string;
  isPrivate: boolean;
  updatedAt: string;
  url: string;
}
