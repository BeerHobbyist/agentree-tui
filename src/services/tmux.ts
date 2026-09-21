/**
 * tmux integration. tmux backs each embedded terminal so processes survive app
 * restarts: one session per worktree, one window per terminal instance.
 */
import { createHash } from "node:crypto";
import { run } from "./proc";

/** True if the tmux binary is present and runnable. */
export async function isAvailable(): Promise<boolean> {
  try {
    const { code } = await run(["tmux", "-V"]);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Stable, tmux-safe session name for a worktree. tmux forbids `.` and `:` in
 * names, so we slug the identifier and append a short hash to avoid collisions.
 */
export function sessionName(repoId: string, worktreeId: string): string {
  const raw = `${repoId}:${worktreeId}`;
  const slug = raw
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `agentree_${slug}_${hash}`;
}

/** Command to run in a PTY: attach the session if it exists, else create it. */
export function attachCommand(session: string, cwd: string): string[] {
  return ["tmux", "new-session", "-A", "-s", session, "-c", cwd];
}

/** Whether a session already exists (used for a "live" indicator). */
export async function hasSession(session: string): Promise<boolean> {
  try {
    const { code } = await run(["tmux", "has-session", "-t", session]);
    return code === 0;
  } catch {
    return false;
  }
}

// --- window helpers (for multiple terminals per worktree, a later step) ---

export async function newWindow(session: string, cwd: string): Promise<void> {
  await run(["tmux", "new-window", "-t", session, "-c", cwd]);
}

export async function listWindows(session: string): Promise<string[]> {
  const { stdout } = await run([
    "tmux",
    "list-windows",
    "-t",
    session,
    "-F",
    "#{window_index}:#{window_name}",
  ]);
  return stdout.trim().split("\n").filter(Boolean);
}

export async function selectWindow(
  session: string,
  index: number,
): Promise<void> {
  await run(["tmux", "select-window", "-t", `${session}:${index}`]);
}
