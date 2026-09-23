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

/** DECSCUSR, `CSI Ps SP q` — "set cursor style". Ps 0 or empty = terminal default. */
const DECSCUSR = /\x1b\[(\d*) q/g;
/** A DECSCUSR cut off at the end of a chunk, to be completed by the next one. */
const DECSCUSR_PARTIAL = /\x1b(?:\[\d*(?: )?)?$/;
const utf8 = new TextDecoder();

/**
 * Ps of the last DECSCUSR in `text` (0 for "terminal default"), or undefined if
 * `text` has none. Exported for tests.
 */
export function lastCursorStyleRequest(text: string): number | undefined {
  let ps: string | undefined;
  for (const m of text.matchAll(DECSCUSR)) ps = m[1];
  return ps === undefined ? undefined : Number(ps || "0");
}

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
 * Shape: the emulator reports a concrete shape even when the child never asked
 * for one (a steady block), and forwarding that pins the user's real cursor to
 * a non-blinking block in every shell and Claude Code. Unless the child sent an
 * explicit DECSCUSR, we ask the host for its own default cursor instead.
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
  /**
   * The cursor shape the child explicitly asked for (DECSCUSR 1–6), or null
   * while it hasn't asked / asked for the terminal default. The emulator can't
   * tell us this — it always reports a concrete shape, "steady block" when
   * nothing was requested — so we read it off the byte stream ourselves.
   */
  private childCursorStyle: number | null = null;
  private decscusrCarry = "";

  private trackCursorStyle(data: string | Uint8Array): void {
    const hasQ = typeof data === "string" ? data.includes("q") : data.includes(0x71);
    if (!hasQ && !this.decscusrCarry) return; // cheap skip: no DECSCUSR possible
    const text = this.decscusrCarry + (typeof data === "string" ? data : utf8.decode(data));
    const ps = lastCursorStyleRequest(text);
    if (ps !== undefined) this.childCursorStyle = ps === 0 ? null : ps;
    this.decscusrCarry = DECSCUSR_PARTIAL.exec(text)?.[0] ?? "";
  }

  override write(data: string | Uint8Array): void {
    // Mark output active and (re)arm the settle timer; a burst keeps pushing it
    // out, so we only re-assert the cursor once the child stops writing.
    if (SMOOTH_ON) {
      this.trackCursorStyle(data);
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
        // Child hasn't asked for a shape → give the host its *own* cursor (which
        // blinks per the user's terminal config) instead of forcing the
        // emulator's steady-block fallback. Explicit shapes (nvim's steady
        // block, a blinking bar, …) pass through untouched.
        const eff: CursorStyleOptions =
          this.childCursorStyle === null ? { style: "default" } : o;
        const k = `${eff.style ?? ""}|${eff.blinking ?? ""}`;
        if (k === this.lastStyle) return;
        this.lastStyle = k;
        origStyle.call(ctx, eff);
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
