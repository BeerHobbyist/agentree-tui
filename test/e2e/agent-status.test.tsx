/**
 * Agent status in the sidebar. A real tmux session stands in for the agent's
 * pane, and reports are written the way the Claude Code hooks write them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentStatusDir } from "../../src/services/agents";
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

const SESSION = () => sessionName("acme/widget", "feature-x");

/** One project: main + a "feature/x" worktree. Returns the worktree's path. */
async function oneProject(): Promise<string> {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/x" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  return join(root, ".worktrees", "feature-x");
}

/** feature/x's tmux session with one long-running pane (the "agent"); returns the pane number. */
function agentPane(): string {
  const tmux = ["tmux", "-L", sandbox.tmuxSocket];
  Bun.spawnSync([...tmux, "new-session", "-d", "-s", SESSION(), "sleep 300"]);
  const out = Bun.spawnSync([...tmux, "display", "-p", "-t", SESSION(), "#{pane_id}"]);
  return new TextDecoder().decode(out.stdout).trim().replace("%", "");
}

/** Write a report as the hooks would. */
function report(pane: string, state: string) {
  mkdirSync(agentStatusDir(), { recursive: true });
  writeFileSync(
    join(agentStatusDir(), `${SESSION()}.${pane}`),
    `${state} ${Math.floor(Date.now() / 1000)}\n`,
  );
}

async function start() {
  const path = await oneProject();
  app = await renderApp();
  await waitForText(app, "feature/x");
  return path;
}

describe("agent status", () => {
  test("says so when no agent is doing anything", async () => {
    await start();
    expect(app.captureCharFrame()).toContain("no agent activity");
  });

  test("a working agent shows on its worktree and in the footer", async () => {
    await start();
    report(agentPane(), "working");
    const frame = await waitForText(app, "working");
    expect(frame).toContain("◐ x");
    expect(frame).toContain("◐ 1"); // footer count
  });

  test("an agent that needs you is surfaced even when its project is folded", async () => {
    await start();
    report(agentPane(), "needs-action");
    await waitForText(app, "needs action");
    app.mockInput.pressKey("h"); // fold "widget" (the selected header)
    const frame = await waitForTextGone(app, "feature/x");
    const header = frame.split("\n").find((l) => l.includes("widget"))!;
    expect(header).toContain("◆");
  });

  test("done shows until you look at that worktree", async () => {
    await start();
    report(agentPane(), "done");
    await waitForText(app, "✓ x");
    // Open feature/x's terminal (it attaches to the session above).
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");
    await waitForSelection(app, "x");
    app.mockInput.pressEnter();
    await waitForText(app, "○ x"); // seen → idle
    expect(app.captureCharFrame()).not.toContain("✓ x");
  });

  test("ignores, and cleans up, a report from a pane that no longer exists", async () => {
    await start();
    agentPane(); // the server is up, but pane 999 isn't part of it
    report("999", "working");
    const stale = join(agentStatusDir(), `${SESSION()}.999`);
    await waitUntil(app, () => !existsSync(stale), "the stale report to be removed");
    expect(app.captureCharFrame()).not.toContain("working");
  });
});

describe("uncommitted changes", () => {
  test("a change made while the app runs shows up without a restart", async () => {
    const path = await start();
    expect(app.captureCharFrame()).not.toContain("●1");
    writeFileSync(join(path, "notes.txt"), "new\n");
    await waitForText(app, "●1", { timeoutMs: 12_000 }); // background refresh, every 5s
  }, 20_000);
});
