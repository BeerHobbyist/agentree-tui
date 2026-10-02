/**
 * tmux integration. tmux backs each embedded terminal so processes survive app
 * restarts: one session per worktree, one window per terminal instance.
 */
import { createHash } from "node:crypto";
import { run } from "./proc";
import { isConnected, remoteArgv } from "./ssh";

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

/**
 * The same, run on an ssh host. `-u`: an ssh session often has no UTF-8
 * locale, and tmux would then print every non-ASCII character — and the tabs
 * in our `-F` formats — as `_`, in list output and in the terminal alike.
 */
function remoteTmux(host: string, args: string[], opts: { tty?: boolean } = {}): string[] {
  return remoteArgv(host, ["tmux", "-u", "-L", socketName(), ...args], opts);
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
 * How to install tmux here, for the "tmux not found" message: the package
 * manager this system has (`which` looks one up on PATH), else a plain hint.
 */
export function tmuxInstallHint(
  platform: string = process.platform,
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd, { PATH: process.env.PATH }),
): string {
  if (platform === "darwin") return "brew install tmux";
  const managers: [string, string][] = [
    ["pacman", "sudo pacman -S tmux"],
    ["apt-get", "sudo apt install tmux"],
    ["dnf", "sudo dnf install tmux"],
    ["zypper", "sudo zypper install tmux"],
    ["apk", "sudo apk add tmux"],
    ["brew", "brew install tmux"],
  ];
  const found = managers.find(([cmd]) => which(cmd));
  return found ? found[1] : "install tmux with your package manager";
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

/**
 * Global (`-g`) behavior options, applied on attach. `mouse on` is what lets
 * mouse reach programs inside tmux: tmux then requests mouse reporting from our
 * emulator (so OpenTUI actually forwards clicks) and relays events to the
 * focused pane's program — clicking in vim/nvim, scrolling in a pager, and
 * selecting split panes all start working. It's a `-g` option, so setting it on
 * attach persists for every session and window on the server.
 */
export function behaviorOptions(): string[] {
  return ["set-option", "-g", "mouse", "on"];
}

/** Our slot in tmux's `terminal-overrides` array (indexed, so re-setting it on every attach is idempotent and leaves the user's own entries alone). */
const CURSOR_RESET_OVERRIDE_INDEX = 90;

/**
 * Options that must be set *before* the client attaches: tmux reads
 * `terminal-overrides` when it initializes the attaching client's terminal.
 *
 * `Se` is what tmux sends to put the cursor back to "default" (when a pane that
 * set a cursor shape — nvim, say — returns to not caring). terminfo ships
 * `Se=\E[2 q`, i.e. a *steady* block, so after quitting nvim the shell cursor
 * would stop blinking. `\E[0 q` asks for the terminal's own default instead, so
 * the user's configured cursor (usually blinking) comes back.
 */
export function preAttachOptions(): string[] {
  return ["set-option", "-g", `terminal-overrides[${CURSOR_RESET_OVERRIDE_INDEX}]`, "*:Se=\\E[0 q"];
}

/**
 * Command to run in a PTY: attach the session if it exists, else create it.
 * Theme options are set globally (`-g`) on our dedicated server so they apply
 * to every window/tab (not just the first) — no tmux status bar, and pane +
 * background colors match the app.
 *
 * `startupCommand`, if given, runs in place of the default shell — but only
 * when the session is actually created. tmux's `-A` makes this a no-op on a
 * later re-attach (there's no "initial window" being created to run it in),
 * so it's safe to always pass the same startup command: it only ever fires
 * once per worktree, the first time its terminal is opened.
 */
export function attachCommand(
  session: string,
  cwd: string,
  style?: TermStyle,
  startupCommand?: string,
  env: Record<string, string> = {},
  /** Run tmux on this ssh host instead (an SSH project); the PTY runs `ssh -t`. */
  host?: string,
): string[] {
  // new-session in the list makes tmux start the server if needed, so the
  // pre-attach options can run first even on a fresh server.
  const cmd = [...preAttachOptions(), ";", "new-session", "-A", "-s", session, "-c", cwd];
  // -e seeds a new session's environment (every window/pane inherits it);
  // set-environment below covers a session that already existed.
  for (const [k, v] of Object.entries(env)) cmd.push("-e", `${k}=${v}`);
  if (startupCommand) cmd.push(startupCommand);
  if (style) cmd.push(";", ...themeOptions(style));
  else cmd.push(";", "set-option", "-g", "status", "off");
  cmd.push(";", ...behaviorOptions());
  for (const [k, v] of Object.entries(env)) {
    cmd.push(";", "set-environment", "-t", session, k, v);
  }
  return host ? remoteTmux(host, cmd, { tty: true }) : tx(...cmd);
}

/**
 * Every live pane on our server, keyed `"<session>.<pane number>"`, with when
 * its window last printed anything (epoch seconds). Empty when no server is
 * running; null if tmux couldn't be asked at all.
 */
export async function listPaneActivity(): Promise<Map<string, number> | null> {
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await run(tx("list-panes", "-a", "-F", "#{session_name}\t#{pane_id}\t#{window_activity}"));
  } catch {
    return null;
  }
  if (res.code !== 0) {
    // A sandbox keeping us off the socket isn't "no server": the panes are unknown.
    if (/not permitted|permission denied/i.test(res.stderr)) return null;
    return /no server running|error connecting|no sessions/i.test(res.stderr) ? new Map() : null;
  }
  const panes = new Map<string, number>();
  for (const line of res.stdout.split("\n")) {
    const [session, paneId, activity] = line.split("\t");
    if (!session || !paneId) continue;
    panes.set(`${session}.${paneId.replace(/^%/, "")}`, parseInt(activity || "0", 10) || 0);
  }
  return panes;
}

// --- window (tab) + pane (split) helpers ---

export interface WindowInfo {
  index: number;
  name: string;
  active: boolean;
  panes: number;
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
    tx("list-panes", "-t", session, "-F", "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_right}\t#{pane_bottom}"),
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

/** Longest tab name accepted from the rename prompt. */
export const MAX_TAB_NAME_LENGTH = 32;

/**
 * The session, window and pane commands, run by tmux on this machine or — for
 * an SSH project — by tmux on `host` over ssh (on the same socket name there).
 *
 * `onlyIfConnected` (a host that logs in with a password): run only over a
 * live shared connection, never by logging in — otherwise each call (the tab
 * bar polls every second) would be a failed login on the server.
 */
export function tmuxOn(host?: string, opts: { onlyIfConnected?: boolean } = {}) {
  const exec = async (...args: string[]) => {
    if (!host) return run(tx(...args));
    if (opts.onlyIfConnected && !(await isConnected(host))) {
      return { code: 255, stdout: "", stderr: `not connected to ${host}` };
    }
    return run(remoteTmux(host, args));
  };
  return {
    host,

    /** Re-apply the theme to the running server (live re-theme on theme switch). */
    async applyTheme(style: TermStyle): Promise<void> {
      await exec(...themeOptions(style));
    },

    /** Whether a session already exists (used for a "live" indicator). */
    async hasSession(session: string): Promise<boolean> {
      try {
        return (await exec("has-session", "-t", session)).code === 0;
      } catch {
        return false;
      }
    },

    /**
     * Create a detached session running the plain shell (or `command`, an
     * argv), if it doesn't exist yet — no theming, no startup command (the app
     * applies those itself the first time it opens the worktree's terminal via
     * `attachCommand`). Returns its pane's id.
     */
    async newSession(session: string, cwd: string, command: string[] = []): Promise<string> {
      const { code, stdout, stderr } = await exec(
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        session,
        "-c",
        cwd,
        ...command,
      );
      if (code !== 0) throw new Error(stderr.trim() || `couldn't start a session for ${session}`);
      return stdout.trim();
    },

    /** List a session's windows (tabs). Empty if the session is gone. */
    async listWindows(session: string): Promise<WindowInfo[]> {
      const { code, stdout } = await exec(
        "list-windows",
        "-t",
        session,
        "-F",
        "#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}",
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
    },

    async newWindow(session: string, cwd: string): Promise<void> {
      await exec("new-window", "-t", session, "-c", cwd);
    },

    /**
     * New window (tab) running a specific command; the window closes when it exits.
     * Used to launch the hunk diff viewer in its own tab.
     */
    async newWindowCmd(session: string, cwd: string, command: string, name = "cmd"): Promise<void> {
      await exec("new-window", "-t", session, "-c", cwd, "-n", name, command);
    },

    /**
     * Name a window (tab). tmux then stops renaming it after the program running
     * in it (it turns the window's `automatic-rename` off).
     */
    async renameWindow(session: string, index: number, name: string): Promise<void> {
      // `--`: a name starting with "-" is a name, not a flag.
      await exec("rename-window", "-t", `${session}:${index}`, "--", name);
    },

    /** Give a window's name back to tmux: it follows the running program again. */
    async autoNameWindow(session: string, index: number): Promise<void> {
      await exec("set-window-option", "-t", `${session}:${index}`, "automatic-rename", "on");
    },

    async selectWindow(session: string, index: number): Promise<void> {
      await exec("select-window", "-t", `${session}:${index}`);
    },

    /** Switch to the next window (wraps). Relative, so no stale-index math. */
    async nextWindow(session: string): Promise<void> {
      await exec("next-window", "-t", session);
    },

    /** Switch to the previous window (wraps). */
    async prevWindow(session: string): Promise<void> {
      await exec("previous-window", "-t", session);
    },

    /** Move focus to the pane in the given direction within the active window. */
    async selectPane(session: string, dir: "L" | "R" | "U" | "D"): Promise<void> {
      await exec("select-pane", "-t", session, `-${dir}`);
    },

    /** Split the session's active pane. `h` = left/right, `v` = top/bottom. */
    async splitWindow(session: string, dir: "h" | "v", cwd: string): Promise<void> {
      await exec("split-window", `-${dir}`, "-t", session, "-c", cwd);
    },

    /** Kill the active pane; killing the last pane closes its window (tab). */
    async killPane(session: string): Promise<void> {
      await exec("kill-pane", "-t", session);
    },

    /** Kill a whole window (tab). Omit `index` to kill the session's current window. */
    async killWindow(session: string, index?: number): Promise<void> {
      await exec("kill-window", "-t", index === undefined ? session : `${session}:${index}`);
    },

    /** Kill a whole session (all windows/panes). No-op if it doesn't exist. */
    async killSession(session: string): Promise<void> {
      await exec("kill-session", "-t", session);
    },

    /**
     * Open a tab (window) running the user's shell (or `command`, an argv),
     * without switching to it unless `select`; returns its index and its
     * pane's id. `cwd` defaults to the session's directory.
     */
    async openTab(
      session: string,
      opts: { name?: string; cwd?: string; select?: boolean; command?: string[] } = {},
    ): Promise<{ index: number; pane: string }> {
      const args = ["new-window", "-P", "-F", "#{window_index}\t#{pane_id}", "-t", `${session}:`];
      if (!opts.select) args.push("-d");
      if (opts.name) args.push("-n", opts.name);
      if (opts.cwd) args.push("-c", opts.cwd);
      const { code, stdout, stderr } = await exec(...args, ...(opts.command ?? []));
      if (code !== 0) throw new Error(stderr.trim() || `couldn't open a tab in ${session}`);
      const [index, pane] = stdout.trim().split("\t");
      return { index: parseInt(index || "0", 10), pane: pane || "" };
    },

    /** Set a user option (`@name`) on one pane, to mark it. */
    async tagPane(pane: string, option: string): Promise<void> {
      const { code, stderr } = await exec("set-option", "-p", "-t", pane, option, "1");
      if (code !== 0) throw new Error(stderr.trim() || `couldn't mark ${pane}`);
    },

    /**
     * The pane `target` names (a window: its active pane) and whether it's
     * marked with `option`; null when there's no such pane.
     */
    async paneTag(target: string, option: string): Promise<{ pane: string; tagged: boolean } | null> {
      const { code, stdout } = await exec("display-message", "-p", "-t", target, `#{pane_id}\t#{${option}}`);
      const [pane, value] = stdout.trim().split("\t");
      return code === 0 && pane ? { pane, tagged: value === "1" } : null;
    },

    /** The last `lines` lines a pane shows (scrollback included), wrapped lines joined. */
    async capturePane(target: string, lines = 50): Promise<string> {
      const { code, stdout, stderr } = await exec(
        "capture-pane",
        "-p",
        "-J",
        "-t",
        target,
        "-S",
        `-${Math.max(1, lines)}`,
      );
      if (code !== 0) throw new Error(stderr.trim() || `couldn't read ${target}`);
      return stdout.replace(/\s+$/, "");
    },

    /** Type `text` into a pane (literally), then Enter unless `enter` is false. */
    async sendText(target: string, text: string, enter = true): Promise<void> {
      const { code, stderr } = await exec("send-keys", "-t", target, "-l", "--", text);
      if (code !== 0) throw new Error(stderr.trim() || `couldn't type into ${target}`);
      if (enter) await exec("send-keys", "-t", target, "Enter");
    },

    /**
     * Press keys in a pane, tmux-style names (`C-c`, `Enter`, `Up`). `--`: a
     * key is never a flag — `-X copy-pipe …` or `-K` would have tmux itself
     * run a command.
     */
    async sendKeys(target: string, ...keys: string[]): Promise<void> {
      const { code, stderr } = await exec("send-keys", "-t", target, "--", ...keys);
      if (code !== 0) throw new Error(stderr.trim() || `couldn't send keys to ${target}`);
    },

    /** The directory the session was started in (its worktree). */
    async sessionPath(session: string): Promise<string> {
      const { stdout } = await exec("display-message", "-p", "-t", session, "#{session_path}");
      return stdout.trim();
    },
  };
}

export type Tmux = ReturnType<typeof tmuxOn>;

/** The same commands against the local server. */
export const {
  applyTheme,
  hasSession,
  listWindows,
  newWindow,
  newWindowCmd,
  renameWindow,
  autoNameWindow,
  selectWindow,
  nextWindow,
  prevWindow,
  selectPane,
  splitWindow,
  killPane,
  killWindow,
  killSession,
} = tmuxOn();
