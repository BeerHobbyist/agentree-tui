/**
 * Frame assertions for the headless renderer.
 *
 * The app's work is asynchronous (git/gh subprocesses, PTY bytes), and
 * OpenTUI's own `waitFor*` count render passes rather than wall-clock time, so
 * these poll: sleep, re-render, look at the frame.
 */
import { TextAttributes } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { getTheme } from "../../src/theme";

const STEP_MS = 20;
const DEFAULT_TIMEOUT_MS = 8_000;

export interface WaitOptions {
  timeoutMs?: number;
}

/** The current frame, with trailing blank space trimmed for readable failures. */
export function screen(t: TestRendererSetup): string {
  return t
    .captureCharFrame()
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** Let pending renders and microtasks land. */
export async function settle(t: TestRendererSetup): Promise<void> {
  await t.renderOnce();
  await t.flush();
}

function spanHex(color: { buffer: ArrayLike<number> }): string {
  return "#" + [0, 1, 2].map((i) => Number(color.buffer[i]).toString(16).padStart(2, "0")).join("");
}

/**
 * The selected row's text. The sidebar marks the selection with colour only —
 * an accent-coloured gutter cell — so this reads the spans, not the glyphs.
 * A selected worktree can be two lines tall (its branch under its name); both
 * are returned, joined by a space.
 */
export function selection(t: TestRendererSetup): string {
  const accent = getTheme().accent.toLowerCase();
  return t
    .captureSpans()
    .lines.filter((line) => line.spans.some((s) => spanHex(s.bg) === accent))
    .map((line) =>
      line.spans
        .map((s) => s.text)
        .join("")
        .trim(),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The terminal's tab bar: the screen's top row (the sidebar's is blank). */
export function tabBar(t: TestRendererSetup): string {
  return screen(t).split("\n")[0] ?? "";
}

/** The name of the tab on screen — the bar draws it bold, and nothing else. */
export function activeTab(t: TestRendererSetup): string {
  const top = t.captureSpans().lines[0]?.spans ?? [];
  return top
    .filter((s) => s.attributes & TextAttributes.BOLD)
    .map((s) => s.text)
    .join("")
    .trim();
}

/** Wait until the tab bar shows a tab called `name`. */
export function waitForTab(t: TestRendererSetup, name: string, opts?: WaitOptions): Promise<string> {
  return poll(
    t,
    () => tabBar(t).includes(` ${name} `),
    `a tab called ${JSON.stringify(name)} (bar: ${JSON.stringify(tabBar(t))})`,
    opts,
  );
}

/** Wait until the selected row's text contains `text`. */
export function waitForSelection(t: TestRendererSetup, text: string, opts?: WaitOptions): Promise<string> {
  return poll(
    t,
    () => selection(t).includes(text),
    `selection to contain ${JSON.stringify(text)} (last: ${JSON.stringify(selection(t))})`,
    opts,
  );
}

async function poll(
  t: TestRendererSetup,
  predicate: (frame: string) => boolean,
  describe: string,
  opts: WaitOptions = {},
): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let frame = screen(t);
  if (predicate(frame)) return frame;
  while (Date.now() < deadline) {
    await Bun.sleep(STEP_MS);
    await t.renderOnce();
    frame = screen(t);
    if (predicate(frame)) return frame;
  }
  throw new Error(`timed out waiting for ${describe}\n--- last frame ---\n${frame}\n---`);
}

/** Wait until `text` appears on screen; returns the frame that showed it. */
export function waitForText(t: TestRendererSetup, text: string, opts?: WaitOptions): Promise<string> {
  return poll(t, (f) => f.includes(text), `text ${JSON.stringify(text)}`, opts);
}

/** Wait until every one of `texts` is on screen at the same time. */
export function waitForAll(t: TestRendererSetup, texts: string[], opts?: WaitOptions): Promise<string> {
  return poll(t, (f) => texts.every((x) => f.includes(x)), `texts ${JSON.stringify(texts)}`, opts);
}

/** Wait until `text` is gone from the screen. */
export function waitForTextGone(t: TestRendererSetup, text: string, opts?: WaitOptions): Promise<string> {
  return poll(t, (f) => !f.includes(text), `absence of ${JSON.stringify(text)}`, opts);
}

/**
 * Wait until the add-worktree modal has closed. Its phases swap the body out
 * (a list becomes "Creating worktree…"), so waiting for body text to vanish
 * says nothing about whether the modal still owns the keyboard — its border
 * title does.
 */
export function waitForModalClosed(t: TestRendererSetup, opts?: WaitOptions): Promise<string> {
  return waitForTextGone(t, "Add worktree", opts);
}

/** Wait until a non-frame condition holds (state written to disk, a spy fired). */
export function waitUntil(
  t: TestRendererSetup,
  predicate: () => boolean,
  describe: string,
  opts?: WaitOptions,
): Promise<string> {
  return poll(t, () => predicate(), describe, opts);
}
