# agentree-tui — Dev Log & State

_Last updated: 2026-09-25 · Repo: github.com/BeerHobbyist/agentree-tui (private)_

A terminal-first workspace manager for parallel development across git worktrees.
Built with **Bun + TypeScript + OpenTUI (React renderer)**. A sidebar lists your
projects and their worktrees; each worktree opens a real embedded terminal backed
by tmux, with tabs and pane splitting.

## Current state

Working, at MVP+ level:

- **Sidebar** — projects as foldable groups; each worktree one line: the
  **agent status** glyph (◆ needs you · ⠹ working · ✓ done · ○ idle —
  animated: working spins, needs-action pulses), name, an uncommitted-changes
  count (`●3`) and PR badge via `gh` (`⇡#N` coloured by CI, `⇡#N◌` a draft,
  `✓#N` once merged, until the worktree is closed). The selected one opens a
  second line: its branch (when it isn't the name), +/− and ahead/behind.
  Scrolls when it's taller than the screen, keeping the selection in view;
  keyboard + mouse nav, and clicking it gives it the keyboard. **Resizable**
  (drag its edge or `[` / `]`), width remembered; **hideable** (`b` or its
  footer's `«`; back with `b`, Ctrl+g or the tab bar's `‹`). Worktrees can be
  **renamed** (`R` / right-click): a label shown instead of the branch's leaf
  name — the branch and directory keep their names. The footer is one row:
  agent counts, then `◑` theme, `?` help, `«` hide.
- **Agents** — status for the agents agentree starts, and (with `H`, which adds
  its hooks to Claude's user settings) for any claude started in its terminals,
  on SSH hosts too. A desktop notification when one needs you or finishes while
  you're elsewhere; `Tab` / `⌥n` / a footer count jump to it.
- **PR panel** — on the right, for the worktree on screen when it has a PR
  (open, or merged): merge status, reviews, checks, labels, description and
  comments; `p` / ⌥p toggles, `o` opens on GitHub, `r` refreshes, **`m`
  merges** (pick a method the repo allows, then confirm; a blocked PR can be
  set to auto-merge). Once merged, **closing the worktree** is one key: `d`
  (the badge says `✓#N`), the panel's `Close worktree…`, or `d` on the
  merge dialog's done screen. Sections fold (click their title), remembered.
- **Add / load worktree** — modal: pick from **every gh-accessible repo**
  (paginated, relevance-ranked filter), clone if missing, `git worktree add`,
  persisted; `+` on a header or `a` preselects the project. The repo's open
  PRs are listed alongside existing worktrees as one-key picks, fetched via
  `refs/pull/<n>/head` (works for forks) and named after the PR's branch.
- **SSH projects** — `s` adds a host (typed, or from `~/.ssh/config`) and a
  directory on it; `+`/`a` add more directories. Their terminals run on the
  host, in tmux there. Key or password login (asked for, never stored); only
  `ssh` is needed locally. Remote shells only: no git status, PRs or diff.
- **Embedded terminals** — OpenTUI `EmbeddedTerminal` + **Bun native PTY** + tmux
  for persistence. One terminal per worktree, kept mounted once opened so
  switching back is instant. A click on a worktree shows its terminal and leaves
  the keyboard in the sidebar; `Enter` or a double-click types in it. Programs
  inside get the mouse (click, drag-select, scroll in nvim/pagers) and your
  terminal's own blinking cursor.
- **Tabs + pane splitting** — tmux windows (tabs) and panes (splits) composited
  inside the one embedded terminal; app-styled tab/tool bar; keyboard + mouse.
  Tabs can be **renamed** (`⌥r` / right-click; empty = tmux names it after its
  program again).
- **Diffs** — `⌥d` opens working changes / staged / vs base / a ref in a tab of
  its own, in hunk, diffnav, delta, difftastic, nvim diffview or plain git
  (`v` in the picker switches; the first installed by default).
- **Agent CLI** — `agentree tab new|read|send|…`, `diff`, `notify`, `status`,
  on PATH in every agentree terminal, so agents can run dev servers in their
  own tabs and read them; claude is told about it on start, and a Claude Code
  skill (`agentree skill install`) covers when and how.
- **Ctrl+C reaches the shell**; app quit via `q` / Ctrl+C while the sidebar is focused.
- **OpenCode-style UI** — `ctrl+p` opens a **command palette** (every action
  that applies, grouped, searchable, each with its key); pop-ups are borderless
  **dialogs** over a dimmed screen; results and failures show as **toasts**
  (top right, gone after a few seconds); hints show keys bright and
  descriptions muted; three themes (One Dark, Midnight, OpenCode — `t`).
- **Docs and CI** — an OSS-style README with screenshots of the real app
  (`bun scripts/screenshots.tsx` regenerates them); CI lints and checks
  formatting (Biome), tests on Linux and macOS with a coverage minimum, and
  checks PR titles (see **Quality checks**).

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

**Data layer: TanStack Query.** Everything the app reads — PR details and
badges, git status, agent status, the modal's repo list and open PRs, tmux
windows, whether tmux is installed and which diff viewers are — is a query defined in
`src/queries.ts` (key, fetcher, stale time, poll interval), cached in one
`QueryClient` per app (`src/queryClient.ts`: fresh 30s, dropped 10 min after
nothing shows it, one retry). Coming back to something already loaded shows it
at once; stale data refreshes in the background; a failed refresh keeps the last
good answer. Events invalidate keys instead of kicking loops (an agent changing
state → git status + PR lookups; a PR badge changing → that PR's details; a tmux
action → that session's windows). Imperative actions (clone, create worktree,
kill session) stay plain calls.

The terminal window's focus is the cache's "window focus" (`bindTerminalFocus`):
OpenTUI turns on focus reporting (DEC mode 1004) when the terminal says it
supports it and emits `focus` / `blur`. Coming back to the terminal refreshes
anything stale; GitHub polling pauses while it isn't focused; local polling
(agent status, git status, tmux tabs) keeps going, since agentree may be on
screen without keyboard focus. Terminals without focus reporting never blur,
so nothing changes for them.

Agent status runs beside this: agents agentree starts load Claude Code hooks
(`--settings`) that write one-line reports under `~/.config/agentree/agents/`;
the app polls those and cross-checks tmux (see **Agent status**).

## File map

- `src/index.tsx` — entry point: a CLI command (`src/cli.ts`), or the app
  (`src/tui.tsx`: load state, reconcile, mount `App`).
- `src/app.tsx` — the app shell: selection, folding, which terminals are open
  and on screen, focus; the worktree actions (open, close, forget, rename,
  merge, jump); the sidebar's keys (a table, `sidebarKeys`, looked up by
  `keyIds`); layout. Leans on `src/app/`:
  - `live.ts` — `useLive`: state whose ref the key handler reads, written at
    once (a key burst arrives before React re-renders).
  - `overlays.tsx` — every pop-up as one stack (`useOverlays`, `OverlayLayer`):
    the top one is on screen and owns the keys.
  - `usePrefs.ts` — remembered layout (sidebar, PR panel, diff viewer).
  - `useAgents.ts` — agent reports (local + SSH), tracking, seen, notifications.
  - `useLiveProjects.ts` — git status and PR badges merged into the projects.
  - `toasts.tsx` — `useToasts` and `ToastLayer`.
- `src/theme.ts` — the palettes (`onedark`, `midnight`, `opencode`), `mix`.
- `src/anim.ts` — the animation clock (`useTick`), spinner and pulse frames.
- `src/config.ts` — workspace root (`~/agentree`, `AGENTREE_HOME`), state file
  (`~/.config/agentree/state.json`), branch→dir sanitize, `worktreePath`,
  `agentCommand` (startup command, `AGENTREE_AGENT_CMD`).
- `src/data/model.ts` — `Project`, `Worktree`, `AgentStatus`, `RepoSummary`.
- `src/store.ts` — sync `loadState`, atomic `saveState`, `reconcile()` vs
  `git worktree list` (adopt orphans, mark missing, surface main copy).
- `src/services/proc.ts` — `run()`/`runOrThrow()` over `Bun.spawn`.
- `src/services/diff.ts` — diff viewers (hunk, diffnav, delta, difftastic, lumen,
  nvim diffview, git): which are installed, and `diffCommand(viewer, target, arg?)`.
- `src/services/gh.ts` — `fetchRepoPage` (paginated `gh api user/repos`), cache,
  `clone`, `isAuthenticated`, `prForBranch` (a branch's PR: open, else merged
  from this branch; cached).
- `src/services/git.ts` — worktree add/list/status, `localBranchExists`,
  `ignoreWorktreesDir` (adds `.worktrees/` to `.git/info/exclude`),
  `canonicalPath` (symlinks resolved, for comparing with git's paths).
- `src/services/tmux.ts` — dedicated **`-L agentree`** socket; `attachCommand`
  (pre-attach cursor override, status off + global theme, `mouse on`, optional
  startup command and session `env`), window/pane helpers
  (list/new/select/next/prev/split/killPane), `listPaneActivity`, `sessionName`.
- `src/services/broker.ts` — the tmux broker for sandboxed agents: the app's
  socket (`startBroker`), the CLI's client (`brokerTmux`), `sandboxArgv`.
- `src/services/agents.ts` — agent status: the Claude hooks settings file,
  `agentLaunchCommand`, reading and correcting per-pane reports (`readAgentStatuses`).
- `src/queries.ts` — every query (keys, fetchers, timings); `src/queryClient.ts`
  — the cache and its defaults.
- `src/services/limit.ts` — `createLimiter(n)`: at most 4 `gh`/`git` processes at once.
- `src/services/pr.ts` — PR details for the panel (`fetchPrDetails`: `gh pr view
  --json` + the REST inline-comments endpoint) and pure normalizers
  (`checkState`, `summarizeChecks`, `mergeStatus`, `relativeTime`, …).
- `src/services/open.ts` — `openExternal(url)`; `AGENTREE_OPEN_CMD` overrides the
  opener (tests use a fake that records).
- `src/layout.ts` — sidebar width rules (`clampSidebarWidth`, min/default/step)
  and `fitPanels` (sidebar + PR panel around the content pane).
- `src/components/` — `Dialog` (every pop-up's frame) + `rowLook`, `Hints`,
  `CommandPalette`, `Sidebar`, `WorktreeItem` (+ `AgentGlyph`), `ResizeHandle` (sidebar / PR
  panel divider), `PrPanel`, `AddWorktreeModal`, `ConfirmModal`, `EmbeddedTerminal` (registers a
  `StableCursorEmbeddedTerminal` subclass — see **Terminal fidelity**),
  `TerminalPane`, `TabBar`, `HelpOverlay`, `MenuOverlay` (+ menu / diff picker).
- `src/hooks/useTerminalSession.ts` — Bun PTY lifecycle wired to the emulator.
- `scripts/` — `check-coverage.ts` (CI's coverage minimum), `screenshots.tsx`
  and `record.tsx` (README screenshots, demo recordings; see **Quality
  checks**), `lib/` (the camera and the sample workspace they share).

## Keybindings

- **Sidebar**: `↑↓`/`j k` move · `g`/`G` first/last · `space` or `h`/`l` fold ·
  `Enter` open terminal (worktree) / fold (project) · `a` add worktree to project ·
  `R` rename worktree (label only) · `d` close (delete) worktree · `n` add
  project · `s` add SSH host · `Tab` next agent that needs you · `H` track
  every claude · `[`/`]` narrower/wider sidebar · `=` reset
  width · `b` hide/show sidebar · `p` PR panel ·
  `o` open PR · `r` refresh PR · `m` merge PR · PgUp/PgDn scroll PR panel · `t` cycle theme ·
  `?` help · `q` or `Ctrl+C` quit.
- **Add modal**: type to filter · `↑↓` move · `Enter` select · `Esc` back/cancel · `r` retry.
- **Terminal (focused)**: `Ctrl+g` (or a click on the sidebar) back to sidebar,
  showing it if hidden ·
  `⌥h/⌥j/⌥k/⌥l` (or `⌥←↓↑→`) move between **split panes** · `⌥,`/`⌥.` prev/next
  **tab** · `⌥1`–`9` jump tab · `⌥t` new tab · `⌥r` rename tab · `⌥a` open
  agent (new tab) · `⌥d` open a diff (`v` there: viewer) · `⌥p` PR panel · `⌥w` close pane ·
  `⌥W` close tab · `⌥\` split horizontal · `⌥-` split vertical · `⌥n` next
  agent that needs you · `Ctrl+C` →
  shell · tmux-native `Ctrl+b …` works.
- **Mouse** (everything is clickable): focus follows the click — anywhere on the
  sidebar gives it the keyboard, inside a terminal gives that terminal the
  keyboard. Sidebar rows: worktree → select and show its terminal (keys stay in
  the sidebar), double-click (400ms) → type in it, right-click → rename; header →
  select+fold. `+` add worktree; footer `◑` theme, `?` help, `«` hide; **drag
  the sidebar's right edge** to resize (double-click resets); the add-worktree
  modal repo/action rows; tab bar (tab, right-click → rename, `×` close the lit
  tab, `+` menu, `◫`/`⊟` split, `✕` close pane, `‹` back). Inside a terminal
  tmux has `mouse on`: clicks, drags
  and the wheel reach the program (nvim, pagers), and clicking a split pane
  selects it (this replaced the old coordinate → `list-panes` hit-testing).
  Click anywhere to close help.

## Theming

`src/theme.ts` is a small registry + observable store: `themes` (`onedark`,
`midnight`, `opencode` — OpenCode's default palette), `getTheme`/`setTheme`/
`cycleTheme`, `mix(a, b, t)` for blending two colours, and a `useTheme()` hook
(`useSyncExternalStore`) so the whole UI re-renders on change. Every component
reads `const theme = useTheme()`. `t` (or the footer's `◑`, or the palette)
cycles themes, and a toast names the new one (`◑ midnight`) — the footer has
no room for it.
Terminals re-theme live: `TerminalView` re-applies tmux `window-style` /
`pane-border-style` globally (`applyTheme`) on theme change. Pane borders carry
the pane `bg` so the divider blends (no seam) — this was the "scuffed borders" fix.

## Diff viewers

The tab-bar `+` opens a small menu (`MenuOverlay`): **New shell** / **New
agent** / **New diff**; `⌥d` opens the diff picker directly: **Working
changes** / **Staged** / **vs base branch** (`git.baseRef` finds it, e.g.
`origin/main`) / **Specific ref / commit…**. Each is a set of `git diff`
arguments (`diffArgs`), which the chosen viewer turns into a command that runs
in a new tmux tab at the worktree (`src/services/diff.ts`); quitting the
viewer closes the tab.

Viewers (`DIFF_VIEWERS`): **hunk** (`hunk diff …`), **diffnav** (`git diff |
diffnav` — a file tree beside delta's rendering), **delta** (side by side,
`--navigate`), **difftastic** (`diff.external=difft`), **lumen** (`lumen
diff …`; staged changes open in plain git, as it has no flag for them), **nvim diffview**
(`DiffviewOpen …`; only when chosen — the plugin can't be detected) and plain
**git diff**, which is always there. The picker's title names the one in use:
the one picked with `v` in the picker (cycles through the installed ones,
remembered as `ui.diffViewer`), else the first installed of hunk, diffnav,
delta, difftastic, lumen — else git. "Installed" is `Bun.which` on each program the
viewer needs (diffnav needs delta too); `AGENTREE_DIFF_VIEWERS` overrides the
list (tests).

Gotchas, found running them for real:
- **The tab closes when the viewer exits**, so a pager mustn't quit on a short
  diff: git's default `LESS=FRX` has `-F` (quit if one screen). Git-paged
  viewers get `LESS=R` and delta `--paging=always`.
- **The user's own `core.pager` can't be trusted** — here it was delta, which
  made "plain git" auto-page (and quit) and would mangle difftastic's output.
  The git-based viewers set `-c core.pager=…` themselves.
- **An empty diff** would make any viewer exit at once (the tab just flashes):
  `git diff --quiet <args>` first, and if it's empty the tab says "No changes
  to show" and waits for Enter.
- tmux runs a window's command with the user's login shell (zsh, fish…), so
  the whole thing is wrapped in `sh -c`.
- No diff viewer for SSH directories (no git there).

## Startup agent

A worktree's terminal runs `agentCommand()` (`src/config.ts`) instead of a
plain shell the first time its tmux session is created: `claude`, or
`caffeinate -is claude` on macOS so it survives sleep/lid-close. Override with
`AGENTREE_AGENT_CMD`. This rides `tmux new-session -A`'s `shell-command` arg —
it only runs on session creation, so re-opening an already-open worktree just
re-attaches to the running shell/agent instead of relaunching it
(`attachCommand`'s new `startupCommand` param, `src/services/tmux.ts`).
The + menu / `⌥a` (`openAgent` in `TerminalPane.tsx`) opens the same command
in a fresh tab, the same way `⌥d` opens a diff.

## Agent status

The sidebar shows what each worktree's agent is doing — ◆ needs action,
◐ working, ✓ done (finished while you weren't looking; clears once you view
that worktree), ○ idle — from `src/services/agents.ts`:

- Agents started by agentree run as `claude --settings
  ~/.config/agentree/claude-hooks.json` (`agentLaunchCommand`). That file only
  adds Claude Code hooks (`SessionStart` → idle, `UserPromptSubmit` /
  `Pre`/`PostToolUse` → working, blocking `Notification`s → needs action,
  `Stop` → done, `SessionEnd` → gone). Each hook overwrites
  `~/.config/agentree/agents/<session>.<pane>` with `<state> <epoch>`, using
  `AGENTREE_AGENT_DIR` / `AGENTREE_SESSION` that the tmux session provides
  (`attachCommand`'s `env`) plus tmux's own `$TMUX_PANE`. Nothing is written
  inside worktrees, and the hooks print nothing (Claude would read it).
- The app polls those files every second and cross-checks tmux
  (`listPaneActivity`): reports from dead panes are deleted; a "working" agent
  silent for 10s was interrupted (Esc fires no hook); a "needs action" agent
  that prints again was answered.
- `AGENTREE_AGENT_CMD` overrides still get the hooks if they run `claude` (and
  don't pass it their own `--settings` — a wrapper's before it, like `fence
  --settings …`, doesn't count); other agents run untouched and show no
  status. Claude only sends the permission notification after ~6s, so
  "needs action" can lag a fresh prompt by that much.
- **Tracking every claude** (`H`, asks first): a `claude` typed by hand doesn't
  get `--settings`, so agentree can put the same hooks in Claude's *user*
  settings (`$CLAUDE_CONFIG_DIR` or `~/.claude/settings.json`), where any
  claude loads them. They already do nothing outside an agentree session (no
  `AGENTREE_*` in the environment). `withGlobalHooks` merges them in — other
  hooks and keys untouched, idempotent — and takes out only its own (any hook
  command mentioning `AGENTREE_AGENT_DIR`); a settings file that isn't valid
  JSON is left alone. A `claude` shim on the session's PATH was the other
  option, but shell rc files commonly put `~/.local/bin` (where Claude's own
  installer puts it) in front of it.
- **SSH hosts**: their terminals' sessions get `AGENTREE_AGENT_DIR` under the
  host's home (`remoteSessionEnv`), and with tracking on, the host's Claude
  settings get the hooks too (read over ssh, merged here, written back via
  stdin) once one of its terminals is open. `readRemoteAgentStatuses` reads
  the host's status files and its tmux panes in one ssh call, every 2s, for
  hosts with a terminal open — a password host only while connected — and
  combines them like local ones (`statusesFrom`, shared); stale files are
  deleted on the host.
- **Telling you**: when an agent turns "needs action" or "done" and you're not
  looking at it (its terminal on screen in a focused window — TanStack's
  focusManager, i.e. terminal focus reporting), a desktop notification
  (`services/notify.ts`: osascript on macOS, notify-send on Linux,
  `AGENTREE_NOTIFY_CMD` for your own, `AGENTREE_NOTIFY=off` to stop). Only for
  changes whose report is newer than agentree's start — an old "done" found at
  startup, or on a host opened later, isn't news.
- **Going to it**: `Tab` (sidebar), `⌥n` (terminal), or clicking a footer
  count opens the next worktree whose agent needs you (then: is done), after
  the one on screen in sidebar order, unfolding its project; its terminal gets
  the keys.

Uncommitted changes are separate: `●3` on a worktree's branch line (files
with changes, untracked included), refreshed every 5s and whenever an agent
changes state — it used to be computed once at startup.

## Terminal fidelity

What a program inside a worktree terminal sees should match a plain terminal.
Most of this lives in `src/components/EmbeddedTerminal.tsx` (a subclass of
OpenTUI's `EmbeddedTerminalRenderable`); root causes and before/after evidence
are in `docs/terminal-rendering-glitches.md`.

- **Mouse** — tmux `mouse on` (`behaviorOptions`), so tmux asks the emulator for
  mouse and relays it to the focused pane. The pane's own handler goes on
  `onMouse`, never `onMouseDown`: `EmbeddedTerminal` forwards mouse to the child
  from its per-type slots, and the React reconciler assigns a passed
  `onMouseDown` straight into that slot, silently dropping the forwarding.
- **No selection overlay** — `selectable={false}`, so a drag reaches the program
  instead of OpenTUI painting its own cell selection over the grid (issue #21).
- **Stable cursor** — the base `renderSelf` mirrors the child's cursor onto the
  host cursor on every frame, and a frame is drawn per PTY chunk, so mid-redraw
  positions (nvim parks at column 0) and Claude's spinner made it flash and jump
  (issue #22). The subclass freezes the host cursor while output streams and
  asserts the settled, deduped cursor once it's been quiet for 20ms.
  `AGENTREE_CURSOR_SMOOTH=off` restores stock behaviour for comparison.
- **Native blinking cursor** — the emulator reports a steady block when the
  child never asked for a shape, which pinned the real cursor to steady. The
  subclass reads the child's DECSCUSR from the byte stream and asks the host for
  its own default (`ESC[0 q`) until the child requests a shape; explicit shapes
  (nvim's modes) pass through. tmux's terminfo `Se` resets to `\E[2 q` (steady),
  so an indexed `terminal-overrides[90]` sets `Se=\E[0 q` before `new-session`
  (`preAttachOptions`).
- **Switching worktrees doesn't flash** — every opened worktree keeps its
  terminal mounted (hidden with `display:none`) instead of re-attaching tmux,
  which always clears and redraws.
- **Orphan releases** — the terminal drops a mouse release whose press started
  elsewhere (e.g. letting go of the sidebar divider over it).

## SSH projects

A host and directories on it, opened as terminals there — remote shells, no git
features. Project id `ssh:<host>`; `state.hosts[]` holds the host, its `$HOME`
(to show paths as `~/…`) and each directory's absolute path.

- **Adding** (`SshModal`, `s`; `+`/`a` on the host skip to the directory):
  `probeRemoteDir` connects once in batch mode, `cd`s into the directory
  (`~` → `"$HOME"`), prints its absolute path and `$HOME`, and checks tmux is
  there. Missing directory, no tmux, or an unknown host key → says why;
  nothing is saved. "Permission denied" → it asks for the password (see below).
- **Terminals**: `attachCommand(…, host)` → `ssh -t -- host 'exec sh -c …'`
  running the same tmux command list as locally, on the same socket name
  there. A remote session starts a plain shell (the agent's status hooks are a
  file on this machine); ⌥a runs plain `claude` there; the diff viewer is
  hidden (it needs local git). Only `ssh` is needed locally: the "tmux not
  found" check applies to local terminals only, so a Mac without tmux can
  still use SSH projects.
- **tmux over ssh**: `tmuxOn(host)` gives the tab bar's window/pane commands
  run as `ssh host tmux -u -L <socket> …`. Every ssh call shares one master
  connection per host (`ControlMaster=auto`, `ControlPersist=10m`), so polling
  the tabs each second costs ~10ms, not a handshake.
- **Removing** (`d`): a directory, or the whole host from its header. Ends
  their tmux sessions on the host; never touches files.
- **Git status and PR lookups skip SSH projects** (they'd run local git/gh on a
  remote path).
- **Password logins**: when the batch check is refused, `SshModal` asks for
  the password (or key passphrase — ssh asks for either the same way), masked.
  `probeRemoteDir(…, { password })` logs in with `SSH_ASKPASS` pointing at a
  helper and `SSH_ASKPASS_REQUIRE=force` (so ssh never prompts on agentree's
  own terminal); the password travels only in that ssh's environment, and the
  helper (no secret in it) answers only password/passphrase prompts — a
  host-key question or a one-time code gets refused, not the password. That
  login becomes the host's shared connection, which everything after reuses;
  the host is saved with `needsPassword`, the password never. After it expires
  (agentree closed for 10 min), opening a terminal shows ssh's own prompt
  there, and typing it opens the connection again.
  For such a host, **background calls never log in**: `tmuxOn(host,
  { onlyIfConnected })` checks `ssh -O check` (local) first — otherwise the tab
  bar's poll would be a failed login every second, which gets you banned
  (fail2ban, MaxAuthTries). The trade-off: `d` can't end its remote sessions
  while it isn't connected.

Checked against a real sshd (a throwaway one on 127.0.0.1, login shell zsh):
probing, a path with a space, the session starting in it, renames with quotes,
the shared connection. That's where these came from:
- ssh caps `ControlPath` at 104–108 bytes (`%C` alone is 40): the socket goes
  in `$XDG_RUNTIME_DIR`, else next to state.json, else a private `/tmp` dir —
  whichever is short enough — or ssh goes unshared.
- An ssh session often has no UTF-8 locale; tmux then prints non-ASCII *and
  tabs* as `_` (the tab bar's `-F` output broke). Remote tmux always gets `-u`.
- sshd runs the command through the user's login shell (zsh, fish…): commands
  are wrapped in `sh -c '…'` to mean the same everywhere.

Tests use a fake `ssh` whose every host is this machine (`test/helpers/fakebin/
ssh`: skips options, `sh -c`s the command with `HOME=$FAKE_SSH_HOME`), so the
"remote" tmux is the test's own server. It can also play a password host
(refuses batch mode, answers SSH_ASKPASS or a prompt on the tty, keeps a
"connection" file for `-O check`, logs every login attempt). The password path
was also run against the real sshd with a passphrase-protected key (a user-run
sshd can't check real passwords): askpass login, reuse, and the terminal's own
prompt.

## Resizable sidebar

Drag the divider on the sidebar's right edge (`ResizeHandle`), or use `[` / `]`
(4 columns) and `=` to reset; double-clicking the divider resets too. The width
is clamped by `clampSidebarWidth` (`src/layout.ts`: minimum 28 so the status row
fits, and the content pane always keeps 30), re-clamped when the window resizes
without losing the chosen width, and saved as `ui.sidebarWidth` in state.json
(omitted at the default). The divider captures the pointer on mouse-down:
OpenTUI only captures on the first drag event, by which time the pointer is
usually over the terminal, which would take the drag and hand it to nvim.

**Hiding it**: `b`, or the `«` at the end of its footer, gives the content the
whole width; with a terminal on screen, the
keys go to it. Anything that goes back to the sidebar shows it again — `b`,
Ctrl+g, the tab bar's `‹` — so there's no separate "show" to learn. Remembered
(`ui.sidebarHidden`); with nothing open, the placeholder says `b` shows it.
`fitPanels(…, sidebarHidden)` gives it 0 columns, so the PR panel can use them.

**Layout** (#59; #50's spaced two-line cards, header bands and project paths
read as clutter): a project header is `▾ name … +` (a folded one adds its most
urgent agent glyph, `●` if anything's dirty, and its worktree count); a blank
line between projects; under it, its worktrees one line each (`WorktreeItem`)
— status glyph aligned under the project's name, the name (muted unless
selected), `●N`, the PR badge (`prBadge`, shared with the tab bar). The status
words went: the glyph says it, and `?`'s Icons section is the legend. Only
the selected row grows a second line, and only when there's something for it
— the branch when it isn't the name (so not `main`), +/−, ahead/behind. The
list is a `scrollbox`: every row has an id (`sidebar-row:<key>`) and
`scrollChildIntoView` follows the selection — after layout, too (see **Key
learnings**); the footer is `flexShrink={0}` or the list squeezes it to one
row. The footer is one row — agent counts (each clickable), then `◑ ? «` — and
its line of hints for the selected row (`footerHint`) is gone: the palette
(`^p`) and `?` cover them, and the empty pane still says what to do next.

## PR panel

`src/components/PrPanel.tsx`, on the right of the content pane, for the
worktree on screen (the open terminal's, else the selected row's) when it has
an open PR. Sections: header (number, state, title — click to open —,
author, `base ← head`, +/−, files), **Merge** (`mergeStatus`:
ready, conflicts, behind, blocked and why, draft, merged/closed), **Reviews**
(decision as a glyph in its title, each reviewer's latest verdict as a glyph —
✓ approved, ✗ changes requested, ◌ requested, ● commented, – dismissed —
pending requests), **Checks**
(counts; each check failing-first, click to open its log), **Labels**,
**Description**, **Comments** (conversation, review summaries and inline code
comments with `file:line`, newest first; click to open). The footer says how
fresh it is (`↻ just now`, `↻ refreshing…`, `↻ failed`), then `m merge · o
open` — `r refresh` left it, since it no longer fit the default width.
Details are cached per PR (TanStack Query): switching back to a PR seen in the last 30s fetches nothing;
after that the cached copy shows at once while it refreshes. It re-fetches every
30s while on screen and on `r`; the sections scroll (wheel, PgUp/PgDn). Toggle with `p` / ⌥p /
its ✕ / the tab bar's `⇡#N` button; drag its left edge to resize. Both are
remembered (`ui.prPanelHidden`, `ui.prPanelWidth`). `fitPanels` narrows the
sidebar to make room and hides the panel on a screen too narrow for it.

Layout: the header is ruled off from the sections, and the footer from them
too. Each section's title is a bold line with a fold glyph (`▾ Reviews ✓`; it
used to sit on a `panelAlt` band, #59 dropped those); **clicking it folds the
section** down to that line, which keeps its summary
(check counts, review verdict, comment count; the merge status and labels
appear there once folded). Folded sections apply to every PR and are
remembered (`ui.prPanelCollapsed`). Comments and the description are set off
by a rule on their left (`Quote`). Bodies are indented two columns, under the
title (the panel is often ~34 columns wide, so no more).

**Merging** (`m`, or the panel's `Merge…` button): `MergeModal` offers the methods
the repo allows (`gh api repos/{repo}` → `allow_*_merge`; GitHub leaves those
out without push access, and then all three are offered and GitHub decides) —
the one used last first (`ui.mergeMethod`). `mergeOptions` decides: ready,
unstable or unknown → merge now; blocked or behind → "when ready" (`--auto`) if
the repo allows auto-merge; conflicts, drafts and finished PRs → says why.
Nothing runs before a separate confirm step. `gh pr merge -R … --<method>
--match-head-commit <sha>`: pinned to the head commit on screen, so a push you
haven't seen fails the merge instead of riding along. Never `--delete-branch` —
the worktree still has the branch checked out, and the repo's own "delete head
branch" setting handles the remote. Afterwards the PR's details and every
branch's PR lookup are invalidated, so the badge turns to `✓#N` — and the
done screen offers `d` to close the worktree (the usual confirm follows).

The sidebar's PR lookup (`prForBranch`) also asks for `statusCheckRollup` to
colour the `⇡#N` badge, and is re-run every 60s, when an agent changes state
(throttled), and on `r`. A failed lookup throws (it used to answer "no PR"), so
the cache keeps the last good badge through a network hiccup.

It asks for every state (`--state all`): an open PR wins; with none, a
**merged** one shows (`✓#N`, purple; the panel says Merged and offers
`Close worktree…`) — but only if it was this branch's. `--head` matches a
branch *name*, so an older branch's PR with the same name, or a fork's `main`
merged into ours, would otherwise turn up. Its commits must be the worktree's
(HEAD is its head or one of its commits — commits pushed on GitHub and never
pulled — or HEAD is past its head) and the merge's commit must not be in the
branch yet (it is in main, and in any branch started from main after). A
`git rev-parse` and up to two `merge-base --is-ancestor`, only when no PR is
open. Closed-unmerged PRs don't show. `d` on the panel is only labelled while
the PR's worktree is the selected row — `d` closes the selected row, and the
panel follows the worktree on screen.

## Agent CLI (`agentree <command>`)

So the agents in its terminals can drive their tabs: `src/cli.ts`, reached
through the same binary (`src/index.tsx` dispatches — commands never load the
UI, which moved to `src/tui.tsx`). Inside an agentree terminal the session is
known (`$AGENTREE_SESSION`), so commands act on that worktree; `--session`
names another. Tabs are tmux windows, so the app's tab bar follows.

- `tab list|new|read|send|select|rename|close`, `diff`, `notify`, `status`,
  `skill`; `--json` on `tab list` / `status`. `tab new` opens a shell tab in the
  background (`-d`; `--select` to switch) and types the command into it, so the
  tab outlives the command and its output stays readable (`tab read` =
  `capture-pane -J`). It refuses a name already in use (a second "dev" would be
  a second dev server), and `tab close` refuses the last tab (it would take the
  session, and the app's terminal, with it).
- **Reaching it**: agentree writes a launcher (`~/.config/agentree/bin/
  agentree`: the binary, or `bun src/index.tsx` in development) and puts its
  directory on *its own* PATH — tmux gives a new window the PATH of the client
  that creates it (agentree's own tmux clients), not the session's `-e PATH`.
  Sessions also get `$AGENTREE_CLI`.
- **Telling agents**: a SessionStart hook prints a short note about the CLI
  (SessionStart output becomes context) — only in an agentree terminal, and
  only where the CLI is (`$AGENTREE_CLI`), so not on SSH hosts. It rides along
  with the status hooks, in `--settings` and, with tracking on, in the user
  settings.
- **The skill**: `skills/agentree/SKILL.md` — when to use the CLI (anything
  that doesn't finish by itself), the dev-server workflow, and etiquette (don't
  steal the user's view, name and close your tabs, notify sparingly). Bundled
  into the binary; `agentree skill install` copies it to Claude's skills
  (`$CLAUDE_CONFIG_DIR` or `~/.claude/skills/agentree/`), `uninstall` removes it.

## Sandbox broker (fence)

tmux runs every command it's given outside any sandbox, so a sandbox (fence)
allowed onto agentree's tmux socket isn't one: `tmux new-window 'anything'`
runs unsandboxed. Instead of tmux's socket, the sandbox is allowed the app's —
`<tmux dir>/<socket>.broker`, beside tmux's own, where `startTui` listens
(`src/services/broker.ts`; one per tmux server, the first app to start). Inside
fence (`$FENCE_SANDBOX`) the CLI sends its tmux calls there: one JSON line per
connection, the calls the CLI makes and nothing else (`OPS`), each argument
type-checked. It carries them out on the sandbox's terms:

- **What it starts runs in the sandbox**: `AGENTREE_SANDBOX_CMD`, a command
  prefix (read by `/bin/sh`), in front of the tab's shell, a `diff`'s viewer, a
  `--worktree` session's first shell. The pane starts at the session's
  directory — fence's "." — and `--cwd` is only `cd`'d to inside, so it can't
  widen the sandbox. A session's directory comes from state, not the request.
  With no `AGENTREE_SANDBOX_CMD`, nothing is started.
- **Typing only into those panes**: `tab send` into the user's shell would run
  the text outside. The broker marks each pane it starts (`@agentree-sandboxed`,
  a pane option: a split off such a tab is the user's plain shell, and only
  something outside the sandbox can set a tmux option) and types only into a
  marked one, resolved to its pane id first. `send-keys` gets a `--` before
  the keys, so `-X copy-pipe …` or `-K` can't make tmux run anything.
- **No `#` where tmux reads a format** — a session, target, tab name or
  directory (`-n`, `rename-window`, `-c` all expand formats): `#(…)` in one
  would have tmux's server run it. A `--worktree` session's directory must
  also be a checkout (`.git`).
- **No argument ending in `;`**: tmux ends a command there, and would run
  what follows (a `--key ';' --key run-shell …`) as one of its own.
- Listing, reading, selecting, renaming and closing tabs work on any tab.

`agentree status` inside fence can't see the panes: a socket the sandbox
blocks reads as unknown (`listPaneActivity` → null), not as no server — which
would call every agent's report stale and delete it.

It lives in the app, so a sandboxed agent's tabs need agentree open. The
socket sits in tmux's directory, which the sandbox can write to: an agent
could replace it with its own, fooling only other sandboxed agents.

## Hints

Key hints stay short — and styled as in OpenCode: each key bright, what it
does muted (`Hints`, from pairs, or `hintsFrom("↑↓ choose · y / ⏎ confirm")`).
Every action is in the command palette (`ctrl+p`), every key in the help
overlay (`?`). The tab bar shows only a faint `^g` (the way back — it used to
list ten ⌥ chords, which pushed the tabs and even the `+` button out of view;
then `^g sidebar`, until #59 cut the word). The sidebar footer had a hint line
for the selected row (`footerHint`: `⏎ open · d close · ^p commands`, …) —
#59 dropped it for icons only; the empty pane (a row selected, no terminal
open) still says what to do next, the same way.

Controls are icons, not words (#59): the sidebar footer's `◑ ? «`, `+` on a
project and in the tab bar (`+`, not the double-width `＋`), `◫ ⊟ ✕` for
split / split / close pane, `✕` in a dialog's corner. A tab is just its name,
lit when it's on screen (no `●`/`○`, no pane count); only the lit tab has `×`.

The tab bar also can't shrink any more (`flexShrink={0}`): on a screen under
~20 rows the terminal below used to take its row, and the tabs vanished.

## The app shell (`src/app.tsx` + `src/app/`)

`app.tsx` had grown to 1,238 lines: nine pop-ups each with a state, a ref for
the key handler and a guard in it, ~20 more state+ref pairs, and a 150-line
if-chain of keys. Now (646 lines + `src/app/`):

- **Pop-ups are one stack** (`Overlay`, a union of add / ssh / help /
  close-worktree / forget / tracking / merge / rename / notice). Opening one
  replaces any of its kind; the top is rendered and owns the keyboard, so the
  key handler has one check. A notice raised while something else is open goes
  on top of it. Adding a pop-up = a union case + a `switch` arm.
- **`useLive`** replaces the hand-kept "write the ref, then setState" pairs.
- **Keys** are a table; `keyIds` names a key `C-c` / `R` / `r`, most specific
  first, so an unbound Shift/Ctrl+letter still acts as the letter (as before).
- Found on the way: `?` then `q` in one burst quit the app — the help's flag
  only reached the key handler on the next render. The stack's ref is written
  at once, so `q` now closes the help.

## Help

`?` (or the footer `?`) opens `HelpOverlay` — a top-most overlay listing all
sidebar / terminal / mouse shortcuts, an **Icons** legend (agent statuses,
`●3`, `+12 −3 ↑1 ↓2`, the PR badges, `⌁`) — the sidebar shows glyphs only,
so this is where they're spelled out — and the active theme; `esc` / `?` /
click closes. The sections scroll (`↑↓`/`j k`, PgUp/PgDn,
`g`/`G`, wheel): they had outgrown a 30-row screen and started drawing over
each other.

## OpenCode-style UI (#51)

Modelled on OpenCode's TUI (sst/opencode, also OpenTUI; its source, not
screenshots, for the details):
- **Animated statuses** (`src/anim.ts`, `AgentGlyph`): working spins
  (braille `⠋⠙⠹…`, a step per 80ms tick), needs-action pulses (◆ fading
  toward the background and back, 1.6s). One shared clock (`useTick`) runs
  only while something animates. `AGENTREE_ANIMATIONS=off` holds them still;
  the test sandbox sets it so frames are stable, and the tests that check the
  animation turn it back on.
- **Command palette** (`ctrl+p`, `CommandPalette`): the sidebar's key table as
  commands — only those that apply to the selected row and what's on screen
  (no "close" on the main copy, no "merge" without an open PR) — grouped,
  fuzzy-filtered (start > word start > inside > letters in order; title
  counts double), each with its key and a detail (`#42`, the worktree, the
  next theme). Enter or a click runs the key's own handler.
- **Dialogs** (`Dialog`, `rowLook`): borderless panel (`panelAlt`) over a
  dimmed screen (`#00000099`, OpenTUI blends it), a quarter of the way down,
  bold title with a clickable `✕` (`esc` until #59); the selected row is
  filled with the accent (and keeps its ▶, a cue that isn't only colour). Every pop-up uses
  it; a click outside closes, except while busy.
- **Toasts** (`src/app/toasts.tsx`): top right, `┃` edges in the kind's colour,
  one at a time, 4–8s by kind (failures longest), `esc` or a click dismisses.
  They replaced the `notice` pop-up for failures; closing a worktree,
  removing a host and turning tracking on/off confirm with one.

## Persistence

- `~/.config/agentree/state.json`: `{ version, workspaceRoot, repos[] { nameWithOwner,
  name, root, defaultBranch, worktrees[] { id, branch, name, path, createdAt },
  labels? { [worktreeId]: label } }, hosts?[] { host, home?, dirs[] { id, path,
  createdAt }, labels? }, ui? { sidebarWidth?, sidebarHidden?, prPanelHidden?,
  prPanelWidth?, prPanelCollapsed?, mergeMethod? } }`. Labels are keyed by
  worktree id so the main working copy (never stored in `worktrees[]`) can have
  one too; closing a worktree drops its label. Volatile git status is computed
  at runtime, never persisted. Atomic write.
- `~/.config/agentree/claude-hooks.json` (the hooks agents load) and
  `~/.config/agentree/agents/` (their per-pane reports) are runtime only; stale
  reports are cleaned up against live tmux panes.
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
- **OpenTUI React event props go straight into the renderable's listener slot**
  (`setProperty` default: `instance[key] = value`). For a renderable that
  installs its own handlers (`EmbeddedTerminal`'s mouse forwarding) a same-named
  prop replaces them — put app logic on the generic `onMouse`.
- **Pointer capture**: OpenTUI captures on the first *drag* event, whatever is
  under the pointer then. To own a drag, call the renderer's (untyped)
  `setCapturedRenderable` on mouse-down. The final release is also dispatched to
  whatever is under the pointer, and a captured renderable is left out of the
  hit grid until the next frame.
- **tmux 3.7**: `kill-server` leaves the socket file behind; `terminal-overrides`
  is read when a client attaches (set it earlier in the same command list);
  terminfo's `Se` resets the cursor to a steady block; `#{window_activity}`
  updates on every output (1s resolution); `new-session -e` env reaches later
  windows too.
- **Terminal focus ≠ browser "focus"**: TanStack's browser focus is tab
  *visibility*; terminal focus (mode 1004) is *keyboard* focus — a visible but
  unfocused window blurs. Hence only network polling pauses on blur. The focus
  state is global: each binding resets it and a cleanup only undoes its own
  binding (an app's unmount lands a moment after `dispose()`).
- **TanStack Query under Bun**: with no `window` it assumes a *server* — refetch
  timers off, `gcTime` Infinity, no retries. `environmentManager.setIsServer(()
  => false)` (in `src/queryClient.ts`) is the documented fix for such runtimes.
  One `QueryClient` per `App` instance (tests inject their own via `renderApp({
  queryClient })`) — module-level caches used to leak between tests.
- **A cache hit renders before everything around it loads.** The add-worktree
  modal's open PRs come from the cache instantly, while the repo's existing
  worktrees are still being read — so for a frame a PR that already had a
  worktree was offered again (CI caught it, #29). Anything filtered against
  local state has to wait for that state (`existingLoaded`), not just its query.
- **Mouse-down bubbles to every ancestor**: the sidebar root's `onMouseDown`
  (click → sidebar focus) sees each row's mouse-down too, so a row that hands
  focus elsewhere (double-click → terminal) must `stopPropagation()`.
- **OpenTUI's `truncate` misdraws in a flex-shrunk box**: at narrow widths it
  can overdraw its neighbour or leave short text blank. Where the width isn't
  known up front (tab names), cut the text in JS instead (`tabLabel`, 20 chars).
- **The PTY child needs the emulator's `TERM`**, not the host's: Bun's
  `terminal.name` doesn't set it, so tmux inherited `xterm-kitty` (a terminal
  we aren't) or, in CI, `dumb` — and refused to attach ("terminal does not
  support clear"). No test needed a working client until the tab-rename ones.
  `useTerminalSession` passes `TERM=xterm-256color`.
- **A prompt over a focused terminal must consume its keys**: global
  `useKeyboard` handlers run before the focused emulator, so `RenameModal`
  calls `preventDefault()` + `stopPropagation()` on every key and paste —
  otherwise what you type also reaches the shell underneath.
- **Unmounting a terminal kills its tmux client** (the session lives on in the
  server): closing the PTY alone let a client that was still starting go on and
  start a server nobody was attached to.
- **Claude Code hooks** (verified on 2.1.280): `UserPromptSubmit`/`SessionStart`
  stdout is fed into the conversation, so hooks must be silent; the
  `permission_prompt` notification fires ~6s after the dialog; `Stop` doesn't
  fire on Esc and nothing fires on deny. Claude's spinner keeps output flowing
  while it works (gaps ≤1s, even during a long tool run).
- **git reports worktree paths with symlinks resolved.** `path.resolve` doesn't
  follow them, so a repo reached through one (a code folder on another disk,
  `/home` → `/var/home` on Silverblue, macOS's `/tmp`) lost its main copy and
  had its worktrees adopted twice. Paths compared with git's go through
  `canonicalPath` (#46) — only for comparing; what's stored stays as given.
  Found by the macOS CI job, whose temp dir is such a symlink; reproducible on
  Linux with `TMPDIR` pointing through a symlink.
- **The test harness's `pressKey("return")` types r, e, t, u, r, n** — named
  keys have their own helpers (`pressEnter`, `pressTab`, `pressEscape`,
  `pressBackspace`). The first demo recordings typed "return" into the palette.
- **A dialog's keys attach a moment after it shows** (`useKeyboard` is an
  effect): keys sent in the same instant go nowhere — tests wait briefly after
  opening one before typing.
- **Flex centring can land on a half row**, and OpenTUI renderables round it
  differently: the empty pane's subtitle was drawn over the logo's second row
  whenever the centred block's height and the pane's had different parity.
  It's placed with a whole-row `paddingTop` now.
- **A new terminal flashed black** (#52): tmux clears the screen when it
  attaches and repaints it row by row, and a cleared cell shows the emulator's
  default background — black until `TerminalPane` set it (OSC 10 / 11, before
  tmux's first output, and on a theme change). Seen only in the recordings (two
  frames); `e2e/terminal-open` samples every frame of an attach for black.
- **puppeteer's emulated device scale factor breaks xterm's WebGL sizing** (it
  drew 2.5× too large); Chrome's own `--force-device-scale-factor` is fine.
- **A browser isn't a terminal**: laying a captured frame out as HTML text
  gave the first README screenshots misaligned rows (symbols from fallback
  fonts at other widths), stripes between rows, gappy box lines and boxes
  behind dim text. They're drawn by xterm.js now (#48).
- **`scrollChildIntoView` measures the last layout** (#59): the selected
  sidebar row grows a line, but the effect that scrolls to it runs before
  that's laid out, so the last row's second line ended up just below the
  list. The row passes `onSizeChange` (fired from `updateFromLayout`, with its
  new `y` and height) and the sidebar scrolls to it again from there.

## Tests

`bun test` — 447 tests, ~80s (`bun run test` and CI use a 30s per-test timeout;
plain `bun test` defaults to 5s). CI (`.github/workflows/ci.yml`: install,
typecheck, test, compile build) runs on every PR and every push to main. Unit
(pure helpers), integration (real git in a temp dir, a fake `gh` on PATH, and a
real tmux server on a throwaway socket), and E2E that drive the whole `App`
headlessly through OpenTUI's test renderer with mock keys, mock mouse and frame
capture. Details and the helper API: `docs/TESTING.md`.

Three input bugs the E2E found on its first run, all fixed:
- **Burst coalescing** — the key handlers read state through refs React only
  refreshes on render, so keys arriving in one tick (fast typing, paste, key
  repeat) all acted on the same stale value: `feature/x` typed as `x`, holding
  `j` moved one row. Writes now update the mirror too.
- **`G` never fired** — Shift+G arrives as `name: "g"` with `shift: true`, so
  "jump to last row" was unreachable and behaved like `g`.
- **Uppercase was swallowed** — the inputs appended `key.name`, which is
  lowercased; `JIRA-12` typed as `jira-12`. They now use `key.sequence`.

Seams added for testability: `App` lives in `src/app.tsx` (`index.tsx` is just
the entry point), the tmux socket is `AGENTREE_TMUX_SOCKET`-overridable,
`proc.run()` passes `process.env` explicitly (so a test's `PATH` shim applies),
`resetTheme()` resets the one module-level state left, and `renderApp()` takes a
`queryClient` (each app gets a fresh one otherwise, so no cache leaks between
tests). Where the keyboard is gets checked by pressing `?`: the sidebar opens
help, a focused terminal swallows it.

The sandbox also runs an inert agent command (`AGENTREE_AGENT_CMD=sh`) — tests
that open a terminal used to start the real `claude` — and its cleanup stops the
test's own tmux server and removes the socket file tmux leaves behind. It also
puts a fake `ssh` on PATH (every host is this machine) and points
`XDG_RUNTIME_DIR` and the `~/.ssh/config` agentree reads into the sandbox.
Its root is the temp dir's real path: on macOS that dir is behind a symlink,
and git and `pwd` report the resolved one.

**A test must wait for the app's last write before it ends.** Paths like
state.json's come from the environment at the moment of writing, and the next
test's sandbox has already replaced that environment — so a save still in
flight (a merge's `.then` saving the method used) lands in the *next* test's
state file, which then starts with a stale worktree. Seen once in CI (#34); the
merge tests now wait for the save.
**Waiting for the app** (#59): a worktree's branch only shows on the selected
row, so tests wait for its row by name — `· x` (status glyph, name) — not
`feature/x`; where an agent may already have reported, for the row whatever
its glyph. The tab bar has helpers (`tabBar`, `activeTab` — the lit tab is
the bar's only bold text — and `waitForTab`), as the tabs lost their `●`/`○`.

Terminal-focused chords *can* be driven: mock keys reach the app's global key
handlers before the focused emulator, as real input does (checked with Ctrl+g
and ⌥r; this file used to say otherwise). The tab-rename tests do it, and read
tmux's own `list-windows` for the result.

## Quality checks (CI)

Every PR, and every push to main (`.github/workflows/`):
- **`ci.yml` — lint · format**: `bunx biome ci` (Biome: lint + formatting;
  `biome.jsonc` says why each rule it turns off is off). Locally: `bun run
  lint`, `bun run format`, `bun run check` (Biome + typecheck).
- **`ci.yml` — typecheck · test · build, on Linux and macOS** (macOS runners
  get tmux from Homebrew). On Linux the suite runs with coverage and
  `scripts/check-coverage.ts` totals `coverage/lcov.info` over `src/` against a
  minimum (lines 94%, functions 88% — just under where it was). Bun's own
  `coverageThreshold` applies per file (and wants plural keys: `lines`,
  `functions` — the singular form is silently ignored), which would fail on
  legitimately less-covered files like TerminalPane. `bun run coverage` locally.
- **`pr-title.yml`**: the PR title must be a Conventional Commits title
  (`type(scope)!: summary`, no full stop) — checked in bash with the title
  passed through the environment, so a title can't inject shell.
- **`claude-code-review.yml`**: the review bot.

The macOS job paid for itself on its first run: 18 failures, 16 of them a real
bug with symlinked repo paths (#46; see **Key learnings**).

**README screenshots** — `bun scripts/screenshots.tsx` renders the real app
headlessly (the test sandbox, fakes and sample data from `scripts/lib/
sample.ts`: two repos, a labelled worktree with PR #42, an agent waiting on a
permission prompt and one working, an agent transcript in a terminal) and
photographs it with `scripts/lib/terminal.ts`: one headless Chrome page
(puppeteer-core, the system Chrome) with an xterm.js terminal (WebGL), each
frame replayed as ANSI → `docs/screenshots/*.png`. Re-run when the UI changes.
A scene that waits for text a hidden panel would show hangs.

**Demo recordings** — `bun scripts/record.tsx [scene…]` drives the app through
a scripted session (keys on a timer), grabs the screen 12×/s, photographs each
distinct frame and encodes a GIF + MP4 with ffmpeg into `.recordings/`
(ignored). For PR descriptions: they're pushed to the `media` branch (never
merged) and linked by commit. Scenes: `agents`, `palette`, `themes`.

## Deferred / follow-ups

- README screenshots predate #59's UI; `bun scripts/screenshots.tsx` needs tmux
  and Chrome outside a sandbox — and on macOS `google-chrome` on PATH, as
  `scripts/lib/terminal.ts` doesn't look in `/Applications`.

- Test coverage for the rest of the terminal pane (panes, the + menu) — its
  keys can be driven now (see **Tests**); the diff picker is covered.
- Restore/list live sessions on startup; layout-restore JSON (reboot survival).
- Agent status: "needs action" lags a permission prompt by Claude's ~6s
  notification delay. A `claude` typed by hand only reports with tracking on
  (`H`) — agentree won't edit Claude's settings unasked.
- Upstream: OpenTUI's `EmbeddedTerminal` re-mirrors the cursor every frame (its
  main renderer already dedupes — anomalyco/opentui #287, #794). Not filed yet;
  our subclass works around it.
- Drag-to-reorder tabs; the tab bar doesn't scroll, so with many long-named
  tabs the ones on the right (maybe the current one) are out of view.
- Persistence layer stays on tmux (only JS lib with true persistence needs Node;
  `dtach` is a lighter binary alternative if ever wanted).
- SSH projects: git features for remote directories (status, worktrees, PRs);
  a directory deleted on the host isn't noticed (no "missing" check).
- PR panel sections fold by mouse only — keyboard folding needs a way to move
  through the panel's sections.
- No LICENSE yet (the README says so) — the owner's call.
- The broker needs the app open: sandboxed agents can't open tabs while it's
  closed (a broker of its own, living as long as the tmux server, would lift that).

## Caveats

- **tmux required** for local terminals (3.7c installed). If absent, the
  terminal pane says so, with the install command for this system (`brew` on
  macOS, else the Linux package manager found). SSH hosts need tmux too, and their host key accepted once
  (`ssh host` in a terminal); a password or key passphrase is asked for. Most of this was verified via headless
  harnesses (the sandbox has no interactive TTY) — worth occasional live passes
  (`bun run dev`).
- **Tests never touch the real environment**: every test goes through
  `createSandbox()`, which redirects `AGENTREE_HOME`, `XDG_CONFIG_HOME` and the
  tmux socket into a temp dir.
- **Incident**: during a test a `tmux kill-server` on the *default* socket killed
  the user's real sessions. Now isolated via `-L agentree`; never `kill-server`
  a shared socket — kill specific sessions only.

## Commit history

### 2026-10-01

- #59 `a748bb9` Icons over words: one line per worktree (the selected one adds
  its branch, +/−, ahead/behind), status glyphs without labels, `✓#N` for a
  merged PR and `⇡#N◌` a draft, a one-row sidebar footer (`◑ ? «`; its hint
  line gone), an icon tab bar (`◫ ⊟ ✕`, `^g`), PR panel sections without bands,
  `✕` in dialogs; the theme is named in a toast, the help has an Icons legend.
  `158f841` a test's wait for a row whatever its agent's glyph

### 2026-09-25

- #52 `a90f7c5` No black flash when a terminal opens: the emulator's default
  colours are the theme's (OSC 10 / 11)
- #51 `f02b78c` OpenCode-style UI: animated agent statuses, a command palette
  (`ctrl+p`), borderless dialogs over a dimmed screen, toasts, styled hints, an
  OpenCode theme; the empty pane says what to do next (and no longer draws its
  subtitle over the logo). `89a10ef` demo recordings (`scripts/record.tsx`)
  and a shared terminal camera
- #50 `96ddd00` A roomier sidebar: project header bands, worktrees as spaced
  two-line cards (agent label on line 2), and a list that scrolls to keep the
  selection in view; README screenshots regenerated
- #49 `461d88e` Merged PRs stay on their worktree (`⇡#N merged`; only a PR
  that was this branch's), and closing it is one key: `d`, the panel's
  `Close worktree…`, or `d` right after merging with `m`
- #48 `289f4eb` README screenshots drawn by xterm.js instead of laid out as
  HTML text (no more misaligned rows, stripes or gappy box lines); `4c07653`
  in a 160×40 window, so a dialog fits between the sidebar and the PR panel
- #47 `4f5d045` Real screenshots in the README (the overview, adding a
  worktree, merging), made by `scripts/screenshots.tsx`; `15c7086` the
  README's dev commands include check, format and coverage. (Pushed to #44
  after it had been merged, so they came in again here.)
- #46 `ce27969` Worktree paths compared with symlinks resolved: a repo reached
  through a symlink kept its main copy and stopped getting duplicate worktrees
- #45 `33773b2` Quality checks: Biome lint + format (`d5c1088`, whole codebase
  formatted once in `3f2c57d`), CI on macOS too, a coverage minimum, and
  Conventional Commits PR titles; `2bf7cea` the tests pass on macOS (resolved
  sandbox paths, a resize check that doesn't assume a short temp path)

### 2026-09-24

- #44 `08e1185` A proper README: what agentree is, features, requirements,
  install, keys, the agent CLI, configuration
- #43 `46e6a58` Rework of `app.tsx`: pop-ups as one stack, `useLive` state,
  keys as a table, preferences / agents / live git status in their own hooks
  (1,238 → 646 lines)
- #42 `8ec5aef` Agent CLI: `agentree tab new|read|send|list|select|rename|close`,
  `diff`, `notify`, `status` — on PATH in every agentree terminal, announced to
  claude by a SessionStart hook; plus a Claude Code skill (`agentree skill
  install`)
- #41 `ac21cdf` Hints: the tab bar keeps just `^g sidebar`; the sidebar footer is
  one line of keys for the selected row; the tab bar no longer vanishes on
  short screens
- #40 `f783701` Status for every agent: `H` puts the hooks in Claude's user
  settings (asks first; merged, reversible) so a hand-typed claude reports too;
  SSH hosts report over ssh. Notifications when an agent needs you elsewhere;
  `Tab` / `⌥n` / a footer count jump to it
- #39 `5eacad6` Diff viewers: hunk, diffnav, delta, difftastic, nvim diffview
  or plain git — the first installed, or the one picked with `v` in the diff
  picker (remembered); empty diffs say so; pagers can't quit on a short diff
  (git's `LESS=FRX`, and the user's own `core.pager` = delta, both did)
- #38 `980c900` SSH terminals don't need tmux on this machine (the check was
  for local terminals); the install hint fits the system instead of always
  `pacman`
- #37 `d40225c` SSH password logins: asked for when adding a host
  (SSH_ASKPASS, never stored), then the shared connection is reused; after a
  restart the terminal asks; background calls never log in on their own (a
  poll every second would get the client banned). Checked with a real sshd
  and a passphrase-protected key
- #36 `daeb54c` Hide the sidebar (`b` / its `⇤`; back with `b`, Ctrl+g or
  `‹`), remembered
- #35 `e7b2b49` SSH projects (`s`): a host and directories on it, terminals
  running on the host in tmux there; remote shells only. Checked against a
  real sshd, which found the ControlPath length limit, tmux's `_` for
  non-ASCII without a UTF-8 locale (`-u`), and non-POSIX login shells
- #34 `2003961` PR panel: sections fold (click the header band; remembered),
  ruled-off header and footer, quoted comments, a filled `Merge…` button;
  `dfff0fe` merge tests wait for the merge to finish (a late save leaked into
  the next test's sandbox)
- (#32 tab renaming and #33 merging from the PR panel, listed under
  2026-09-23, were merged this morning.)

### 2026-09-23

- #33 `e43ba20` Merge PRs from the PR panel (`m`): repo's allowed methods, confirm
  step, auto-merge for blocked PRs, pinned to the head commit
- #32 `b5d3ea6` Rename terminal tabs (`⌥r` / right-click): tmux `rename-window`;
  empty turns `automatic-rename` back on; `65cbea5` the terminal's tmux client gets
  `TERM=xterm-256color`, not the host's
- #31 `653706d` Rename worktrees (`R` / right-click): a sidebar label, stored
  in state.json; branch and directory untouched
- #30 `f863910` Clicking the sidebar gives it the keyboard (was `Ctrl+g` only);
  a single click on a worktree shows it, a double-click types in it
- #29 `8b8b943` Add-worktree modal no longer offers a PR that already has a
  worktree for a frame (cache hit raced the worktree list; main CI was red)
- #28 `a10dd39` TanStack Query for all data fetching (PR details cached across
  worktree switches, badges keep their last answer on failure); `59a2d7b`
  terminal focus (mode 1004) drives it — refresh on return, GitHub quiet when away
- #27 `849f8d2` PR panel (right side: merge, reviews, checks, comments; `p` `o` `r`, ⌥p)
- #26 `7ef52b9` Live agent status (Claude Code hooks + tmux) and an accurate,
  live changed-files count; help overlay scrolls; test sandbox hardening
- #25 `e214420` Resizable sidebar (drag the divider, `[` `]` `=`, remembered)
- #24 `74a3c42` Native blinking cursor (DECSCUSR passthrough, tmux `Se` override)
- #23 `d1402a4` No selection overlay over nvim; cursor frozen while output
  streams (issues #21, #22)
- #20 `52df35a` Mouse reaches programs inside the terminal (tmux `mouse on`, `onMouse`)
- #19 `4cff1c9` Cursor dedupe (superseded by #23) + `docs/terminal-rendering-glitches.md`

2026-09-22 (PRs #1–#18: test suite + CI, open-PR picker, startup agent, `d` to
close a worktree, keep-alive terminals, flash fixes) isn't itemised here — see
`git log`.

### Earlier

- GitHub PR badge on worktrees (`gh pr list --head <branch>`, background + cached)
- `93cd46e` Add "specific ref / commit" diff option to the hunk picker
- `bdd5b29` hunk diff viewer integration (＋ menu · ⌥d · diff picker → hunk in a tab)
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
