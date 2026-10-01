import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SOCKET,
  attachCommand,
  behaviorOptions,
  listPaneActivity,
  preAttachOptions,
  sessionName,
  socketName,
  themeOptions,
  tmuxInstallHint,
} from "../../src/services/tmux";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe("socketName", () => {
  test("defaults to the app's own socket", () => {
    delete process.env.AGENTREE_TMUX_SOCKET;
    expect(socketName()).toBe(DEFAULT_SOCKET);
  });

  test("is overridable, so tests never touch the shared server", () => {
    process.env.AGENTREE_TMUX_SOCKET = "agentree-test-1";
    expect(socketName()).toBe("agentree-test-1");
    expect(attachCommand("s", "/tmp").slice(0, 3)).toEqual(["tmux", "-L", "agentree-test-1"]);
  });
});

describe("sessionName", () => {
  test("contains no characters tmux forbids in names", () => {
    const name = sessionName("acme/widget.io", "feature/x");
    expect(name).not.toContain(".");
    expect(name).not.toContain(":");
    expect(name).toMatch(/^agentree_[A-Za-z0-9_-]+$/);
  });

  test("is stable for the same worktree", () => {
    expect(sessionName("acme/widget", "feat-x")).toBe(sessionName("acme/widget", "feat-x"));
  });

  test("distinguishes worktrees that slug identically", () => {
    // Both slug to "acme-widget-feat-x"; the hash suffix keeps them apart.
    const a = sessionName("acme/widget", "feat/x");
    const b = sessionName("acme/widget", "feat.x");
    expect(a).not.toBe(b);
  });

  test("distinguishes repos whose long names share a 40-char prefix", () => {
    const prefix = "organisation/a-very-long-repository-name";
    const a = sessionName(`${prefix}-one`, "main");
    const b = sessionName(`${prefix}-two`, "main");
    expect(a).not.toBe(b);
  });
});

describe("themeOptions", () => {
  test("turns the status bar off and styles panes and borders", () => {
    const opts = themeOptions({
      bg: "#000000",
      fg: "#ffffff",
      border: "#111111",
      borderActive: "#222222",
    });
    const joined = opts.join(" ");
    expect(joined).toContain("status off");
    expect(joined).toContain("window-style bg=#000000,fg=#ffffff");
    expect(joined).toContain("window-active-style bg=#000000,fg=#ffffff");
    // Border cells take the pane background so the divider leaves no seam.
    expect(joined).toContain("pane-border-style fg=#111111,bg=#000000");
    expect(joined).toContain("pane-active-border-style fg=#222222,bg=#000000");
  });

  test("falls back to the plain border colour when no active one is given", () => {
    const joined = themeOptions({ bg: "#000", fg: "#fff", border: "#111" }).join(" ");
    expect(joined).toContain("pane-active-border-style fg=#111,bg=#000");
  });

  test("omits border options when no border colour is given", () => {
    const joined = themeOptions({ bg: "#000", fg: "#fff" }).join(" ");
    expect(joined).not.toContain("pane-border-style");
  });
});

/** The argv from `new-session` onward (pre-attach options come first). */
function fromNewSession(cmd: string[]): string[] {
  return cmd.slice(cmd.indexOf("new-session"));
}

describe("attachCommand", () => {
  test("attaches an existing session or creates it, in the worktree", () => {
    const cmd = attachCommand("agentree_x", "/repo/.worktrees/x");
    expect(cmd.slice(0, 3)).toEqual(["tmux", "-L", socketName()]);
    expect(fromNewSession(cmd).slice(0, 6)).toEqual([
      "new-session",
      "-A",
      "-s",
      "agentree_x",
      "-c",
      "/repo/.worktrees/x",
    ]);
  });

  test("hides the status bar even without a theme", () => {
    expect(attachCommand("s", "/tmp").join(" ")).toContain("set-option -g status off");
  });

  test("applies the theme on attach", () => {
    const cmd = attachCommand("s", "/tmp", { bg: "#000", fg: "#fff" }).join(" ");
    expect(cmd).toContain("window-style bg=#000,fg=#fff");
  });

  test("omits a startup command when none is given", () => {
    expect(attachCommand("s", "/tmp")).not.toContain("claude");
  });

  test("runs a startup command right after -c, as new-session's shell-command", () => {
    const cmd = fromNewSession(attachCommand("s", "/tmp", undefined, "claude"));
    expect(cmd.slice(0, 6)).toEqual(["new-session", "-A", "-s", "s", "-c", "/tmp"]);
    expect(cmd[6]).toBe("claude");
  });

  test("gives the session its environment, new or already running", () => {
    const cmd = attachCommand("s", "/tmp", undefined, "claude", { AGENTREE_SESSION: "s" });
    // -e seeds a session being created (before the startup command)…
    const fromNew = fromNewSession(cmd);
    expect(fromNew.slice(6, 9)).toEqual(["-e", "AGENTREE_SESSION=s", "claude"]);
    // …and set-environment covers one that already existed.
    expect(cmd.join(" ")).toContain("; set-environment -t s AGENTREE_SESSION s");
  });

  test("keeps theming after the startup command", () => {
    const cmd = attachCommand("s", "/tmp", { bg: "#000", fg: "#fff" }, "claude").join(" ");
    expect(cmd).toContain("-c /tmp claude ; set-option");
    expect(cmd).toContain("window-style bg=#000,fg=#fff");
  });

  test("enables mouse so clicks reach programs inside tmux (vim, pagers)", () => {
    // With a theme…
    expect(attachCommand("s", "/tmp", { bg: "#000", fg: "#fff" }).join(" ")).toContain("set-option -g mouse on");
    // …and without one.
    expect(attachCommand("s", "/tmp").join(" ")).toContain("set-option -g mouse on");
  });
});

describe("behaviorOptions", () => {
  test("turns mouse on globally", () => {
    expect(behaviorOptions().join(" ")).toBe("set-option -g mouse on");
  });
});

describe("preAttachOptions", () => {
  test("makes tmux reset the cursor to the terminal default, not a steady block", () => {
    // terminfo's Se is \E[2 q (steady block); \E[0 q hands back the user's own
    // (usually blinking) cursor when a program like nvim stops setting a shape.
    expect(preAttachOptions()).toEqual(["set-option", "-g", "terminal-overrides[90]", "*:Se=\\E[0 q"]);
  });

  test("runs before new-session, since tmux reads overrides when the client attaches", () => {
    const cmd = attachCommand("s", "/tmp");
    const override = cmd.indexOf("terminal-overrides[90]");
    expect(override).toBeGreaterThan(-1);
    expect(override).toBeLessThan(cmd.indexOf("new-session"));
  });
});

describe("tmuxInstallHint", () => {
  const has =
    (...cmds: string[]) =>
    (cmd: string) =>
      cmds.includes(cmd) ? `/usr/bin/${cmd}` : null;

  test("Homebrew on a Mac", () => {
    expect(tmuxInstallHint("darwin", has())).toBe("brew install tmux");
  });

  test("the package manager this Linux has", () => {
    expect(tmuxInstallHint("linux", has("pacman"))).toBe("sudo pacman -S tmux");
    expect(tmuxInstallHint("linux", has("apt-get"))).toBe("sudo apt install tmux");
    expect(tmuxInstallHint("linux", has("dnf"))).toBe("sudo dnf install tmux");
  });

  test("a plain hint when there's none it knows", () => {
    expect(tmuxInstallHint("linux", has())).toBe("install tmux with your package manager");
  });
});

describe("listPaneActivity", () => {
  /** Put a `tmux` first on PATH that fails the way `message` says. */
  const failingTmux = (message: string) => {
    const dir = mkdtempSync(join(tmpdir(), "agentree-fake-tmux-"));
    writeFileSync(join(dir, "tmux"), `#!/bin/sh\necho '${message}' >&2\nexit 1\n`);
    chmodSync(join(dir, "tmux"), 0o755);
    process.env.PATH = `${dir}:${process.env.PATH}`;
  };

  test("no server: no panes", async () => {
    failingTmux("error connecting to /tmp/tmux-501/agentree (No such file or directory)");
    expect(await listPaneActivity()).toEqual(new Map());
  });

  test("a sandbox keeping us off the socket: unknown, so no agent's report counts as stale", async () => {
    failingTmux("error connecting to /private/tmp/tmux-501/agentree (Operation not permitted)");
    expect(await listPaneActivity()).toBeNull();
  });
});
