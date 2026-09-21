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

export interface TermStyle {
  /** Hex background, e.g. "#0d0f14". */
  bg: string;
  /** Hex foreground, e.g. "#e6e9ef". */
  fg: string;
  /** Hex pane border color. */
  border?: string;
  /** Hex active-pane border color. */
  borderActive?: string;
}

/**
 * Command to run in a PTY: attach the session if it exists, else create it.
 * Turns the status bar off (session-scoped, not `-g`) so the embedded terminal
 * shows only the shell — no tmux footer chrome — and applies the app's theme
 * colors to the pane so the terminal blends with the UI.
 */
export function attachCommand(
  session: string,
  cwd: string,
  style?: TermStyle,
): string[] {
  const cmd = [
    "tmux",
    "new-session",
    "-A",
    "-s",
    session,
    "-c",
    cwd,
    ";",
    "set-option",
    "status",
    "off",
  ];
  if (style) {
    const s = `bg=${style.bg},fg=${style.fg}`;
    cmd.push(
      ";",
      "set-option",
      "window-style",
      s,
      ";",
      "set-option",
      "window-active-style",
      s,
    );
    if (style.border) {
      cmd.push(
        ";",
        "set-option",
        "pane-border-style",
        `fg=${style.border}`,
        ";",
        "set-option",
        "pane-active-border-style",
        `fg=${style.borderActive ?? style.border}`,
      );
    }
  }
  return cmd;
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

// --- window (tab) + pane (split) helpers ---

export interface WindowInfo {
  index: number;
  name: string;
  active: boolean;
  panes: number;
}

/** List a session's windows (tabs). Empty if the session is gone. */
export async function listWindows(session: string): Promise<WindowInfo[]> {
  const { code, stdout } = await run([
    "tmux",
    "list-windows",
    "-t",
    session,
    "-F",
    "#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}",
  ]);
  if (code !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [index, name, active, panes] = line.split("\t");
      return {
        index: parseInt(index || "0", 10) || 0,
        name: name || "",
        active: active === "1",
        panes: parseInt(panes || "1", 10) || 1,
      };
    });
}

export async function newWindow(session: string, cwd: string): Promise<void> {
  await run(["tmux", "new-window", "-t", session, "-c", cwd]);
}

export async function selectWindow(
  session: string,
  index: number,
): Promise<void> {
  await run(["tmux", "select-window", "-t", `${session}:${index}`]);
}

/** Split the session's active pane. `h` = left/right, `v` = top/bottom. */
export async function splitWindow(
  session: string,
  dir: "h" | "v",
  cwd: string,
): Promise<void> {
  await run(["tmux", "split-window", `-${dir}`, "-t", session, "-c", cwd]);
}

/** Kill the active pane; killing the last pane closes its window (tab). */
export async function killPane(session: string): Promise<void> {
  await run(["tmux", "kill-pane", "-t", session]);
}
