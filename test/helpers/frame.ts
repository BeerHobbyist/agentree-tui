/**
 * Frame assertions for the headless renderer.
 *
 * The app's work is asynchronous (git/gh subprocesses, PTY bytes), and
 * OpenTUI's own `waitFor*` count render passes rather than wall-clock time, so
 * these poll: sleep, re-render, look at the frame.
 */
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
 * an accent gutter cell on a project header, an accent border round a worktree
 * card — so this reads the spans, not the glyphs. A card's two lines are both
 * returned, joined by a space, without the border.
 */
export function selection(t: TestRendererSetup): string {
  const accent = getTheme().accent.toLowerCase();
  // Only at the sidebar's left edge: elsewhere accent marks other things.
  const marked = (line: ReturnType<TestRendererSetup["captureSpans"]>["lines"][number]) => {
    let col = 0;
    for (const s of line.spans) {
      if (col > 1) return false;
      if (spanHex(s.bg) === accent) return true;
      if (spanHex(s.fg) === accent && s.text.trimStart().startsWith("│")) return true;
      col += Bun.stringWidth(s.text);
    }
    return false;
  };
  return t
    .captureSpans()
    .lines.filter(marked)
    .map((line) =>
      line.spans
        .map((s) => s.text)
        .join("")
        .replace(/[│╭╮╰╯─]/g, " ")
        .trim(),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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
