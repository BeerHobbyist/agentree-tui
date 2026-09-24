---
name: agentree
description: Control the agentree terminal you are running in — run long-lived processes (dev servers, watchers, builds, test runs) in their own tabs and read their output, show the user a diff, and ask for their attention. Use when $AGENTREE_SESSION is set and a command would block or keep running, when you need to check on a process you started, or when the user should look at something.
---

# agentree

You're running inside **agentree**: a terminal workspace where each git worktree has its own terminal with **tabs** (tmux windows). The user sees those tabs in agentree's tab bar. The `agentree` command controls the tabs of the worktree you're in.

Check you're inside agentree before using it:

```sh
[ -n "$AGENTREE_SESSION" ] && echo inside agentree
```

If `agentree` isn't on your PATH, use `"$AGENTREE_CLI"` instead — same commands.

## When to use it

- **A command that doesn't finish by itself** — a dev server, `--watch` mode, a long build or test run you want to check on later. Run it in its own tab instead of in your own shell, where it would block you (or be killed when your command times out).
- **Checking on it** — read the tab's output instead of guessing.
- **Showing the user something** — open a diff in a tab, or ask for their attention when you're blocked or done with something they need to see.

Don't use it for quick commands that finish in seconds; run those directly.

## Commands

```sh
agentree tab list                       # index, name, active — see what's already running
agentree tab new --name dev -- npm run dev     # opens in the background; prints its index
agentree tab read dev --lines 40        # its last 40 lines (default 50)
agentree tab send dev --key C-c         # stop it (tmux key names: C-c, Enter, Up, …)
agentree tab send dev "rs"              # type a line into it (Enter follows unless --no-enter)
agentree tab close dev
agentree diff                           # working changes, in a tab for the user (also: staged, base, a ref)
agentree notify "Migration ready — review the SQL in tab db"
agentree status                         # every worktree and its agent's status
```

`TAB` is a tab's name or index. Add `--json` to `tab list` / `status` for machine-readable output.

## Working with a dev server

1. `agentree tab list` first — if a `dev` tab is already running, use it rather than starting another (`tab new` refuses a duplicate name).
2. `agentree tab new --name dev -- npm run dev`
3. Give it a moment, then `agentree tab read dev --lines 30` and look for the "ready" line or errors. Poll with short sleeps instead of one long wait.
4. After changing code, read again to see reloads or new errors.
5. When you're done with it, `agentree tab send dev --key C-c` and `agentree tab close dev` — unless the user wants it left running.

## Etiquette

- **Don't take over the user's screen.** `tab new` opens in the background; only pass `--select` (or run `tab select`) when the user asked to see the tab.
- **Name your tabs** (`--name dev`, `--name tests`) so you and the user can tell them apart, and **close the ones you opened** when you no longer need them.
- **Leave tabs you didn't open alone** — they're the user's.
- **Notify sparingly** — when you're blocked on the user or finished something they're waiting for, not for progress updates. agentree already tells the user when you stop or need a permission.
