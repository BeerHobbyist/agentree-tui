/**
 * tmux integration. tmux backs each embedded terminal so processes survive app
 * restarts: one session per worktree, one window per terminal instance.
 */
import { createHash } from "node:crypto";
import { run } from "./proc";

/**
 * Dedicated tmux server socket for the app. Isolates our sessions from the
 * user's own tmux (so listing/killing never touches theirs) and lets us set
 * theme options globally (`-g`) so every window/tab inherits them.
 */
export const SOCKET = "agentree";

/** Build a `tmux -L <socket> …` argv. */
function tx(...args: string[]): string[] {
  return ["tmux", "-L", SOCKET, ...args];
}

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
 * Theme options are set globally (`-g`) on our dedicated server so they apply
 * to every window/tab (not just the first) — no tmux status bar, and pane +
 * background colors match the app.
 */
export function attachCommand(
  session: string,
  cwd: string,
  style?: TermStyle,
): string[] {
  const cmd = tx("new-session", "-A", "-s", session, "-c", cwd);
  cmd.push(";", "set-option", "-g", "status", "off");
  // Mouse on so clicking a split pane selects it (and scroll/resize work).
  cmd.push(";", "set-option", "-g", "mouse", "on");
  if (style) {
    const s = `bg=${style.bg},fg=${style.fg}`;
    cmd.push(
      ";",
      "set-option",
      "-g",
      "window-style",
      s,
      ";",
      "set-option",
      "-g",
      "window-active-style",
      s,
    );
    if (style.border) {
      cmd.push(
        ";",
        "set-option",
        "-g",
        "pane-border-style",
        `fg=${style.border}`,
        ";",
        "set-option",
        "-g",
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
    const { code } = await run(tx("has-session", "-t", session));
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
  const { code, stdout } = await run(
    tx(
      "list-windows",
      "-t",
      session,
      "-F",
      "#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}",
    ),
  );
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
  await run(tx("new-window", "-t", session, "-c", cwd));
}

export async function selectWindow(
  session: string,
  index: number,
): Promise<void> {
  await run(tx("select-window", "-t", `${session}:${index}`));
}

/** Switch to the next window (wraps). Relative, so no stale-index math. */
export async function nextWindow(session: string): Promise<void> {
  await run(tx("next-window", "-t", session));
}

/** Switch to the previous window (wraps). */
export async function prevWindow(session: string): Promise<void> {
  await run(tx("previous-window", "-t", session));
}

/** Move focus to the pane in the given direction within the active window. */
export async function selectPane(
  session: string,
  dir: "L" | "R" | "U" | "D",
): Promise<void> {
  await run(tx("select-pane", "-t", session, `-${dir}`));
}

/** Split the session's active pane. `h` = left/right, `v` = top/bottom. */
export async function splitWindow(
  session: string,
  dir: "h" | "v",
  cwd: string,
): Promise<void> {
  await run(tx("split-window", `-${dir}`, "-t", session, "-c", cwd));
}

/** Kill the active pane; killing the last pane closes its window (tab). */
export async function killPane(session: string): Promise<void> {
  await run(tx("kill-pane", "-t", session));
}
