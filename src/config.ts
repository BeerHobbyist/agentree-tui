/**
 * Workspace + state-file locations and path helpers.
 *
 * Two distinct roots:
 *  - the workspace (`~/agentree`) where repos are cloned and worktrees created;
 *  - the config dir (`~/.config/agentree`) where the app's state.json lives.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Where repos are cloned and worktrees created. Override with AGENTREE_HOME. */
export function workspaceRoot(): string {
  return process.env.AGENTREE_HOME || join(homedir(), "agentree");
}

/** Absolute path to the persisted app state (XDG-aware). */
export function stateFilePath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "agentree", "state.json");
}

/** Directory a repo is cloned into, e.g. ~/agentree/<repo>. */
export function repoDir(repoName: string): string {
  return join(workspaceRoot(), repoName);
}

/** Directory for a worktree of `branch` under a repo root. */
export function worktreePath(root: string, branch: string): string {
  return join(root, ".worktrees", sanitizeBranchForPath(branch));
}

/**
 * Turn a branch name into a filesystem-safe directory segment. Only the
 * directory is sanitized — the real branch keeps its slashes.
 */
export function sanitizeBranchForPath(branch: string): string {
  return (
    branch
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "worktree"
  );
}

/** Leaf segment of a branch, used as the display name (e.g. feature/x → x). */
export function branchLeaf(branch: string): string {
  const parts = branch.split("/");
  return parts[parts.length - 1] || branch;
}

/**
 * Shell command run in a worktree's terminal the first time its tmux session
 * is created (tmux ignores it on later re-attaches, so it only ever fires
 * once per worktree). Override with AGENTREE_AGENT_CMD; defaults to `claude`,
 * wrapped in `caffeinate -is` on macOS so the agent keeps running through
 * sleep/lid-close.
 */
/**
 * The agent started by ⌥a in an SSH project's terminal: plain `claude` on the
 * host (its status hooks are a file on this machine). AGENTREE_AGENT_CMD
 * overrides it too.
 */
export function remoteAgentCommand(): string {
  return process.env.AGENTREE_AGENT_CMD || "claude";
}

export function agentCommand(): string {
  const override = process.env.AGENTREE_AGENT_CMD;
  if (override) return override;
  return process.platform === "darwin" ? "caffeinate -is claude" : "claude";
}
