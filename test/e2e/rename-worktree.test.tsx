/**
 * Renaming a worktree gives it a label in the sidebar — nothing more: its
 * branch and directory keep their names.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MouseButtons } from "@opentui/core/testing";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
import { git, makeRepo } from "../helpers/repo";
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

const MODAL = "Label for";

/** One project (main + feature/x), with feature/x selected. */
async function start(): Promise<string> {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/x" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  app = await renderApp();
  await waitForText(app, `${ICON.noAgent} x`);
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "x");
  return root;
}

const labels = () => sandbox.readState()?.repos[0]?.labels;
/** feature/x's id — from its directory, `.worktrees/feature-x`. */
const X = "feature-x";

/** Type text as a person would, shift and all. */
function type(text: string) {
  for (const ch of text) app.mockInput.pressKey(ch, { shift: /[A-Z]/.test(ch) });
}

/** R, then replace the prefilled name with `label`, then ⏎. */
async function rename(label: string) {
  app.mockInput.pressKey("R", { shift: true });
  await waitForText(app, MODAL);
  app.mockInput.pressKey("u", { ctrl: true });
  type(label);
  await waitForText(app, `❯ ${label}`);
  app.mockInput.pressEnter();
  await waitForTextGone(app, MODAL);
}

/** Where `text` first appears on screen. */
function locate(text: string): { x: number; y: number } {
  const lines = app.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes(text));
  if (y < 0) throw new Error(`"${text}" not on screen`);
  return { x: lines[y]!.indexOf(text), y };
}

describe("renaming a worktree", () => {
  test("R gives it a label; the branch and directory keep their names", async () => {
    const root = await start();
    await rename("Login Screen");

    const frame = await waitForText(app, `${ICON.noAgent} Login Screen`);
    expect(frame).toContain("feature/x"); // the branch, still on the row's second line
    expect(frame).not.toContain(`${ICON.noAgent} x `);
    await waitUntil(app, () => labels()?.[X] === "Login Screen", "the label to be saved");

    const stored = sandbox.readState()!.repos[0]!.worktrees[0]!;
    expect(stored).toMatchObject({ id: X, branch: "feature/x", name: "x" });
    expect(existsSync(stored.path)).toBe(true);
    expect(await git(["branch", "--list", "feature/x"], root)).toContain("feature/x");
  });

  test("the modal starts from the current name, and esc changes nothing", async () => {
    await start();
    app.mockInput.pressKey("R", { shift: true });
    await waitForText(app, "❯ x");
    type("yz");
    await waitForText(app, "❯ xyz");
    app.mockInput.pressEscape();
    await waitForTextGone(app, MODAL);
    expect(app.captureCharFrame()).toContain(`${ICON.noAgent} x`);
    expect(labels()).toBeUndefined();
  });

  test("a label survives a restart", async () => {
    await start();
    await rename("Spike");
    await waitUntil(app, () => labels()?.[X] === "Spike", "the label to be saved");
    app.dispose();

    app = await renderApp();
    await waitForText(app, `${ICON.noAgent} Spike`);
  });

  test("clearing the label goes back to the branch name", async () => {
    await start();
    await rename("Spike");
    await waitForText(app, `${ICON.noAgent} Spike`);

    app.mockInput.pressKey("R", { shift: true });
    await waitForText(app, "❯ Spike");
    app.mockInput.pressKey("u", { ctrl: true });
    await waitForText(app, "❯ x"); // the name it falls back to, as a placeholder
    app.mockInput.pressEnter();
    await waitForTextGone(app, "Spike");
    expect(app.captureCharFrame()).toContain(`${ICON.noAgent} x`);
    await waitUntil(app, () => labels() === undefined, "the label to be dropped");
  });

  test("pasting into the label works, line breaks and all", async () => {
    await start();
    app.mockInput.pressKey("R", { shift: true });
    await waitForText(app, MODAL);
    app.mockInput.pressKey("u", { ctrl: true });
    await app.mockInput.pasteBracketedText("Login\nscreen");
    await waitForText(app, "❯ Login screen");
    app.mockInput.pressEnter();
    await waitForText(app, `${ICON.noAgent} Login screen`);
  });

  test("right-clicking a worktree renames it", async () => {
    await start();
    const { x, y } = locate(`${ICON.noAgent} main`);
    await app.mockMouse.click(x + 2, y, MouseButtons.RIGHT);
    await waitForText(app, "Label for main");
    app.mockInput.pressKey("u", { ctrl: true });
    type("Trunk");
    app.mockInput.pressEnter();
    await waitForText(app, `${ICON.noAgent} Trunk`);
    await waitUntil(app, () => labels()?.main === "Trunk", "the main copy's label to be saved");
  });

  test("r still refreshes — only R renames — and R on a project header does nothing", async () => {
    await start();
    app.mockInput.pressKey("r");
    await Bun.sleep(100);
    expect(app.captureCharFrame()).not.toContain(MODAL);

    app.mockInput.pressKey("g"); // the project header
    await waitForSelection(app, "widget");
    app.mockInput.pressKey("R", { shift: true });
    await Bun.sleep(100);
    expect(app.captureCharFrame()).not.toContain(MODAL);
  });

  test("closing a labelled worktree names both the label and the branch", async () => {
    await start();
    await rename("Spike");
    await waitForText(app, `${ICON.noAgent} Spike`);
    app.mockInput.pressKey("d");
    await waitForText(app, 'Delete "Spike" (feature/x) from disk?');
  });
});
