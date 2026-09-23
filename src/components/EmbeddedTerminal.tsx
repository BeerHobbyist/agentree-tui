/**
 * Registers OpenTUI's EmbeddedTerminalRenderable as the `<embedded-terminal>`
 * JSX element. Importing this module for its side effect runs `extend()`.
 *
 * We register a subclass (`StableCursorEmbeddedTerminal`) that fixes the host
 * cursor "flashing"/"erratic" behavior seen while a child program redraws.
 */
import {
  EmbeddedTerminalRenderable,
  type CursorStyleOptions,
  type OptimizedBuffer,
  type RGBA,
} from "@opentui/core";
import { extend, type ExtendedComponentProps } from "@opentui/react";

/** `AGENTREE_CURSOR_SMOOTH=off` restores the stock (flashing) behavior for A/B. */
const SMOOTH_ON = (process.env.AGENTREE_CURSOR_SMOOTH ?? "on") !== "off";
/** How long output must be quiet before we trust the child's cursor position. */
const SETTLE_MS = 20;

/**
 * The base `renderSelf` mirrors the child's cursor onto the *host* terminal's
 * hardware cursor on every composed frame, and a frame is composed on every PTY
 * chunk. While a full-screen program redraws (nvim moving between lines parks the
 * cursor at column 0 mid-redraw; Claude's spinner streams constantly), frames
 * catch those transient positions — so the host cursor flashes to the start of
 * the line and jitters around, or strobes.
 *
 * Fix: while output is actively streaming, don't chase the cursor at all — leave
 * the host cursor where it last settled. When output goes quiet (SETTLE_MS with
 * no writes) assert the now-final cursor once. When it does update, dedupe so an
 * unchanged cursor is never re-emitted (re-sending the blink style also resets
 * the terminal's blink phase, which reads as a strobe).
 *
 * Compose and everything else still run via `super.renderSelf`; we only gate the
 * three cursor calls it makes, by temporarily swapping them on the render context
 * for the duration of the call.
 */
class StableCursorEmbeddedTerminal extends EmbeddedTerminalRenderable {
  private outputActive = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPos = "";
  private lastStyle = "";
  private lastColor = "";

  override write(data: string | Uint8Array): void {
    // Mark output active and (re)arm the settle timer; a burst keeps pushing it
    // out, so we only re-assert the cursor once the child stops writing.
    if (SMOOTH_ON) {
      this.outputActive = true;
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.outputActive = false;
        this.settleTimer = null;
        this.requestRender(); // one frame to assert the settled cursor
      }, SETTLE_MS);
    }
    super.write(data);
  }

  private resetCursorCache(): void {
    this.lastPos = "";
    this.lastStyle = "";
    this.lastColor = "";
  }

  // Focus transitions re-assert/hide the cursor outside renderSelf, so drop the
  // cache to force the next frame to re-emit the real state.
  override focus(): void {
    this.resetCursorCache();
    super.focus();
  }
  override blur(): void {
    super.blur();
    this.resetCursorCache();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!SMOOTH_ON || !this.focused) {
      super.renderSelf(buffer);
      return;
    }
    const ctx = this._ctx;
    const origPos = ctx.setCursorPosition;
    const origStyle = ctx.setCursorStyle;
    const origColor = ctx.setCursorColor;

    if (this.outputActive) {
      // Mid-redraw: freeze the host cursor entirely — don't chase transient
      // positions. It'll be asserted when output settles.
      const noop = () => {};
      ctx.setCursorPosition = noop;
      ctx.setCursorStyle = noop;
      ctx.setCursorColor = noop;
    } else {
      // Settled: assert, but skip anything identical to the last emission.
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
    }

    try {
      super.renderSelf(buffer);
    } finally {
      ctx.setCursorPosition = origPos;
      ctx.setCursorStyle = origStyle;
      ctx.setCursorColor = origColor;
    }
  }

  protected override destroySelf(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    super.destroySelf();
  }
}

extend({ "embedded-terminal": StableCursorEmbeddedTerminal });

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "embedded-terminal": typeof EmbeddedTerminalRenderable;
  }
}

export type EmbeddedTerminalProps = ExtendedComponentProps<
  typeof EmbeddedTerminalRenderable
>;

export { EmbeddedTerminalRenderable, StableCursorEmbeddedTerminal };
