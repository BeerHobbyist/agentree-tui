/**
 * SSH projects: `s` adds a host and a directory on it; its terminal runs on the
 * host, in tmux there. The fake `ssh` makes every host this machine, so the
 * "remote" tmux is the test's own server.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionName, tmuxInstallHint } from "../../src/services/tmux";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { makeRepo } from "../helpers/repo";
import { renderApp, type RenderedApp } from "../helpers/app";
import { waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
import { createSandbox, type Sandbox } from "../helpers/sandbox";

let sandbox: Sandbox;
let app: RenderedApp;

beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => {
  app?.dispose();
  sandbox.cleanup();
});

const ADD_HOST = "Add an SSH host";
const SESSION = sessionName("ssh:dev-box", "api");

function type(text: string) {
  for (const ch of text) app.mockInput.pressKey(ch, { shift: /[A-Z]/.test(ch) });
}

/** tmux's view of a session: whether it exists, and where its pane is. */
function tmuxPath(session: string): string | null {
  const out = Bun.spawnSync([
    "tmux", "-L", sandbox.tmuxSocket, "display", "-p", "-t", session, "#{pane_current_path}",
  ]);
  return out.exitCode === 0 ? new TextDecoder().decode(out.stdout).trim() : null;
}

/** Where `text` first appears on screen. */
function locate(text: string): { x: number; y: number } {
  const lines = app.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes(text));
  if (y < 0) throw new Error(`"${text}" not on screen`);
  return { x: lines[y]!.indexOf(text), y };
}

/** Start the app and add dev-box:~/code/api with `s`. */
async function addApi() {
  mkdirSync(join(sandbox.sshHome, "code", "api"), { recursive: true });
  app = await renderApp();
  await waitForText(app, "Press n to add a project");
  app.mockInput.pressKey("s");
  await waitForText(app, ADD_HOST);
  type("dev-box");
  await waitForText(app, "▶ ⌁ dev-box");
  app.mockInput.pressEnter();
  await waitForText(app, "Directory on dev-box");
  app.mockInput.pressKey("u", { ctrl: true });
  type("~/code/api");
  app.mockInput.pressEnter();
  await waitForTextGone(app, "Directory on dev-box");
  await waitForText(app, "~/code/api");
}

describe("adding an SSH host", () => {
  test("s → host → directory: the host shows as a project, the directory under it", async () => {
    await addApi();
    const frame = app.captureCharFrame();
    expect(frame).toContain("⌁ dev-box");
    expect(frame).toContain("ssh dev-box");
    expect(frame).toContain("· api");
    expect(sandbox.readState()!.hosts).toEqual([
      {
        host: "dev-box",
        home: sandbox.sshHome,
        dirs: [{ id: "api", path: join(sandbox.sshHome, "code", "api"), createdAt: expect.any(String) }],
      },
    ]);
  });

  test("its terminal runs on the host, in tmux there, in that directory", async () => {
    await addApi(); // adding it opens its terminal, as a new worktree's does
    await waitUntil(app, () => tmuxPath(SESSION) !== null, "the remote tmux session");
    expect(tmuxPath(SESSION)).toBe(join(sandbox.sshHome, "code", "api"));
    const attach = sandbox.sshCalls().find((c) => c.includes(" -t ") && c.includes("new-session"));
    expect(attach).toContain(`new-session -A -s ${SESSION}`);
    // Its tab bar is fed by tmux on the host too.
    await waitUntil(
      app,
      () => sandbox.sshCalls().some((c) => c.includes("list-windows")),
      "the tab bar to ask the host",
    );
  });

  test("hosts from ~/.ssh/config are offered, patterns aren't", async () => {
    sandbox.setSshConfig("Host dev-box\n  HostName 10.0.0.2\nHost *\n  User me\nHost staging prod\n");
    app = await renderApp();
    await waitForText(app, "Press n to add a project");
    app.mockInput.pressKey("s");
    const frame = await waitForText(app, "⌁ staging");
    expect(frame).toContain("⌁ dev-box");
    expect(frame).toContain("⌁ prod");
    expect(frame).not.toContain("⌁ *");
    // Typing filters them; ↓ ⏎ picks one.
    type("pro");
    await waitForTextGone(app, "⌁ staging");
    app.mockInput.pressArrow("down");
    await waitForText(app, "▶ ⌁ prod");
    app.mockInput.pressEnter();
    await waitForText(app, "Directory on prod");
  });

  test("a failed check says why and goes back to the directory; nothing is saved", async () => {
    app = await renderApp();
    await waitForText(app, "Press n to add a project");
    app.mockInput.pressKey("s");
    await waitForText(app, ADD_HOST);
    type("dev-box");
    app.mockInput.pressEnter();
    await waitForText(app, "Directory on dev-box");
    app.mockInput.pressKey("u", { ctrl: true });
    type("~/missing");
    app.mockInput.pressEnter();
    await waitForText(app, "~/missing doesn't exist on dev-box");

    sandbox.failSsh("no-tmux");
    app.mockInput.pressEnter(); // back
    await waitForText(app, "Directory on dev-box");
    app.mockInput.pressKey("u", { ctrl: true });
    app.mockInput.pressEnter(); // "~"
    await waitForText(app, "tmux isn't installed on dev-box");
    expect(sandbox.readState()?.hosts).toBeUndefined();
  });

  test("＋ on the host adds another directory, straight to the directory step", async () => {
    await addApi();
    const plus = locate("＋");
    await app.mockMouse.click(plus.x, plus.y);
    await waitForText(app, "Add a directory on dev-box");
    app.mockInput.pressEnter(); // the default: ~
    await waitForText(app, "· ~");
    expect(sandbox.readState()!.hosts![0]!.dirs.map((d) => d.path)).toEqual([
      join(sandbox.sshHome, "code", "api"),
      sandbox.sshHome,
    ]);
  });

  test("an SSH host survives a restart", async () => {
    await addApi();
    app.dispose();
    app = await renderApp();
    await waitForText(app, "⌁ dev-box");
    await waitForText(app, "~/code/api");
  });
});

describe("removing", () => {
  test("d on a directory forgets it and ends its remote session; no files are touched", async () => {
    await addApi();
    await waitUntil(app, () => tmuxPath(SESSION) !== null, "the remote tmux session");
    app.mockInput.pressKey("g");
    app.mockInput.pressKey("j");
    await waitForSelection(app, "api");
    app.mockInput.pressKey("d");
    await waitForText(app, "Remove ~/code/api on dev-box from agentree?");
    app.mockInput.pressKey("y");
    await waitForTextGone(app, "~/code/api");
    await waitUntil(app, () => tmuxPath(SESSION) === null, "the remote session to end");
    expect(existsSync(join(sandbox.sshHome, "code", "api"))).toBe(true);
    expect(sandbox.readState()!.hosts![0]!.dirs).toEqual([]);
  });

  test("d on the host's header forgets the host", async () => {
    await addApi();
    app.mockInput.pressKey("g");
    await waitForSelection(app, "dev-box");
    app.mockInput.pressKey("d");
    await waitForText(app, "Remove dev-box and its directories from");
    app.mockInput.pressKey("y");
    await waitForTextGone(app, "⌁ dev-box");
    expect(sandbox.readState()!.hosts).toBeUndefined();
  });
});

describe("what SSH projects leave out", () => {
  test("no git status or PR lookups for their directories", async () => {
    await addApi();
    await Bun.sleep(300);
    expect(sandbox.ghCalls().filter((c) => c.includes("--head"))).toEqual([]);
    // No changed-files marker in the sidebar (the tab bar's "● tab" is fine).
    const sidebar = app.captureCharFrame().split("\n").map((l) => l.slice(0, 36)).join("\n");
    expect(sidebar).not.toContain("●");
  });
});

describe("a host that logs in with a password", () => {
  /** s → dev-box → ~/code/api, up to the password step. */
  async function upToPassword() {
    mkdirSync(join(sandbox.sshHome, "code", "api"), { recursive: true });
    sandbox.requireSshPassword("hunter2");
    app = await renderApp();
    await waitForText(app, "Press n to add a project");
    app.mockInput.pressKey("s");
    await waitForText(app, ADD_HOST);
    type("dev-box");
    app.mockInput.pressEnter();
    await waitForText(app, "Directory on dev-box");
    app.mockInput.pressKey("u", { ctrl: true });
    type("~/code/api");
    app.mockInput.pressEnter();
    await waitForText(app, "Password (or key passphrase) for dev-box");
  }

  test("adding it asks for the password (masked); a wrong one can be retried", async () => {
    await upToPassword();
    type("nope");
    await waitForText(app, "❯ ••••");
    expect(app.captureCharFrame()).not.toContain("nope");
    app.mockInput.pressEnter();
    await waitForText(app, "That didn't work — try again.");

    type("hunter2");
    app.mockInput.pressEnter();
    await waitForText(app, "⌁ dev-box");
    expect(sandbox.readState()!.hosts![0]!.needsPassword).toBe(true);
    expect(JSON.stringify(sandbox.readState())).not.toContain("hunter2"); // never stored
    // Its terminal opens over the connection that login left open — no prompt.
    await waitUntil(app, () => tmuxPath(SESSION) !== null, "the remote tmux session");
    expect(app.captureCharFrame()).not.toContain("password:");
  });

  test("after a restart, its terminal asks for the password; nothing else tries to log in", async () => {
    await upToPassword();
    type("hunter2");
    app.mockInput.pressEnter();
    await waitForText(app, "⌁ dev-box");
    app.dispose();
    sandbox.dropSshConnection(); // it expired while agentree was closed

    app = await renderApp();
    await waitForText(app, "~/code/api");
    const before = sandbox.sshLoginAttempts().length;
    app.mockInput.pressKey("g");
    app.mockInput.pressKey("j");
    await waitForSelection(app, "api");
    app.mockInput.pressEnter();
    await waitForText(app, "dev-box's password:");
    await Bun.sleep(1500); // the tab bar polls meanwhile…
    expect(sandbox.sshLoginAttempts().length).toBe(before + 1); // …but only the terminal logged in

    type("hunter2");
    app.mockInput.pressEnter();
    await waitUntil(app, () => sandbox.sshConnected(), "the terminal's login to connect");
    await waitUntil(
      app,
      () => sandbox.sshCalls().some((c) => c.includes("list-windows")) && /● \S/.test(app.captureCharFrame()),
      "the tab bar to come back over the connection",
    );
  });
});

describe("without tmux on this machine (a Mac without it)", () => {
  test("SSH terminals still open — tmux runs on the host", async () => {
    sandbox.hideLocalTmux();
    await addApi();
    await waitUntil(app, () => tmuxPath(SESSION) !== null, "the remote tmux session");
    await waitUntil(app, () => /● \S/.test(app.captureCharFrame()), "its tab bar");
    expect(app.captureCharFrame()).not.toContain("tmux not found");
  });

  test("a local worktree's terminal says so, with how to install it here", async () => {
    const root = await makeRepo(join(sandbox.workspace, "widget"), { worktrees: [{ branch: "feature/x" }] });
    const state = loadState();
    upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
    await saveState(state);
    await reconcile(state);
    sandbox.hideLocalTmux();
    app = await renderApp({ width: 120 });
    await waitForText(app, "feature/x");
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");
    await waitForSelection(app, "x");
    app.mockInput.pressEnter();
    await waitForText(app, "tmux not found");
    await waitForText(app, tmuxInstallHint());
  });
});
