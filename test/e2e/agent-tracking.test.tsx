/**
 * Status for every agent, and telling you about it: any process in an agentree
 * terminal can report (tracking every claude puts the hooks where a hand-typed
 * claude loads them), SSH hosts report too, you're notified when an agent needs
 * you while you're elsewhere, and Tab / ⌥n / a footer count take you to it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentStatusDir, hookCommand } from "../../src/services/agents";
import { sessionName } from "../../src/services/tmux";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
import { makeRepo } from "../helpers/repo";
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

const X = sessionName("acme/widget", "feature-x");
const Y = sessionName("acme/widget", "feature-y");
const tmux = () => ["tmux", "-L", sandbox.tmuxSocket];
const now = () => Math.floor(Date.now() / 1000);

/** A tmux session standing in for an agent's pane; returns the pane number. */
function agentPane(session: string): string {
  Bun.spawnSync([...tmux(), "new-session", "-d", "-s", session, "sleep 300"]);
  const out = Bun.spawnSync([...tmux(), "display", "-p", "-t", session, "#{pane_id}"]);
  return new TextDecoder().decode(out.stdout).trim().replace("%", "");
}

/** Write a report as a hook would. */
function report(session: string, pane: string, state: string, since = now()) {
  mkdirSync(agentStatusDir(), { recursive: true });
  writeFileSync(join(agentStatusDir(), `${session}.${pane}`), `${state} ${since}\n`);
}

/** Run a hook command inside a session's pane, as a claude started there would. */
function hookInPane(session: string, state: "needs-action" | "done") {
  const script = join(sandbox.root, `hook-${state}.sh`);
  writeFileSync(script, hookCommand(state) + "\n");
  Bun.spawnSync([...tmux(), "send-keys", "-t", session, `sh ${script}`, "Enter"]);
}

/** main + feature/x + feature/y. */
async function start() {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/x" }, { branch: "feature/y" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  app = await renderApp({ width: 120 });
  await waitForText(app, "feature/y");
}

/** Select a worktree row by name (g, then j until it's selected). */
async function select(name: "x" | "y") {
  app.mockInput.pressKey("g");
  for (let i = 0; i < (name === "x" ? 2 : 3); i++) app.mockInput.pressKey("j");
  await waitForSelection(app, name);
}

describe("tracking every claude (H)", () => {
  test("asks first, then adds agentree's hooks to Claude's settings; H again takes them out", async () => {
    mkdirSync(join(sandbox.claudeSettings, ".."), { recursive: true });
    writeFileSync(sandbox.claudeSettings, JSON.stringify({ model: "opus" }));
    await start();
    app.mockInput.pressKey("H", { shift: true });
    await waitForText(app, "Track every claude");
    expect(readFileSync(sandbox.claudeSettings, "utf8")).not.toContain("AGENTREE"); // not before yes
    app.mockInput.pressKey("y");
    await waitUntil(
      app,
      () => readFileSync(sandbox.claudeSettings, "utf8").includes("AGENTREE_AGENT_DIR"),
      "the hooks",
    );
    expect(JSON.parse(readFileSync(sandbox.claudeSettings, "utf8")).model).toBe("opus");
    await waitForTextGone(app, "Track every claude");

    app.mockInput.pressKey("H", { shift: true });
    await waitForText(app, "Stop tracking every claude");
    app.mockInput.pressKey("y");
    await waitUntil(app, () => !readFileSync(sandbox.claudeSettings, "utf8").includes("AGENTREE"), "the hooks gone");
    expect(JSON.parse(readFileSync(sandbox.claudeSettings, "utf8"))).toEqual({ model: "opus" });
  });

  test("anything started in an agentree terminal can report through the hooks", async () => {
    await start();
    await select("x");
    app.mockInput.pressEnter(); // its terminal: a shell, in an agentree session
    await waitForText(app, "^g sidebar");
    await Bun.sleep(300);
    hookInPane(X, "needs-action"); // what a hand-typed claude's hook would run
    await waitForText(app, "needs action");
  });
});

describe("telling you", () => {
  test("an agent needing you elsewhere is a notification; one on screen, or old news, isn't", async () => {
    const paneY = agentPane(Y);
    report(Y, paneY, "done", now() - 600); // finished before agentree started
    await start();
    await select("x");
    app.mockInput.pressEnter(); // x on screen
    await waitForText(app, "^g sidebar");
    await Bun.sleep(1500);
    expect(sandbox.notifications()).toEqual([]);

    report(Y, paneY, "needs-action");
    await waitUntil(app, () => sandbox.notifications().length > 0, "a notification");
    expect(sandbox.notifications()).toEqual(["y needs you | widget"]);

    const paneX = Bun.spawnSync([...tmux(), "display", "-p", "-t", X, "#{pane_id}"]);
    report(X, new TextDecoder().decode(paneX.stdout).trim().replace("%", ""), "needs-action");
    await waitForText(app, "◆ 2");
    await Bun.sleep(1200);
    expect(sandbox.notifications()).toEqual(["y needs you | widget"]); // x is the one you're looking at
  });

  test("AGENTREE_NOTIFY=off keeps quiet", async () => {
    process.env.AGENTREE_NOTIFY = "off";
    const paneY = agentPane(Y);
    await start();
    report(Y, paneY, "needs-action");
    await waitForText(app, "needs action");
    await Bun.sleep(500);
    expect(sandbox.notifications()).toEqual([]);
  });
});

describe("going to it", () => {
  test("Tab opens the next agent that needs you, keys in its terminal", async () => {
    const paneY = agentPane(Y);
    await start();
    report(Y, paneY, "needs-action");
    await waitForText(app, "needs action");
    app.mockInput.pressTab();
    await waitForSelection(app, "y");
    await waitForText(app, "^g sidebar");
  });

  test("⌥n from inside another terminal does the same", async () => {
    const paneY = agentPane(Y);
    await start();
    await select("x");
    app.mockInput.pressEnter();
    await waitForText(app, "^g sidebar");
    report(Y, paneY, "needs-action");
    await waitForText(app, "needs action");
    app.mockInput.pressKey("n", { meta: true });
    await waitForSelection(app, "y");
  });

  test("with nobody needing you, Tab goes to one that's done; clicking ◆ 1 goes to the one that needs you", async () => {
    const paneX = agentPane(X);
    const paneY = agentPane(Y);
    await start();
    report(X, paneX, "done");
    await waitForText(app, "✓ 1");
    app.mockInput.pressTab();
    await waitForSelection(app, "x");

    app.mockInput.pressKey("g", { ctrl: true }); // back to the sidebar
    report(Y, paneY, "needs-action");
    await waitForText(app, "◆ 1");
    const lines = app.captureCharFrame().split("\n");
    const y = lines.findIndex((l) => l.includes("◆ 1"));
    await app.mockMouse.click(lines[y]!.indexOf("◆ 1"), y);
    await waitForSelection(app, "y");
  });
});

describe("agents on an SSH host", () => {
  test("with tracking on, the host gets the hooks, and its agents show here", async () => {
    mkdirSync(join(sandbox.sshHome, "code", "api"), { recursive: true });
    app = await renderApp({ width: 120 });
    await waitForText(app, "Press n to add a project");
    app.mockInput.pressKey("H", { shift: true });
    await waitForText(app, "Track every claude");
    app.mockInput.pressKey("y");
    await waitForTextGone(app, "Track every claude");

    app.mockInput.pressKey("s");
    await waitForText(app, "Add an SSH host");
    for (const ch of "dev-box") app.mockInput.pressKey(ch);
    app.mockInput.pressEnter();
    await waitForText(app, "Directory on dev-box");
    app.mockInput.pressKey("u", { ctrl: true });
    for (const ch of "~/code/api") app.mockInput.pressKey(ch);
    app.mockInput.pressEnter();
    await waitForText(app, "⌁ dev-box");

    // The host's Claude settings get the hooks (its own file, not this machine's).
    const hostSettings = join(sandbox.sshHome, ".claude", "settings.json");
    await waitUntil(
      app,
      () => existsSync(hostSettings) && readFileSync(hostSettings, "utf8").includes("AGENTREE_AGENT_DIR"),
      "the host's hooks",
    );

    // A claude in the host's terminal reports there; agentree reads it over ssh.
    const session = sessionName("ssh:dev-box", "api");
    await waitUntil(app, () => Bun.spawnSync([...tmux(), "has-session", "-t", session]).exitCode === 0, "its session");
    await Bun.sleep(300);
    hookInPane(session, "needs-action");
    await waitForText(app, "needs action", { timeoutMs: 8_000 });
    expect(existsSync(join(agentStatusDir(), `${session}.0`))).toBe(false); // reported on the host
  });
});
