# agentree-tui — Dev Log & State

_Last updated: 2026-09-21 · Repo: github.com/BeerHobbyist/agentree-tui (private)_

A terminal-first workspace manager for parallel development across git worktrees.
Built with **Bun + TypeScript + OpenTUI (React renderer)**. A sidebar lists your
projects and their worktrees; each worktree opens a real embedded terminal backed
by tmux, with tabs and pane splitting.

## Current state

Working, at MVP+ level:

- **Sidebar** — projects as foldable groups, worktrees indented under a guide rule
  with status (dirty dot, agent badge, +/− and ahead/behind), keyboard + mouse nav.
- **Add / load worktree** — modal: pick from **every gh-accessible repo**
  (paginated, relevance-ranked filter), clone if missing, `git worktree add`,
  persisted; `＋` on a header or `a` preselects the project.
- **Embedded terminals** — OpenTUI `EmbeddedTerminal` + **Bun native PTY** + tmux
  for persistence. One terminal per worktree; opens on `Enter`.
- **Tabs + pane splitting** — tmux windows (tabs) and panes (splits) composited
  inside the one embedded terminal; app-styled tab/tool bar; keyboard + mouse.
- **Ctrl+C reaches the shell**; app quit via `q` / Ctrl+C while the sidebar is focused.

## Architecture

```
OpenTUI/React UI ─▶ services (gh, git, tmux, proc) ─▶ store.json
                                     │
                                     ▼
                       tmux server on -L agentree socket
                          (one session per worktree;
                           windows = tabs, panes = splits)
                                     │  PTY (Bun.spawn { terminal })
                                     ▼
                       <embedded-terminal> renders the bytes
```

Key decision: **the app renders the terminal** (via `EmbeddedTerminal`); tmux is
only for **persistence** + compositing windows/panes inside that one terminal.
(The brief's "tmux as compositor / no VT engine" idea was dropped once we chose
`EmbeddedTerminal`.)

## File map

- `src/index.tsx` — App shell: state (projects, collapsed, activeIndex, modal,
  open terminal, focusMode), global `useKeyboard`, quit, wiring.
- `src/theme.ts` — dark palette.
- `src/config.ts` — workspace root (`~/agentree`, `AGENTREE_HOME`), state file
  (`~/.config/agentree/state.json`), branch→dir sanitize, `worktreePath`.
- `src/data/model.ts` — `Project`, `Worktree`, `AgentStatus`, `RepoSummary`.
- `src/store.ts` — sync `loadState`, atomic `saveState`, `reconcile()` vs
  `git worktree list` (adopt orphans, mark missing, surface main copy).
- `src/services/proc.ts` — `run()`/`runOrThrow()` over `Bun.spawn`.
- `src/services/hunk.ts` — `isAvailable`, `diffCommand(target, base?)` for the
  hunk diff viewer.
- `src/services/gh.ts` — `fetchRepoPage` (paginated `gh api user/repos`), cache,
  `clone`, `isAuthenticated`.
- `src/services/git.ts` — worktree add/list/status, `localBranchExists`,
  `ignoreWorktreesDir` (adds `.worktrees/` to `.git/info/exclude`).
- `src/services/tmux.ts` — dedicated **`-L agentree`** socket; `attachCommand`
  (status off + global theme), window/pane helpers (list/new/select/next/prev/
  split/killPane), `sessionName`.
- `src/components/` — `Sidebar`, `WorktreeItem`, `AddWorktreeModal`,
  `EmbeddedTerminal` (registration), `TerminalPane`, `TabBar`, `HelpOverlay`,
  `MenuOverlay` (＋ menu / diff picker).
- `src/hooks/useTerminalSession.ts` — Bun PTY lifecycle wired to the emulator.

## Keybindings

- **Sidebar**: `↑↓`/`j k` move · `g`/`G` first/last · `space` or `h`/`l` fold ·
  `Enter` open terminal (worktree) / fold (project) · `a` add worktree to project ·
  `n` add project · `t` cycle theme · `?` help · `q` or `Ctrl+C` quit.
- **Add modal**: type to filter · `↑↓` move · `Enter` select · `Esc` back/cancel · `r` retry.
- **Terminal (focused)**: `Ctrl+g` back to sidebar · `⌥h/⌥j/⌥k/⌥l` (or `⌥←↓↑→`)
  move between **split panes** · `⌥,`/`⌥.` prev/next **tab** · `⌥1`–`9` jump tab ·
  `⌥t` new tab · `⌥d` open diff (hunk) · `⌥w` close pane · `⌥W` close tab ·
  `⌥\` split horizontal · `⌥-` split vertical · `Ctrl+C` → shell ·
  tmux-native `Ctrl+b …` works.
- **Mouse** (everything is clickable): sidebar rows (worktree → open, header →
  select+fold), `＋` add worktree, footer theme + `?` help; the add-worktree modal
  repo/action rows; tab bar (tab, `×` close tab, `＋` menu, `⬌`/`⬍` split, `✕`
  close pane, `‹` back); and
  **click a split pane to focus it** (deterministic: the click maps to
  emulator-local cells matched against `list-panes` geometry → `select-pane`; tmux
  mouse stays off so native text selection still works); click anywhere to close help.

## Theming

`src/theme.ts` is a small registry + observable store: `themes` (`midnight`,
`onedark`), `getTheme`/`setTheme`/`cycleTheme`, and a `useTheme()` hook
(`useSyncExternalStore`) so the whole UI re-renders on change. Every component
reads `const theme = useTheme()`. `t` (or the footer swatch) cycles themes.
Terminals re-theme live: `TerminalView` re-applies tmux `window-style` /
`pane-border-style` globally (`applyTheme`) on theme change. Pane borders carry
the pane `bg` so the divider blends (no seam) — this was the "scuffed borders" fix.

## Diff viewer (hunk)

The tab-bar `＋` opens a small menu (`MenuOverlay`): **New shell** / **New diff
(hunk)**; `⌥d` opens the diff picker directly. The picker offers **Working
changes** / **Staged** / **vs base branch**, and launches `hunk` in a new tmux
window (tab) at the worktree cwd via `newWindowCmd` — `hunk diff` /
`hunk diff --staged` / `hunk diff <base>...HEAD` (`git.baseRef` detects the base,
e.g. `origin/main`). Quitting hunk (`q`) exits the command so the tab closes.
`src/services/hunk.ts` gates on `isAvailable()`; if hunk is absent the picker
shows "hunk not found — npm i -g hunkdiff" (install: `npm i -g hunkdiff` needs
Node 22+, or `curl -fsSL https://hunk.dev/install.sh | sh`). hunk is a separate
process rendering in its tmux pane — no special integration beyond a TTY.

## Help

`?` (or the footer `?`) opens `HelpOverlay` — a top-most overlay listing all
sidebar / terminal / mouse shortcuts + the active theme; `esc` / `?` / click closes.

## Persistence

- `~/.config/agentree/state.json`: `{ version, workspaceRoot, repos[] { nameWithOwner,
  name, root, defaultBranch, worktrees[] { id, branch, name, path, createdAt } } }`.
  Volatile git status is computed at runtime, never persisted. Atomic write.
- tmux sessions on the `-L agentree` socket keep processes alive across app
  restarts. `reconcile()` self-heals state against `git worktree list`.

## Key learnings / gotchas

- **OpenTUI text wraps by default** — truncation needs `wrapMode="none"` + `truncate`.
- **EmbeddedTerminal is a pure VT emulator**: feed PTY output via `.write()`; it
  emits `onData(bytes, "input"|"response")` — forward **both** to the PTY or
  full-screen apps hang. Register via `extend({ "embedded-terminal": … })` +
  `declare module "@opentui/react"` augmentation.
- **Sizing trap**: its constructor pins layout width to `cols` (`width: options.width ?? cols`).
  Don't pass `cols`/`rows`; use `width="100%"` + `flexGrow`. Also the layout-driven
  `onTerminalResize` fires before the child installs SIGWINCH, so re-apply the size
  ~150/500ms after spawn (done in `useTerminalSession`).
- **Bun native PTY**: `Bun.spawn(cmd, { terminal: { cols, rows, name, data, exit } })`
  → `proc.terminal.write/resize/setRawMode/close` (Bun ≥ 1.3.5). No `node-pty`.
- **`useKeyboard` is global** (fires regardless of focus) **and runs before the
  focused renderable**; `key.preventDefault()` + `stopPropagation()` suppress the
  key from the focused terminal — this is how app chords (Ctrl+g, ⌥…) don't leak
  to the shell while keeping the terminal focused (cursor visible).
- **`exitOnCtrlC: false`** so Ctrl+C reaches the shell; the app has its own quit.
- **tmux**: use a **dedicated `-L agentree` socket** (isolation + safe `-g`).
  `window-style`/`window-active-style` are *window* options → must be set **`-g`**
  to theme every tab (not just the first). `next-window`/`previous-window` for
  relative switching; `select-window` for jumps; poll `list-windows` (~1s) for the
  tab bar. Killing the last pane closes the window (tab).
- **gh**: `gh repo list` is owner-only (~38); use `gh api --paginate user/repos`
  for all accessible repos (~548). Load incrementally + cache; rank the filter.

## Deferred / follow-ups

- Multiple-terminal keep-alive for instant worktree switching; restore/list live
  sessions on startup; agent-waiting detection via `screen()` scraping.
- `+/−` diffstat badge (currently 0); layout-restore JSON (reboot survival).
- Tab rename UI (tmux `Ctrl+b ,` works); drag-to-reorder tabs.
- Persistence layer stays on tmux (only JS lib with true persistence needs Node;
  `dtach` is a lighter binary alternative if ever wanted).

## Caveats

- **tmux required** (3.7c installed). If absent, the terminal pane shows an
  install hint. Most of this was verified via headless harnesses (the sandbox has
  no interactive TTY) — worth occasional live passes (`bun run dev`).
- **Incident**: during a test a `tmux kill-server` on the *default* socket killed
  the user's real sessions. Now isolated via `-L agentree`; never `kill-server`
  a shared socket — kill specific sessions only.

## Commit history (this session)

- hunk diff viewer integration (＋ menu · ⌥d · diff picker → hunk in a tab)
- `bf4497e` Add tab (window) deletion; default to One Dark theme
- `51ec2cb` docs: update DEVLOG commit history
- `352a9d8` Theming system, help page, fuller mouse support; fix pane border seam
- `6270273` Click a split pane to select it (deterministic coord→pane mapping)
- `446f176` Add split-pane navigation; remap tab/pane keys
- `f042dec` Fix tab theming + add keyboard tab switching
- `a36490e` Ctrl+C reaches the shell; add app quit (Ctrl+C / q in sidebar)
- `a6c0cc1` Add terminal tabs and pane splitting (tmux windows/panes)
- `f9099fa` Fix terminal sizing, add sidebar mouse nav + return, theme terminals
- `4946b14` Add embedded terminals (OpenTUI EmbeddedTerminal + Bun PTY + tmux)
- `b25380f` Paginate repo picker incrementally and rank by relevance
- `a5a284e` Add per-project "add worktree" via ＋ button and `a` key
- `58caa04` List all repos the gh token can access
- `c6edc61` Add worktree sidebar and gh-backed add/load flow
- `cdfd3fa` Initial commit from create-tui
