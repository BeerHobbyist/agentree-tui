/**
 * Core domain types shared by the real (git/gh-backed) data layer and the UI.
 *
 * Kept UI-agnostic: the sidebar renders `Project[]`, the store/services produce
 * it. Volatile git status lives on `Worktree` but is computed at runtime, never
 * persisted.
 */

/**
 * What the agent (Claude Code) in a worktree's terminal is up to:
 * - `none`: no agent session reporting in this worktree
 * - `idle`: running, nothing to do (or its finished turn has been seen)
 * - `working`: processing a prompt
 * - `needs-action`: blocked on you — a permission prompt or a question
 * - `done`: finished a turn you haven't looked at yet
 */
export type AgentStatus = "none" | "idle" | "working" | "needs-action" | "done";

/** Where a CI check (or a PR's checks overall) stands. */
export type CheckState = "pass" | "fail" | "pending" | "skipped";

/** Open pull request associated with a worktree's branch. */
export interface PrInfo {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  /** Its checks overall, when it has any. */
  checks?: CheckState;
}

/** One CI check on a pull request. */
export interface PrCheck {
  name: string;
  /** The workflow it belongs to (GitHub Actions), if any. */
  workflow?: string;
  state: CheckState;
  url?: string;
}

/** A reviewer and where their review stands. */
export interface PrReviewer {
  login: string;
  state: "approved" | "changes-requested" | "commented" | "requested" | "dismissed";
}

/** A comment on a pull request: conversation, a review's summary, or inline on the code. */
export interface PrComment {
  kind: "comment" | "review" | "inline";
  author: string;
  body: string;
  /** ISO timestamp. */
  createdAt: string;
  url?: string;
  /** Inline comments: where in the diff. */
  path?: string;
  line?: number;
  /** Review summaries: the verdict it came with. */
  reviewState?: PrReviewer["state"];
}

/** Everything the PR panel shows. */
export interface PrDetails {
  number: number;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  author: string;
  base: string;
  head: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** ISO timestamp. */
  updatedAt: string;
  /** GitHub's mergeability, e.g. CLEAN, DIRTY, BLOCKED, BEHIND, UNSTABLE, UNKNOWN. */
  mergeStateStatus: string;
  /** MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
  reviewDecision: "approved" | "changes-requested" | "review-required" | null;
  reviewers: PrReviewer[];
  checks: PrCheck[];
  labels: string[];
  body: string;
  /** Newest first. */
  comments: PrComment[];
}

/** An open pull request offered when creating a worktree, with its source branch. */
export interface OpenPr extends PrInfo {
  headRefName: string;
}

export interface Worktree {
  id: string;
  /** Short label shown in the list, usually the branch's leaf name. */
  name: string;
  /** Full git branch. */
  branch: string;
  /** Working-tree path on disk. */
  path: string;
  /** Uncommitted changes present (tracked or untracked). */
  dirty: boolean;
  /** How many files have uncommitted changes (`git status --porcelain` entries). */
  changed: number;
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
  /** Open PR for this branch, if any (filled by a background lookup). */
  pr?: PrInfo;
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
