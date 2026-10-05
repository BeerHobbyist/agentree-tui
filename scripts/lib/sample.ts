/**
 * The sample workspace the README's screenshots and the demo recordings show:
 * acme/webapp and acme/api in the test sandbox, with agents, a PR and an
 * agent's transcript in a terminal.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentStatusDir } from "../../src/services/agents";
import { sessionName } from "../../src/services/tmux";
import { loadState, reconcile, saveState, setWorktreeLabel, upsertRepo } from "../../src/store";
import type { RenderedApp } from "../../test/helpers/app";
import { waitForSelection, waitForText } from "../../test/helpers/frame";
import { makeRepo, writeFile } from "../../test/helpers/repo";
import type { Sandbox } from "../../test/helpers/sandbox";

// Wide enough for a dialog to sit between the sidebar and the PR panel.
export const COLS = 160;
export const ROWS = 40;

const tmux = (sb: Sandbox) => ["tmux", "-L", sb.tmuxSocket];

/**
 * A shell command printing `lines` (escapes as `\\033…`), then keeping the pane
 * open with the output and no shell prompt under it.
 */
function show(lines: string[]): string {
  return `printf '${lines.join("\\n").replace(/'/g, "'\\''")}\\n'; exec sleep 600`;
}

/**
 * A pane standing in for an agent — showing `screen`, if given — reporting
 * `state` the way its hooks would.
 */
export async function agent(sb: Sandbox, session: string, state: string, screen: string[] = []) {
  Bun.spawnSync([
    ...tmux(sb),
    "new-session",
    "-d",
    "-s",
    session,
    "-n",
    "claude",
    screen.length ? show(screen) : "sleep 600",
  ]);
  const pane = new TextDecoder()
    .decode(Bun.spawnSync([...tmux(sb), "display", "-p", "-t", session, "#{pane_id}"]).stdout)
    .trim()
    .replace("%", "");
  await Bun.sleep(1100); // the report must be newer than the pane's last output
  mkdirSync(agentStatusDir(), { recursive: true });
  writeFileSync(join(agentStatusDir(), `${session}.${pane}`), `${state} ${Math.floor(Date.now() / 1000) + 2}\n`);
}

/** Terminal styles, as printf escapes: bold, dim, green, red, cyan, and back to plain. */
const b = "\\033[1m";
const d = "\\033[2m";
const g = "\\033[32m";
const red = "\\033[31m";
const c = "\\033[36m";
const x = "\\033[0m";

/** What an agent waiting on a permission prompt shows. */
const PERMISSION_PROMPT = [
  `${b}> The cart total ignores quantities — fix it${x}`,
  "",
  `${g}●${x} Read ${b}src/cart/total.ts${x}`,
  `${g}●${x} Found it: each item's price is added once, whatever its quantity.`,
  "",
  `  ${b}Edit src/cart/total.ts${x}`,
  `  ${red}- const total = items.reduce((s, i) => s + i.price, 0)${x}`,
  `  ${g}+ const total = items.reduce((s, i) => s + i.price * i.qty, 0)${x}`,
  "",
  `  ${b}Do you want to make this edit?${x}`,
  `  ${c}❯ 1. Yes${x}`,
  "    2. Yes, and don't ask again this session",
  "    3. No, and tell Claude what to do differently",
];

/** What a working agent shows. */
const WORKING = [
  `${b}> Rate-limit the public API, 100 requests a minute per key${x}`,
  "",
  `${g}●${x} Read ${b}src/middleware/index.ts${x}`,
  `${g}●${x} Wrote ${b}src/middleware/rateLimit.ts${x} ${d}(+58)${x}`,
  "",
  `${c}✻ Adding the token bucket to the middleware chain…${x} ${d}(esc to interrupt)${x}`,
];

const CHECKS = [
  { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "CheckRun", name: "unit", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "CheckRun", name: "e2e", workflowName: "CI", status: "IN_PROGRESS", conclusion: null },
];

/** acme/webapp (a labelled login worktree with PR #42, a checkout fix waiting on you) and acme/api (an agent working). */
export async function sampleWorkspace(sb: Sandbox) {
  const web = await makeRepo(join(sb.workspace, "webapp"), {
    worktrees: [{ branch: "feature/login" }, { branch: "fix/checkout-total" }],
  });
  const api = await makeRepo(join(sb.workspace, "api"), { worktrees: [{ branch: "feat/rate-limits" }] });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/webapp", name: "webapp", root: web });
  upsertRepo(state, { nameWithOwner: "acme/api", name: "api", root: api });
  await saveState(state);
  await reconcile(state);
  await setWorktreeLabel(state, "acme/webapp", "feature-login", "Login screen");
  const login = join(web, ".worktrees", "feature-login");
  writeFile(login, "src/login.tsx", "export {}\n");
  writeFile(login, "src/auth.ts", "export {}\n");
  sb.setBranchPr(
    { number: 42, title: "Add login screen", headRefName: "feature/login", checks: CHECKS },
    "feature/login",
  );
  sb.setPrView(42, {
    number: 42,
    title: "Add login screen",
    url: "https://github.com/acme/webapp/pull/42",
    state: "OPEN",
    isDraft: false,
    author: { login: "ignacy" },
    baseRefName: "main",
    headRefName: "feature/login",
    headRefOid: "4f1c2e9",
    additions: 212,
    deletions: 18,
    changedFiles: 6,
    updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    latestReviews: [
      { author: { login: "alice" }, state: "APPROVED" },
      { author: { login: "bob" }, state: "COMMENTED" },
    ],
    statusCheckRollup: CHECKS,
    labels: [{ name: "auth" }, { name: "frontend" }],
    comments: [
      {
        author: { login: "alice" },
        body: "Looks good — tested the OAuth redirect on staging.",
        createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    ],
    body: "Adds the login screen and session handling, behind the `auth` flag.",
  });
  await agent(sb, sessionName("acme/webapp", "fix-checkout-total"), "needs-action", PERMISSION_PROMPT);
  await agent(sb, sessionName("acme/api", "feat-rate-limits"), "working", WORKING);
}

/** What the login worktree's terminal shows: an agent at work, a dev server in the next tab. */
export async function agentTerminal(sb: Sandbox) {
  const s = sessionName("acme/webapp", "feature-login");
  Bun.spawnSync([...tmux(sb), "rename-window", "-t", `${s}:0`, "claude"]);
  Bun.spawnSync([...tmux(sb), "new-window", "-d", "-t", s, "-n", "dev", "sleep 600"]);
  const script = [
    `${b}> Add a login screen with OAuth, behind the auth flag${x}`,
    "",
    `${g}●${x} Read ${b}src/auth.ts${x}`,
    `${g}●${x} Wrote ${b}src/login.tsx${x} ${d}(+84)${x}`,
    `${g}●${x} Updated ${b}src/routes.tsx${x} ${d}(+6 -1)${x}`,
    `${g}●${x} agentree tab new --name dev -- npm run dev`,
    `  ${d}⎿ opened tab 1: dev${x}`,
    `${g}●${x} agentree tab read dev`,
    `  ${d}⎿ VITE v6.2 ready in 412 ms — http://localhost:5173${x}`,
    `${g}●${x} npm test ${d}— 48 passed${x}`,
    "",
    "The login screen is in place: OAuth via",
    "/auth/callback, the session in an httpOnly",
    "cookie, all behind the auth flag. The dev",
    "server is running in the dev tab.",
  ];
  Bun.spawnSync([...tmux(sb), "send-keys", "-t", `${s}:0`, `clear; ${show(script)}`, "Enter"]);
  await Bun.sleep(1500);
}

export async function openLogin(app: RenderedApp) {
  await waitForText(app, "Login screen");
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "Login");
}

/** The login worktree's terminal open with the agent's transcript, keys back on the sidebar. */
export async function loginTerminal(sb: Sandbox, app: RenderedApp) {
  await openLogin(app);
  app.mockInput.pressEnter();
  await waitForText(app, "^g"); // the tab bar: the terminal is open
  await Bun.sleep(1000);
  await agentTerminal(sb);
  app.mockInput.pressKey("g", { ctrl: true }); // the terminal shows unfocused
  await Bun.sleep(400);
}
