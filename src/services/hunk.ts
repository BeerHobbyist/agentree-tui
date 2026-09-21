/**
 * Integration with the `hunk` diff viewer (npm `hunkdiff`, binary `hunk`).
 * We launch it in a tmux window at the worktree cwd; it auto-detects the repo.
 */
import { run } from "./proc";

export type DiffTarget = "working" | "staged" | "base" | "ref";

/** True if the `hunk` binary is on PATH. */
export async function isAvailable(): Promise<boolean> {
  try {
    const { code } = await run(["hunk", "--version"]);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Shell command that opens the requested diff in hunk. Runs in the worktree cwd
 * (hunk has no -C flag), so the tmux window must be created with `-c <path>`.
 */
export function diffCommand(target: DiffTarget, arg?: string): string {
  switch (target) {
    case "staged":
      return "hunk diff --staged";
    case "base":
      return `hunk diff ${arg || "main"}...HEAD`;
    case "ref":
      // Raw git-diff argument: a ref, or a range like "A..B" / "A...B".
      return `hunk diff ${arg || "HEAD"}`;
    case "working":
    default:
      return "hunk diff";
  }
}
