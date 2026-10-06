# Testing

CI runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun test` and
`bun run build` on every pull request and every push to main. No secrets are
involved — the suite never reaches the network.

The workflow is staged at `.github/ci-workflow.yml` and is **not active yet**:
it has to be moved to `.github/workflows/ci.yml` by someone whose credentials
carry the `workflow` scope (the header of that file has the command).

```bash
bun test                      # the whole suite (~5s)
bun test test/unit            # or one layer
bun test test/e2e/add-worktree.test.tsx
```

Nothing is stubbed at the module level: the tests drive the real app with real
keystrokes, over real git repositories, with a fake `gh` binary standing in for
the network.

## Layers

| Directory | What it covers | Backed by |
|---|---|---|
| `test/unit` | pure logic — path/branch sanitizing, tmux session names and theme options, `hunk` argv, `buildRows` | nothing external |
| `test/integration` | `services/git`, `services/gh`, `store` | real `git` in a temp dir, fake `gh` on PATH |
| `test/e2e` | the whole `App`: keystrokes in, rendered frames and on-disk state out | OpenTUI's headless renderer + the above |

## Helpers

- **`test/helpers/sandbox.ts`** — `createSandbox()` points `AGENTREE_HOME`,
  `XDG_CONFIG_HOME`, `AGENTREE_TMUX_SOCKET`, `PATH` and git's identity at a temp
  directory, and resets the module-level caches (`gh` repos, `gh` PRs, the theme
  store). Every test that touches git, gh, tmux or the store must call it in
  `beforeEach` and `cleanup()` in `afterEach` — otherwise it reads and writes the
  developer's real `~/.config/agentree/state.json`, `~/agentree` and tmux server.
- **`test/helpers/fakebin/gh`** — a shell script serving `api`, `repo clone`,
  `pr list` (both the per-branch badge lookup and the picker's open-PR listing)
  and `auth status`. `sandbox.setRepoPage()`, `setOpenPrs()` and `setBranchPr()`
  publish fixtures,
  `sandbox.failGh("api")` makes a subcommand fail, `sandbox.ghCalls()` returns the
  recorded argv. Bun snapshots the environment at process start, so this only
  works because `proc.run()` passes `process.env` to `Bun.spawn` explicitly.
- **`test/helpers/repo.ts`** — `makeRepo`, `makeRemote` (the repo "on GitHub" that
  the fake `gh` clones from), `withUpstream({ ahead, behind })`, and `addPrHead`,
  which publishes a commit reachable only through `refs/pull/<n>/head`, the way a
  PR from a fork looks.
- **`test/helpers/app.tsx`** — `renderApp()` loads state, reconciles it and mounts
  `App` headlessly; `quitCount()` replaces `process.exit`.
- **`test/helpers/frame.ts`** — `waitForText`, `waitForTextGone`, `waitUntil`,
  `selection()`.

## Writing an E2E test

```tsx
app = await renderApp();
app.mockInput.pressKey("n");
await waitForText(app, "acme/widget");
app.mockInput.pressEnter();
```

Things worth knowing:

- **Wait for the modal, not for its text.** The add-worktree modal swaps its body
  between phases, so "Create new worktree" disappears while it is still open and
  still owns the keyboard — a key sent then is swallowed. Use
  `waitForModalClosed(app)`.
- **Always wait, never sleep.** The app talks to git and `gh` in the background;
  `waitForText` polls (sleep → `renderOnce()` → capture) and prints the last frame
  when it gives up. OpenTUI's own `waitForFrame` counts render passes rather than
  wall-clock time, so it can expire before a subprocess has answered.
- **Selection is colour, not glyphs.** The selected row is marked by an
  accent-coloured gutter cell, which `captureCharFrame()` cannot show. Use
  `selection(app)` / `waitForSelection(app, "…")`, which read `captureSpans()`.
- **Keys are parsed, not typed.** `pressKey("G")` arrives as `name: "g"` with
  `shift: true`, and `pressKey(" ")` as `name: "space"`. Uppercase text has to come
  from `key.sequence`.
- **Bursts are the interesting case.** Keys sent without an `await` in between
  arrive in one tick, before React re-renders — which is what key repeat and paste
  do in a real terminal. Several tests do this deliberately.
- `renderApp()` turns React's act environment off after the initial render: the app
  updates from promises that no `act()` call can wrap.

## Not covered yet

The terminal pane: tmux windows/panes, the diff picker, mouse-to-pane mapping. The
PTY path is testable the same way — mounting `useTerminalSession`
against a tmux server on `AGENTREE_TMUX_SOCKET` renders live shell output into the
captured frames — it just needs `tmux` installed on the runner.
