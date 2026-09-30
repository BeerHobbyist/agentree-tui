/**
 * Renaming a terminal tab (a tmux window): right-click it (or ⌥r) and type a
 * name. Only the tab's name changes; empty hands it back to tmux, which names
 * it after the program running in it again.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MouseButtons } from "@opentui/core/testing";
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

const PROMPT = "Name for tab";
const SESSION = sessionName("acme/widget", "feature-x");

/** tmux's own view of the session's tabs: name and whether tmux names it. */
function tmuxTabs(): { name: string; auto: boolean }[] {
  const out = Bun.spawnSync([
    "tmux",
    "-L",
    sandbox.tmuxSocket,
    "list-windows",
    "-t",
    SESSION,
    "-F",
    "#{window_name}\t#{automatic-rename}",
  ]);
  return new TextDecoder()
    .decode(out.stdout)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, auto] = l.split("\t");
      return { name: name ?? "", auto: auto === "1" };
    });
}

/** The program running in the session's pane: what tmux names a tab after. */
function runningProgram(): string {
  const out = Bun.spawnSync([
    "tmux",
    "-L",
    sandbox.tmuxSocket,
    "display",
    "-p",
    "-t",
    SESSION,
    "#{pane_current_command}",
  ]);
  return new TextDecoder().decode(out.stdout).trim();
}

/** Open feature/x's terminal and wait for its first tab. */
async function start() {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/x" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  app = await renderApp();
  await waitForText(app, "feature/x");
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "x");
  app.mockInput.pressEnter();
  // tmux names the tab after its program a moment after it starts: wait until
  // the bar shows whatever tmux calls it now.
  await waitUntil(
    app,
    () => {
      const tab = tmuxTabs()[0];
      return !!tab && tab.name !== "tmux" && app.captureCharFrame().includes(`● ${tab.name} `);
    },
    "the tab bar to show the terminal's tab",
  );
}

/** Where `text` first appears on screen. */
function locate(text: string): { x: number; y: number } {
  const lines = app.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes(text));
  if (y < 0) throw new Error(`"${text}" not on screen`);
  return { x: lines[y]!.indexOf(text), y };
}

/** Right-click the first tab and wait for the rename prompt. */
async function rightClickTab() {
  const { x, y } = locate("● ");
  await app.mockMouse.click(x + 2, y, MouseButtons.RIGHT);
  await waitForText(app, PROMPT);
}

function type(text: string) {
  for (const ch of text) app.mockInput.pressKey(ch, { shift: /[A-Z]/.test(ch) });
}

describe("renaming a terminal tab", () => {
  test("right-click a tab, type a name: tmux's window takes it", async () => {
    await start();
    await rightClickTab();
    app.mockInput.pressKey("u", { ctrl: true });
    type("Dev Server");
    await waitForText(app, "❯ Dev Server");
    app.mockInput.pressEnter();
    await waitForTextGone(app, PROMPT);

    await waitForText(app, "● Dev Server");
    expect(tmuxTabs()).toEqual([{ name: "Dev Server", auto: false }]);
  });

  test("the prompt's keys don't reach the shell underneath", async () => {
    await start();
    await rightClickTab();
    type("zzqq");
    await waitForText(app, "zzqq");
    app.mockInput.pressEscape();
    await waitForTextGone(app, PROMPT);
    // Typed into the prompt only: nothing on the terminal's screen.
    await Bun.sleep(300);
    const frame = app.captureCharFrame();
    expect(frame.split("zzqq").length - 1).toBe(0);
    expect(tmuxTabs()[0]!.auto).toBe(true); // esc: unchanged
  });

  test("an empty name gives the tab back to tmux's automatic naming", async () => {
    await start();
    await rightClickTab();
    app.mockInput.pressKey("u", { ctrl: true });
    type("Scratch");
    app.mockInput.pressEnter();
    await waitForText(app, "● Scratch");

    await rightClickTab();
    await waitForText(app, "❯ Scratch");
    app.mockInput.pressKey("u", { ctrl: true });
    await waitForText(app, "automatic — the program running in it");
    app.mockInput.pressEnter();
    await waitUntil(app, () => tmuxTabs()[0]?.auto === true, "automatic naming to be back on");
    // tmux names it after the program running in it now — not necessarily what
    // it called the tab at first, while the shell was still starting that program.
    await waitUntil(
      app,
      () => tmuxTabs()[0]?.name === runningProgram() && app.captureCharFrame().includes(`● ${runningProgram()} `),
      "the tab to be named after its program again",
    );
  });

  test("⌥r renames the current tab from the keyboard", async () => {
    await start();
    app.mockInput.pressKey("r", { meta: true });
    await waitForText(app, PROMPT);
    app.mockInput.pressKey("u", { ctrl: true });
    type("logs");
    app.mockInput.pressEnter();
    await waitUntil(app, () => tmuxTabs()[0]?.name === "logs", "the tab to be renamed");
  });

  test("a long name is cut short in the bar, kept whole in tmux", async () => {
    await start();
    await rightClickTab();
    app.mockInput.pressKey("u", { ctrl: true });
    type("Dev server on port 3000 (vite)");
    app.mockInput.pressEnter();
    await waitForText(app, "● Dev server on port…");
    expect(tmuxTabs()[0]!.name).toBe("Dev server on port 3000 (vite)");
    // …and the prompt starts from the whole name.
    await rightClickTab();
    await waitForText(app, "❯ Dev server on port 3000 (vite)");
  });

  test("a name starting with a dash is taken literally", async () => {
    await start();
    await rightClickTab();
    app.mockInput.pressKey("u", { ctrl: true });
    type("-n logs");
    app.mockInput.pressEnter();
    await waitUntil(app, () => tmuxTabs()[0]?.name === "-n logs", "the literal name");
  });
});
