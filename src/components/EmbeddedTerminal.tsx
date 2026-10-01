/**
 * Registers OpenTUI's EmbeddedTerminalRenderable as the `<embedded-terminal>`
 * JSX element. Importing this module for its side effect runs `extend()`.
 *
 * We register a subclass (`StableCursorEmbeddedTerminal`) that fixes the host
 * cursor "flashing"/"erratic" behavior seen while a child program redraws.
 */
import {
  EmbeddedTerminalRenderable,
  type CliRenderer,
  type CursorStyleOptions,
  type KeyEvent,
  type MouseEvent,
  type OptimizedBuffer,
  type PasteEvent,
  type RGBA,
} from "@opentui/core";
import { extend, type ExtendedComponentProps } from "@opentui/react";
import { EXIT_COPY_MODE_KEY } from "../services/tmux";

/** `AGENTREE_CURSOR_SMOOTH=off` restores the stock (flashing) behavior for A/B. */
const SMOOTH_ON = (process.env.AGENTREE_CURSOR_SMOOTH ?? "on") !== "off";
/** How long output must be quiet before we trust the child's cursor position. */
const SETTLE_MS = 20;

/** DECSCUSR, `CSI Ps SP q` — "set cursor style". Ps 0 or empty = terminal default. */
const DECSCUSR = /\x1b\[(\d*) q/g;
/** A DECSCUSR cut off at the end of a chunk, to be completed by the next one. */
const DECSCUSR_PARTIAL = /\x1b(?:\[\d*(?: )?)?$/;
const utf8 = new TextDecoder();
const EXIT_COPY_MODE_BYTES = new TextEncoder().encode(EXIT_COPY_MODE_KEY);

/**
 * Ps of the last DECSCUSR in `text` (0 for "terminal default"), or undefined if
 * `text` has none. Exported for tests.
 */
export function lastCursorStyleRequest(text: string): number | undefined {
  let ps: string | undefined;
  for (const m of text.matchAll(DECSCUSR)) ps = m[1];
  return ps === undefined ? undefined : Number(ps || "0");
}

/** OSC 52, "set the clipboard": `ESC ] 52 ; targets ; base64`, ended by BEL or ST. */
const OSC52 = /\x1b\]52;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
/** The start of an OSC 52 that a chunk ends before finishing. */
const OSC52_UNFINISHED = /\x1b(?:\](?:5(?:2(?:;[^\x07\x1b]*(?:;[^\x07\x1b]*\x1b?)?)?)?)?)?$/;
/** Longest unfinished OSC 52 kept waiting for its end; past it, it's dropped. */
const OSC52_MAX = 8 * 1024 * 1024;
const OSC52_START = "\x1b]52";

/**
 * The texts the OSC 52 sequences in `text` put on the clipboard (a query, `?`,
 * puts nothing), and the unfinished one at its end, to put in front of the
 * next chunk. Exported for tests.
 */
export function clipboardWrites(text: string): { texts: string[]; rest: string } {
  const texts: string[] = [];
  for (const m of text.matchAll(OSC52)) {
    if (m[1] !== "?") texts.push(Buffer.from(m[1] ?? "", "base64").toString("utf8"));
  }
  const rest = OSC52_UNFINISHED.exec(text)?.[0] ?? "";
  return { texts, rest: rest.length > OSC52_MAX ? "" : rest };
}

/** Whether a chunk can hold the start of an OSC 52, perhaps cut off at its end. */
function mayHoldOsc52(data: string | Uint8Array): boolean {
  const s = typeof data === "string" ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return s.indexOf(OSC52_START) >= 0 || s.indexOf("\x1b", Math.max(0, s.length - OSC52_START.length + 1)) >= 0;
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

  private osc52Carry = "";

  /**
   * tmux copies a selection by sending OSC 52 to its terminal, and the
   * emulator drops it, so hand the text to the host terminal's clipboard.
   */
  private forwardClipboard(data: string | Uint8Array): void {
    if (!this.osc52Carry && !mayHoldOsc52(data)) return; // cheap skip: no OSC 52 possible
    const { texts, rest } = clipboardWrites(this.osc52Carry + (typeof data === "string" ? data : utf8.decode(data)));
    this.osc52Carry = rest;
    const renderer = this._ctx as Partial<Pick<CliRenderer, "copyToClipboardOSC52">>;
    for (const text of texts) renderer.copyToClipboardOSC52?.(text);
  }

  override write(data: string | Uint8Array): void {
    this.forwardClipboard(data);
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
        const eff: CursorStyleOptions = this.childCursorStyle === null ? { style: "default" } : o;
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

  /** Whether the mouse button currently held went down on this terminal. */
  private pressStartedHere = false;
  /** Whether tmux has taken a mouse press here, so it may hold a mouse selection. */
  private tmuxHasTheMouse = false;
  /** Whether the pane in front may hold a mouse selection; see exitCopyModeOnNextInput. */
  private exitCopyModeOnInput = false;

  /**
   * Drop a button release whose press began somewhere else — e.g. dragging the
   * sidebar divider and letting go over the terminal. The renderer hands that
   * release to the captured divider *and* to whatever is under the pointer, so
   * without this the program inside would get a release with no press.
   */
  override processMouseEvent(event: MouseEvent): void {
    if (event.type === "down") {
      this.pressStartedHere = true;
    } else if (event.type === "up") {
      const startedHere = this.pressStartedHere;
      this.pressStartedHere = false;
      if (!startedHere) return;
    }
    super.processMouseEvent(event);
    // Forwarded, so tmux has the mouse: the press may make a selection, or put
    // another split pane in front.
    if (event.type === "down" && event.defaultPrevented) {
      this.tmuxHasTheMouse = true;
      this.exitCopyModeOnInput = true;
    }
  }

  /**
   * A mouse selection stays on screen in tmux copy mode, where keys are
   * copy-mode commands. So once the pane in front may hold one — after a
   * press in the terminal, or a switch of tab or pane — the next key or paste
   * goes out behind EXIT_COPY_MODE_KEY, which takes such a pane out of copy
   * mode and lets the typing through to the shell, as in a plain terminal.
   * Only the next one: tmux prompts read every key, the exit key included.
   * And only once tmux has had a press here: before that, there's no
   * selection to leave, and what reads the keys may not be tmux at all (an
   * SSH host's password prompt).
   */
  exitCopyModeOnNextInput(): void {
    if (this.tmuxHasTheMouse) this.exitCopyModeOnInput = true;
  }

  private sendAfterExitingCopyMode(output: Uint8Array): void {
    if (output.byteLength === 0) return;
    this.exitCopyModeOnInput = false;
    this.onData?.(EXIT_COPY_MODE_BYTES, "input");
    this.onData?.(output, "input");
  }

  override handleKeyPress(key: KeyEvent): boolean {
    if (!this.exitCopyModeOnInput) return super.handleKeyPress(key);
    const output = this.encodeKey(key);
    this.sendAfterExitingCopyMode(output);
    return output.byteLength > 0;
  }

  override handlePaste(event: PasteEvent): void {
    if (this.exitCopyModeOnInput) this.sendAfterExitingCopyMode(this.encodePaste(event.bytes));
    else super.handlePaste(event);
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

/** See StableCursorEmbeddedTerminal.exitCopyModeOnNextInput. */
export function exitCopyModeOnNextInput(terminal: EmbeddedTerminalRenderable | null): void {
  if (terminal instanceof StableCursorEmbeddedTerminal) terminal.exitCopyModeOnNextInput();
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "embedded-terminal": typeof EmbeddedTerminalRenderable;
  }
}

export type EmbeddedTerminalProps = ExtendedComponentProps<typeof EmbeddedTerminalRenderable>;

export { EmbeddedTerminalRenderable, StableCursorEmbeddedTerminal };
