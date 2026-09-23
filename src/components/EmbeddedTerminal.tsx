/**
 * Registers OpenTUI's EmbeddedTerminalRenderable as the `<embedded-terminal>`
 * JSX element. Importing this module for its side effect runs `extend()`.
 *
 * We register a thin subclass (`DedupedEmbeddedTerminal`) that stops the host
 * terminal's cursor from strobing while a busy child (e.g. Claude Code) streams
 * output. See the class comment for the why.
 */
import {
  EmbeddedTerminalRenderable,
  type CursorStyleOptions,
  type OptimizedBuffer,
  type RGBA,
} from "@opentui/core";
import { extend, type ExtendedComponentProps } from "@opentui/react";

/** `AGENTREE_CURSOR_DEDUPE=off` restores the stock (flashing) behavior for A/B. */
const DEDUPE_ON = (process.env.AGENTREE_CURSOR_DEDUPE ?? "on") !== "off";

/**
 * When focused, the base `renderSelf` mirrors the child's cursor to the *host*
 * terminal on every composed frame — it calls `setCursorPosition` /
 * `setCursorStyle` unconditionally, and a frame is composed on every PTY chunk.
 * A busy child (spinner) produces dozens of chunks/sec, so the host cursor is
 * repositioned and its blink style re-asserted dozens of times/sec, which reads
 * as rapid flashing (re-sending the blink style also keeps resetting the
 * terminal's blink phase).
 *
 * This override intercepts those three cursor calls for the duration of the
 * base render and drops any that repeat the previous frame's value, so the host
 * cursor is only touched when it actually moves / changes visibility / restyles.
 * It's the same dedupe OpenTUI already applies in its *main* renderer (upstream
 * PRs #287, #794) — just not in EmbeddedTerminal. Compose and everything else
 * still run via `super`, so only redundant cursor escapes are suppressed.
 */
class DedupedEmbeddedTerminal extends EmbeddedTerminalRenderable {
  private lastPos = "";
  private lastStyle = "";
  private lastColor = "";

  private resetCursorCache(): void {
    this.lastPos = "";
    this.lastStyle = "";
    this.lastColor = "";
  }

  // Focus changes re-assert the cursor outside renderSelf (blur hides it), so
  // invalidate the cache to force the next frame to re-emit the real state.
  override focus(): void {
    this.resetCursorCache();
    super.focus();
  }
  override blur(): void {
    super.blur();
    this.resetCursorCache();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!DEDUPE_ON || !this.focused) {
      super.renderSelf(buffer);
      return;
    }
    const ctx = this._ctx;
    const origPos = ctx.setCursorPosition;
    const origStyle = ctx.setCursorStyle;
    const origColor = ctx.setCursorColor;

    ctx.setCursorPosition = (x: number, y: number, visible: boolean) => {
      const k = `${x},${y},${visible}`;
      if (k === this.lastPos) return;
      this.lastPos = k;
      origPos.call(ctx, x, y, visible);
    };
    ctx.setCursorStyle = (o: CursorStyleOptions) => {
      const k = `${o?.style ?? ""}|${o?.blinking ?? ""}`;
      if (k === this.lastStyle) return;
      this.lastStyle = k;
      origStyle.call(ctx, o);
    };
    ctx.setCursorColor = (c: RGBA) => {
      const k = String((c as { buffer?: ArrayLike<number> })?.buffer ?? c);
      if (k === this.lastColor) return;
      this.lastColor = k;
      origColor.call(ctx, c);
    };

    try {
      super.renderSelf(buffer);
    } finally {
      ctx.setCursorPosition = origPos;
      ctx.setCursorStyle = origStyle;
      ctx.setCursorColor = origColor;
    }
  }
}

extend({ "embedded-terminal": DedupedEmbeddedTerminal });

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "embedded-terminal": typeof EmbeddedTerminalRenderable;
  }
}

export type EmbeddedTerminalProps = ExtendedComponentProps<
  typeof EmbeddedTerminalRenderable
>;

export { EmbeddedTerminalRenderable, DedupedEmbeddedTerminal };
