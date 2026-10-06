/**
 * Selecting text in a shell with the mouse: tmux selects in copy mode, and
 * the selection stays on screen after the release, copied to the host
 * terminal's clipboard. Typing or clicking afterwards is back in the shell —
 * typing too after a trip to another tab.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sessionName } from "../../src/services/tmux";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
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

const X = sessionName("acme/widget", "feature-x");
const TEXT = "selectme-0123456789";

const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", "-L", sandbox.tmuxSocket, ...args])
    .stdout.toString()
    .trim();
/** `#{pane_in_mode}`: 1 while the pane (the session's one in front, by default) is in copy mode. */
const inCopyMode = (target = X) => tmux("display", "-p", "-t", target, "#{pane_in_mode}") === "1";
const frontTab = () => tmux("display", "-p", "-t", X, "#{window_index}");

/** feature/x's terminal, open and focused, with TEXT printed in its shell. */
async function start(): Promise<{ copied: string[] }> {
  const root = await makeRepo(join(sandbox.workspace, "widget"), { worktrees: [{ branch: "feature/x" }] });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  app = await renderApp({ width: 120 });
  const copied: string[] = [];
  app.renderer.copyToClipboardOSC52 = (text: string) => {
    copied.push(text);
    return true;
  };
  await waitForText(app, `${ICON.noAgent} x`);
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "x");
  app.mockInput.pressEnter();
  await waitForText(app, "^g");
  await Bun.sleep(300);
  // The command line reads `printf 'selectme-%s\n' …`, so only the output matches TEXT.
  tmux("send-keys", "-t", X, "printf 'selectme-%s\\n' 0123456789", "Enter");
  await waitForText(app, TEXT, { timeoutMs: 10_000 });
  return { copied };
}

/** Where TEXT is on screen. */
function textAt(): { x: number; y: number } {
  const lines = app.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes(TEXT));
  return { x: lines[y]!.indexOf(TEXT), y };
}

/** Drag across TEXT; returns what tmux copied. */
async function selectText(): Promise<string> {
  const { x, y } = textAt();
  await app.mockMouse.drag(x, y, x + TEXT.length - 1, y);
  await waitUntil(app, () => tmux("show-buffer").length > 0, "tmux to copy the selection");
  return tmux("show-buffer");
}

describe("selecting text in a shell", () => {
  test("the selection stays on screen after the release, and is copied to the clipboard", async () => {
    const { copied } = await start();
    const buffer = await selectText();
    expect(TEXT).toContain(buffer);
    expect(buffer.length).toBeGreaterThan(4);
    await waitUntil(app, () => copied.includes(buffer), "the copy to reach the host clipboard");

    await Bun.sleep(500); // tmux's own binding would have left copy mode by now
    expect(inCopyMode()).toBe(true);
    expect(tmux("display", "-p", "-t", X, "#{selection_present}")).toBe("1");
  });

  test("typing afterwards goes to the shell, not to copy mode", async () => {
    await start();
    await selectText();
    expect(inCopyMode()).toBe(true);

    // Only the output reads `typed-ok`: the command line has the quotes.
    await app.mockInput.typeText('echo typed""-ok');
    app.mockInput.pressEnter();
    await waitUntil(
      app,
      () => tmux("capture-pane", "-p", "-t", X).split("\n").includes("typed-ok"),
      "the shell to run what was typed",
    );
    expect(inCopyMode()).toBe(false);
  });

  test("a double-clicked word stays selected", async () => {
    await start();
    const { x, y } = textAt();
    await app.mockMouse.doubleClick(x + 1, y);
    await waitUntil(app, () => tmux("show-buffer").length > 0, "tmux to copy the word");
    expect(TEXT).toContain(tmux("show-buffer"));

    await Bun.sleep(500); // tmux's own binding would have left copy mode by now
    expect(inCopyMode()).toBe(true);
    expect(tmux("display", "-p", "-t", X, "#{selection_present}")).toBe("1");
  });

  test("typing reaches the shell after a trip to another tab and back", async () => {
    await start();
    const first = frontTab();
    await selectText();

    app.mockInput.pressKey("t", { meta: true }); // a new tab, in front
    await waitUntil(app, () => frontTab() !== first, "the new tab");
    const second = frontTab();
    await Bun.sleep(300);
    await app.mockInput.typeText('echo other""-tab');
    app.mockInput.pressEnter();
    const shows = (tab: string, line: string) =>
      tmux("capture-pane", "-p", "-t", `${X}:${tab}`).split("\n").includes(line);
    await waitUntil(app, () => shows(second, "other-tab"), "the new tab's shell to run it");

    // Back to the first tab, the leftmost in the bar. (⌥, can't be sent: the
    // key parser takes only a letter or digit after ESC as an Alt chord.)
    const bar = app.captureCharFrame().split("\n")[0]!;
    await app.mockMouse.click(bar.indexOf("‹ ") + 3, 0);
    await waitUntil(app, () => frontTab() === first, "the first tab");
    expect(inCopyMode(`${X}:${first}`)).toBe(true); // still showing its selection
    await app.mockInput.typeText('echo typed""-ok');
    app.mockInput.pressEnter();
    await waitUntil(app, () => shows(first, "typed-ok"), "the first tab's shell to run what was typed");
    expect(inCopyMode(`${X}:${first}`)).toBe(false);
  });

  test("a click afterwards clears the selection and leaves copy mode", async () => {
    await start();
    await selectText();
    expect(inCopyMode()).toBe(true);

    // tmux counts a press in the same pane within 300ms of the drag's as its
    // second click; a person's drag alone takes longer than that.
    await Bun.sleep(500);
    const { x, y } = textAt();
    await app.mockMouse.click(x, y);
    await waitUntil(app, () => !inCopyMode(), "the pane to leave copy mode");
  });
});
