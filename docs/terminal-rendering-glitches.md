# Terminal rendering glitches — findings & fixes

_Investigated 2026-09-22. Two separate bugs: (1) the terminal flashing when you
switch worktrees, and (2) the cursor strobing rapidly while Claude Code works._

TL;DR:

| Glitch | Cause | Status | Where |
|---|---|---|---|
| Flash on worktree switch | We tore down the PTY and re-attached tmux on every switch; a re-attach does a full clear+redraw | **Fixed** (keep terminals mounted) | PR #18, branch `fix/terminal-switch-flash` |
| Cursor strobes while Claude works | OpenTUI's `EmbeddedTerminal` re-mirrors the child's cursor to the host terminal every frame | **Fixed locally**, upstream candidate | PR / branch `fix/embedded-terminal-cursor-dedupe` |

---

## 1. Flash when switching worktrees — FIXED

### Cause
There was a single `<embedded-terminal>` reused for every worktree. Switching
changed its derived `command` (the `tmux attach` argv is keyed on the session),
so `useTerminalSession` tore down the old PTY and spawned a fresh `tmux attach`
for the new session. **A tmux re-attach always does a full-screen clear + redraw
— that's the flash.** The two earlier "stop flashing" commits (`0b66acb`,
`c963fef`) only stopped the React *remount* of the view; the re-attach underneath
still happened on every switch.

### Fix
Keep one terminal per opened worktree mounted, and just toggle visibility:

- `App` tracks every worktree opened at least once (`opened`) and renders a
  `TerminalPane` for each, keyed by worktree.
- Only the active worktree's pane is `visible`; the rest are `display:none`
  (no layout cost) but stay mounted, so their PTY/tmux attach is **never torn
  down**. Switching back is instant — same emulator, no re-attach, no flash.
- Closing a worktree drops it from `opened` (unmounting it, tearing down its
  PTY) and falls back to another mounted terminal, or the placeholder pane.

Files: `src/app.tsx`, `src/components/TerminalPane.tsx`.

### Verified
Driven through the headless harness (real PTYs + real tmux on an isolated
socket): terminals spawn, attach, render, and the active pane switches correctly
with the previous one staying attached. `bun run typecheck` clean; all 141 tests
pass.

---

## 2. Cursor strobes rapidly while Claude works — FIXED LOCALLY (upstream candidate)

### Cause (this is the one you wanted to be able to verify)
Your terminal ends up with **two cursors**: the real hardware cursor of your
outer terminal, and Claude's cursor inside the emulated terminal. When a worktree
terminal is focused, OpenTUI makes the real one track the emulated one — and it
re-asserts that on **every rendered frame**.

The relevant code is `EmbeddedTerminal.renderSelf` in `@opentui/core`
(our installed copy: `node_modules/@opentui/core/index.bun.js`, and upstream
`packages/core/src/renderables/EmbeddedTerminal.ts`). Simplified:

```js
renderSelf(buffer) {
  ...
  this.lib.embeddedTerminalCompose(this.handle, buffer.ptr, 0, 0); // draw content
  if (!this.focused) return;
  const cursor = this.lib.embeddedTerminalCursor(this.handle);
  const visible = cursor.visible && cursor.hasValue;
  this._ctx.setCursorPosition(screenX + cursorX + 1, screenY + cursor.y + 1, visible);
  if (!visible) return;
  this._ctx.setCursorStyle({ style, blinking: cursor.blinking }); // re-asserts blink EVERY frame
  if (cursor.color) this._ctx.setCursorColor(...);
}
```

And a frame is composed on **every PTY chunk**:

```js
write(data) {
  this.lib.embeddedTerminalWrite(this.handle, data);
  ...
  this.requestRender();   // one render per PTY chunk
}
```

Now stack it up while Claude works:

1. Claude animates its spinner → many small writes/sec → many renders/sec.
2. Like most TUIs, Claude hides its cursor while redrawing and shows it after
   (`ESC[?25l` … `ESC[?25h`), so `cursor.visible` flips false→true repeatedly.
3. Every frame re-sends the host cursor's position, visibility, **and blink
   style**.

Result: the real cursor is shown/hidden/repositioned dozens of times/sec (the
flashing), and re-sending `{ blinking: true }` each frame keeps **restarting the
terminal's blink timer**, so it never settles into a normal ~2 Hz blink and
strobes instead. Nothing is functionally broken — input still goes where it
should — it's purely cosmetic.

### Why it's an OpenTUI issue, not ours
When you run Claude directly, or under plain `tmux`, there's no strobe — plain
tmux relays the same nested cursor but only emits a change when it actually
changes. Our app runs Claude under tmux too, but then wraps tmux's output in
OpenTUI's `EmbeddedTerminal`, which adds a second, less careful relay layer on
top. **opencode** (the SST agent) is built on the *same* OpenTUI yet never hits
this — because it doesn't route an interactive full-screen program through
`EmbeddedTerminal` (it is the agent itself, talking to the API; its optional
shell panel uses `ghostty-web`). So the bug is specific to our
embed-a-terminal-and-run-`claude`-in-it design + `EmbeddedTerminal`.

### The local fix
`src/components/EmbeddedTerminal.tsx` now registers a thin subclass,
`DedupedEmbeddedTerminal`. During the base render it intercepts the three cursor
calls and drops any that repeat the previous frame's value, so the host cursor is
only touched when it actually moves / changes visibility / restyles. Compose and
everything else still run via `super` — only redundant cursor escapes are
suppressed. Focus changes invalidate the cache so the cursor re-asserts correctly.

**A/B it yourself:** run normally to get the fix; run with
`AGENTREE_CURSOR_DEDUPE=off` to see the old (flashing) behavior for comparison.

```bash
bun run dev                        # deduped (fixed)
AGENTREE_CURSOR_DEDUPE=off bun run dev   # stock OpenTUI (flashing)
```

Caveat: if Claude genuinely toggles its cursor state every frame (real changes,
not repeats), the dedupe can't skip those and some flicker may remain — that
would tell us the deeper fix is to debounce to the settled cursor state rather
than sample per frame. Watching the A/B is how we find out.

---

## Sources to verify (for the upstream decision)

**Our code:**
- Switch-flash fix: PR #18 (`fix/terminal-switch-flash`) — `src/app.tsx`,
  `src/components/TerminalPane.tsx`.
- Cursor dedupe: branch `fix/embedded-terminal-cursor-dedupe` —
  `src/components/EmbeddedTerminal.tsx`.

**OpenTUI (upstream repo is `anomalyco/opentui`; `sst/opentui` redirects there):**
- The bug lives in `packages/core/src/renderables/EmbeddedTerminal.ts`,
  method `renderSelf` (~lines 283–298): calls `setCursorPosition` /
  `setCursorStyle` unconditionally every frame when focused, with no comparison
  to the previous frame. Confirmed present in current `main`.
- **Precedent — the maintainers already shipped this exact class of fix, but only
  in the _main_ renderer, never in `EmbeddedTerminal`:**
  - PR #287 — "fix: iTerm2 cursor blinking issue" → *"prevents showing the cursor
    ANSI code on every render."* https://github.com/anomalyco/opentui/pull/287
  - PR #794 — "fix: preserve terminal's native cursor style by default" → stopped
    emitting the cursor-style escape every frame.
    https://github.com/anomalyco/opentui/pull/794
- Related (not the same bug): issue #1339 — per-render tree walk cost from a
  spinner. https://github.com/anomalyco/opentui/issues/1339
- **No existing issue or PR describes the `EmbeddedTerminal` host-cursor strobe**
  (searched open/closed issues + PRs, 2026-09-22). It's unreported → good
  candidate to file.
- Versions: latest published `@opentui/core` is 0.5.12; we're on 0.5.11. 0.5.12
  does **not** fix this — upgrading won't help.

**opencode cross-check (confirms the bug is `EmbeddedTerminal`-specific):**
- Current opencode (v1.16+) is TypeScript + Solid.js on OpenTUI (Bun); older
  releases were Go + Bubble Tea. Either way it renders itself and talks to
  Anthropic over HTTPS (`packages/llm/src/protocols/anthropic-messages.ts`,
  `DEFAULT_BASE_URL = "https://api.anthropic.com/v1"`). It never spawns the
  `claude` CLI. Its pty feature is an optional shell panel (desktop/web uses
  `ghostty-web`), not a model host.

## Recommendation
If the A/B confirms the strobe is gone: **file the upstream issue/PR against
`anomalyco/opentui`** (apply the #287/#794 dedupe to `EmbeddedTerminal.renderSelf`)
and keep our subclass as an interim workaround until it lands, then delete it.
If the strobe only partially improves, we escalate the upstream proposal to
"debounce to settled cursor state" instead of a simple dedupe.
