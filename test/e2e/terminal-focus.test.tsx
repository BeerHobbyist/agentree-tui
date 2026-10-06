/**
 * The terminal window's focus drives the query cache's "window focus": the
 * terminal reports focus in/out (DEC mode 1004: ESC[I / ESC[O), OpenTUI turns
 * that into focus/blur events, and TanStack refreshes stale data on return and
 * pauses the GitHub polling while you're away.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { focusManager } from "@tanstack/react-query";
import {
  agentStatusQuery,
  gitStatusQuery,
  prDetailsQuery,
  prForBranchQuery,
  tmuxWindowsQuery,
} from "../../src/queries";
import { createQueryClient } from "../../src/queryClient";
import { agentStatusDir } from "../../src/services/agents";
import { sessionName } from "../../src/services/tmux";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp, type RenderAppOptions } from "../helpers/app";
import { waitForSelection, waitForText, waitUntil } from "../helpers/frame";
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

/** What a terminal with focus reporting on sends when its window gains / loses focus. */
const terminal = {
  focusIn: () => app.renderer.stdin.emit("data", Buffer.from("\x1b[I")),
  focusOut: () => app.renderer.stdin.emit("data", Buffer.from("\x1b[O")),
};

/** One project with feature/login, which has PR #42; the login row selected. */
async function start(opts: RenderAppOptions = {}) {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/login" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  sandbox.setBranchPr({ number: 42, title: "Login", headRefName: "feature/login" }, "feature/login");
  sandbox.setPrView(42, {
    number: 42,
    title: "Add login screen",
    url: "https://github.com/acme/widget/pull/42",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature/login",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    updatedAt: new Date().toISOString(),
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
  });
  app = await renderApp({ width: 140, height: 40, ...opts });
  await waitForText(app, `${ICON.noAgent} login`);
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "login");
  await waitForText(app, "Add login screen");
}

const views = () => sandbox.ghCalls().filter((c) => c.startsWith("pr view 42 ")).length;

describe("terminal focus", () => {
  test("the terminal's focus events drive the cache's focus state", async () => {
    await start();
    terminal.focusOut();
    await waitUntil(app, () => !focusManager.isFocused(), "the cache to see the terminal lose focus");
    terminal.focusIn();
    await waitUntil(app, () => focusManager.isFocused(), "the cache to see the terminal regain focus");
  });

  test("coming back to the terminal refreshes a stale PR — no `r` needed", async () => {
    await start({ queryClient: createQueryClient({ staleTime: 200 }) });
    const fetched = views();
    terminal.focusOut();
    await Bun.sleep(400); // the PR's details go stale meanwhile
    expect(views()).toBe(fetched); // nothing fetched while away
    terminal.focusIn();
    await waitUntil(app, () => views() === fetched + 1, "the stale PR to be refetched");
  });

  test("returning while the data is still fresh fetches nothing", async () => {
    await start(); // default: fresh for 30s
    const fetched = views();
    terminal.focusOut();
    terminal.focusIn();
    await Bun.sleep(300);
    expect(views()).toBe(fetched);
  });

  test("agent status keeps updating while the terminal isn't focused", async () => {
    await start();
    terminal.focusOut();
    await waitUntil(app, () => !focusManager.isFocused(), "the terminal to lose focus");

    // An agent in feature/login starts needing you, while agentree sits unfocused.
    const tmux = ["tmux", "-L", sandbox.tmuxSocket];
    const session = sessionName("acme/widget", "feature-login");
    Bun.spawnSync([...tmux, "new-session", "-d", "-s", session, "sleep 300"]);
    const pane = new TextDecoder()
      .decode(Bun.spawnSync([...tmux, "display", "-p", "-t", session, "#{pane_id}"]).stdout)
      .trim()
      .replace("%", "");
    mkdirSync(agentStatusDir(), { recursive: true });
    writeFileSync(join(agentStatusDir(), `${session}.${pane}`), `needs-action ${Math.floor(Date.now() / 1000)}\n`);

    await waitForText(app, `${ICON.needsAction} login`);
  });

  test("the app going away leaves the cache's focus state as it found it", async () => {
    await start();
    terminal.focusOut();
    await waitUntil(app, () => !focusManager.isFocused(), "the terminal to lose focus");
    app.dispose(); // React unmounts a moment later
    for (let i = 0; i < 50 && !focusManager.isFocused(); i++) await Bun.sleep(10);
    expect(focusManager.isFocused()).toBe(true);
  });

  test("a new app starts focused, and keeps its focus events, however the last one ended", async () => {
    await start();
    terminal.focusOut();
    await waitUntil(app, () => !focusManager.isFocused(), "the terminal to lose focus");
    app.dispose(); // its cleanup lands after the next app has bound…
    app = await renderApp();
    expect(focusManager.isFocused()).toBe(true);
    await Bun.sleep(100); // …and mustn't detach the new app
    terminal.focusOut();
    await waitUntil(app, () => !focusManager.isFocused(), "the new app to still get focus events");
  });
});

describe("what pauses while the terminal isn't focused", () => {
  test("GitHub queries pause; local ones keep polling", () => {
    // GitHub: caught up on return.
    expect(prDetailsQuery("acme/widget", 1).refetchIntervalInBackground).toBeFalsy();
    expect(prForBranchQuery("acme/widget", "x", "/tmp/x").refetchIntervalInBackground).toBeFalsy();
    // Local and cheap, and what you watch agentree for from another window.
    expect(agentStatusQuery().refetchIntervalInBackground).toBe(true);
    expect(gitStatusQuery("/tmp/x").refetchIntervalInBackground).toBe(true);
    expect(tmuxWindowsQuery("s").refetchIntervalInBackground).toBe(true);
  });
});
