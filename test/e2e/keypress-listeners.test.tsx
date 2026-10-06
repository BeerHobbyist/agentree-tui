/**
 * Every worktree you open keeps its terminal mounted (hidden) so switching back
 * is instant. Only the focused one may listen for keys: one keypress listener
 * per opened worktree passed EventEmitter's cap of 10, and OpenTUI prints the
 * MaxListenersExceededWarning straight over the screen.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { settle, waitForSelection, waitForText, waitUntil } from "../helpers/frame";
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

const keypressListeners = () => app.renderer.keyInput.listenerCount("keypress");

test("opened terminals don't pile up keypress listeners", async () => {
  const branches = ["feature/a", "feature/b", "feature/c"];
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: branches.map((branch) => ({ branch })),
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  app = await renderApp();
  await waitForText(app, `${ICON.noAgent} c`);
  app.mockInput.pressKey("j"); // the main worktree
  const idle = keypressListeners();

  /** Move to `branch`'s row, open its terminal, then Ctrl+g back to the sidebar. */
  const visit = async (moves: string[], branch: string) => {
    for (const k of moves) app.mockInput.pressKey(k);
    await waitForSelection(app, branch); // the sidebar has the keys
    expect(keypressListeners()).toBe(idle);
    app.mockInput.pressEnter();
    await waitUntil(app, () => keypressListeners() === idle + 1, "the focused terminal to listen for keys");
    app.mockInput.pressKey("g", { ctrl: true });
    await settle(app);
  };
  for (const branch of branches) await visit(["j"], branch);
  await visit(["k", "k"], "feature/a"); // back into a terminal that stayed mounted
  await waitUntil(app, () => keypressListeners() === idle, "the last terminal to stop listening");
});
