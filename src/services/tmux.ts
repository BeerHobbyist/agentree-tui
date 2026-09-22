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
export const DEFAULT_SOCKET = "agentree";

/**
 * Read at call time (not module load) so tests can point the app at a
 * throwaway server: killing sessions on the shared socket would take the
 * user's own tmux down with it.
 */
export function socketName(): string {
  return process.env.AGENTREE_TMUX_SOCKET || DEFAULT_SOCKET;
}

/** Build a `tmux -L <socket> …` argv. */
function tx(...args: string[]): string[] {
  return ["tmux", "-L", socketName(), ...args];
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
 * Global (`-g`) option assignments that theme the terminal: no status bar,
 * pane background/foreground, and pane borders. Border cells get the same `bg`
 * as the panes so the divider blends instead of leaving an off-colored seam.
 * Returns argv fragments joined by `;` separators for `tmux … ; set … ; set …`.
 */
export function themeOptions(style: TermStyle): string[] {
  const paneStyle = `bg=${style.bg},fg=${style.fg}`;
  const out: string[] = [
    "set-option",
    "-g",
    "status",
    "off",
    ";",
    "set-option",
    "-g",
    "window-style",
    paneStyle,
    ";",
    "set-option",
    "-g",
    "window-active-style",
    paneStyle,
  ];
  if (style.border) {
    out.push(
      ";",
      "set-option",
      "-g",
      "pane-border-style",
      `fg=${style.border},bg=${style.bg}`,
      ";",
      "set-option",
      "-g",
      "pane-active-border-style",
      `fg=${style.borderActive ?? style.border},bg=${style.bg}`,
    );
  }
  return out;
}

/** Re-apply the theme to the running server (live re-theme on theme switch). */
export async function applyTheme(style: TermStyle): Promise<void> {
  await run(tx(...themeOptions(style)));
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
  if (style) cmd.push(";", ...themeOptions(style));
  else cmd.push(";", "set-option", "-g", "status", "off");
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

/**
 * New window (tab) running a specific command; the window closes when it exits.
 * Used to launch the hunk diff viewer in its own tab.
 */
export async function newWindowCmd(
  session: string,
  cwd: string,
  command: string,
  name = "cmd",
): Promise<void> {
  await run(tx("new-window", "-t", session, "-c", cwd, "-n", name, command));
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

export interface PaneGeom {
  id: string; // tmux pane id, e.g. "%3"
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Geometry of the active window's panes (cells, 0-based, matching the emulator grid). */
export async function listPaneGeometry(session: string): Promise<PaneGeom[]> {
  const { code, stdout } = await run(
    tx(
      "list-panes",
      "-t",
      session,
      "-F",
      "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_right}\t#{pane_bottom}",
    ),
  );
  if (code !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id, left, top, right, bottom] = l.split("\t");
      return {
        id: id || "",
        left: parseInt(left || "0", 10) || 0,
        top: parseInt(top || "0", 10) || 0,
        right: parseInt(right || "0", 10) || 0,
        bottom: parseInt(bottom || "0", 10) || 0,
      };
    });
}

/** Focus a specific pane by its tmux id (e.g. "%3"). */
export async function selectPaneById(id: string): Promise<void> {
  await run(tx("select-pane", "-t", id));
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

/** Kill a whole window (tab). Omit `index` to kill the session's current window. */
export async function killWindow(
  session: string,
  index?: number,
): Promise<void> {
  const target = index === undefined ? session : `${session}:${index}`;
  await run(tx("kill-window", "-t", target));
}
