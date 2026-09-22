# Testing

```bash
bun test                      # the whole suite (~4s)
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
  `pr list` and `auth status`. `sandbox.setRepoPage()` publishes fixtures,
  `sandbox.failGh("api")` makes a subcommand fail, `sandbox.ghCalls()` returns the
  recorded argv. Bun snapshots the environment at process start, so this only
  works because `proc.run()` passes `process.env` to `Bun.spawn` explicitly.
- **`test/helpers/repo.ts`** — `makeRepo`, `makeRemote` (the repo "on GitHub" that
  the fake `gh` clones from), `withUpstream({ ahead, behind })`.
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

The terminal pane (tmux windows/panes, the diff picker, mouse-to-pane mapping) and
a CI job. The PTY path is testable the same way — mounting `useTerminalSession`
against a tmux server on `AGENTREE_TMUX_SOCKET` renders live shell output into the
captured frames — it just needs `tmux` installed on the runner.
