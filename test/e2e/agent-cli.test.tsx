/**
 * An agent in an agentree terminal driving its tabs with the CLI: `agentree`
 * is on the terminal's PATH (and in $AGENTREE_CLI), knows which worktree it's
 * in, and the app's tab bar follows what it does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sessionName } from "../../src/services/tmux";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { activeTab, waitForSelection, waitForTab, waitForText } from "../helpers/frame";
import { makeRepo } from "../helpers/repo";
import { createSandbox, type Sandbox } from "../helpers/sandbox";
import { ICON } from "../../src/icons";

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

/** Type a command into the terminal's shell, as an agent's Bash tool would run it. */
function run(command: string) {
  Bun.spawnSync(["tmux", "-L", sandbox.tmuxSocket, "send-keys", "-t", X, command, "Enter"]);
}

describe("the CLI from inside an agentree terminal", () => {
  test("opens a tab in the background, which the tab bar shows; $AGENTREE_CLI works too", async () => {
    const root = await makeRepo(join(sandbox.workspace, "widget"), { worktrees: [{ branch: "feature/x" }] });
    const state = loadState();
    upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
    await saveState(state);
    await reconcile(state);
    app = await renderApp({ width: 120 });
    await waitForText(app, `${ICON.noAgent} x`);
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");
    await waitForSelection(app, "x");
    app.mockInput.pressEnter();
    await waitForText(app, "^g");
    await Bun.sleep(300);

    run("agentree tab new --name devserver -- echo started");
    await waitForTab(app, "devserver", { timeoutMs: 10_000 }); // there, but not switched to
    expect(activeTab(app)).not.toBe(""); // the agent's own tab stays active
    expect(activeTab(app)).not.toBe("devserver");

    run('"$AGENTREE_CLI" tab rename devserver web');
    await waitForTab(app, "web", { timeoutMs: 10_000 });
  });
});
