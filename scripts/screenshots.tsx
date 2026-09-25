/**
 * The README's screenshots: the real app, rendered headlessly with sample data
 * (the same sandbox and fakes the tests use), its screen — every cell's text
 * and colours — laid out as a terminal window in HTML, and photographed by
 * headless Chrome.
 *
 *   bun scripts/screenshots.tsx        → docs/screenshots/*.png
 *
 * Needs Chrome (or Chromium) and tmux. Re-run it when the UI changes.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentStatusDir } from "../src/services/agents";
import { sessionName } from "../src/services/tmux";
import { loadState, reconcile, saveState, setWorktreeLabel, type UiState, upsertRepo } from "../src/store";
import { getTheme } from "../src/theme";
import { renderApp, type RenderedApp } from "../test/helpers/app";
import { waitForSelection, waitForText } from "../test/helpers/frame";
import { makeRepo, writeFile } from "../test/helpers/repo";
import { createSandbox, type Sandbox } from "../test/helpers/sandbox";

const OUT = resolve(import.meta.dir, "../docs/screenshots");
const COLS = 140;
const ROWS = 34;

/** What the harness captures: every line's spans of text, with colours and attributes. */
type Frame = ReturnType<RenderedApp["captureSpans"]>;
type Rgba = Frame["lines"][number]["spans"][number]["fg"];

// ── Sample worktrees ──

const tmux = (sb: Sandbox) => ["tmux", "-L", sb.tmuxSocket];

/** A pane standing in for an agent, reporting `state` the way its hooks would. */
async function agent(sb: Sandbox, session: string, state: string) {
  Bun.spawnSync([...tmux(sb), "new-session", "-d", "-s", session, "sleep 600"]);
  const pane = new TextDecoder()
    .decode(Bun.spawnSync([...tmux(sb), "display", "-p", "-t", session, "#{pane_id}"]).stdout)
    .trim()
    .replace("%", "");
  await Bun.sleep(1100); // the report must be newer than the pane's last output
  mkdirSync(agentStatusDir(), { recursive: true });
  writeFileSync(join(agentStatusDir(), `${session}.${pane}`), `${state} ${Math.floor(Date.now() / 1000) + 2}\n`);
}

const CHECKS = [
  { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "CheckRun", name: "unit", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "CheckRun", name: "e2e", workflowName: "CI", status: "IN_PROGRESS", conclusion: null },
];

/**
 * acme/webapp (a labelled login worktree with PR #42, a checkout fix waiting on
 * you) and acme/api (an agent working). `ui`: layout preferences, as state.json keeps them.
 */
async function sampleWorkspace(sb: Sandbox, ui?: UiState) {
  const web = await makeRepo(join(sb.workspace, "webapp"), {
    worktrees: [{ branch: "feature/login" }, { branch: "fix/checkout-total" }],
  });
  const api = await makeRepo(join(sb.workspace, "api"), { worktrees: [{ branch: "feat/rate-limits" }] });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/webapp", name: "webapp", root: web });
  upsertRepo(state, { nameWithOwner: "acme/api", name: "api", root: api });
  if (ui) state.ui = ui;
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
  await agent(sb, sessionName("acme/webapp", "fix-checkout-total"), "needs-action");
  await agent(sb, sessionName("acme/api", "feat-rate-limits"), "working");
}

/** What the login worktree's terminal shows: an agent at work, a dev server in the next tab. */
async function agentTerminal(sb: Sandbox) {
  const s = sessionName("acme/webapp", "feature-login");
  Bun.spawnSync([...tmux(sb), "rename-window", "-t", `${s}:0`, "claude"]);
  Bun.spawnSync([...tmux(sb), "new-window", "-d", "-t", s, "-n", "dev", "sleep 600"]);
  const g = "\\033[32m";
  const d = "\\033[2m";
  const b = "\\033[1m";
  const r = "\\033[0m";
  const script = [
    `${b}> Add a login screen with OAuth, behind the auth flag${r}`,
    "",
    `${g}●${r} Read ${b}src/auth.ts${r}`,
    `${g}●${r} Wrote ${b}src/login.tsx${r} ${d}(+84)${r}`,
    `${g}●${r} Updated ${b}src/routes.tsx${r} ${d}(+6 -1)${r}`,
    `${g}●${r} agentree tab new --name dev -- npm run dev`,
    `  ${d}⎿ opened tab 1: dev${r}`,
    `${g}●${r} agentree tab read dev`,
    `  ${d}⎿ VITE v6.2 ready in 412 ms — http://localhost:5173${r}`,
    `${g}●${r} npm test ${d}— 48 passed${r}`,
    "",
    "The login screen is in place: OAuth via",
    "/auth/callback, the session in an httpOnly",
    "cookie, all behind the auth flag. The dev",
    "server is running in the dev tab.",
  ];
  // `exec sleep`: the pane keeps the output, without a shell prompt under it.
  const show = `clear; printf '${script.join("\\n")}\\n'; exec sleep 600`;
  Bun.spawnSync([...tmux(sb), "send-keys", "-t", `${s}:0`, show, "Enter"]);
  await Bun.sleep(1500);
}

async function openLogin(app: RenderedApp) {
  await waitForText(app, "Login screen");
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "Login");
}

/** The login worktree's terminal open with the agent's transcript, keys back on the sidebar. */
async function loginTerminal(sb: Sandbox, app: RenderedApp) {
  await openLogin(app);
  app.mockInput.pressEnter();
  await waitForText(app, "^g sidebar"); // the tab bar: the terminal is open
  await Bun.sleep(1000);
  await agentTerminal(sb);
  app.mockInput.pressKey("g", { ctrl: true }); // the terminal shows unfocused
  await Bun.sleep(400);
}

// ── Scenes ──

const scenes: Record<string, { title: string; shoot(sb: Sandbox): Promise<Frame> }> = {
  overview: {
    title: "agentree",
    async shoot(sb) {
      await sampleWorkspace(sb);
      const app = await renderApp({ width: COLS, height: ROWS });
      await loginTerminal(sb, app);
      const frame = app.captureSpans();
      app.dispose();
      return frame;
    },
  },
  merge: {
    title: "agentree — merging a PR",
    async shoot(sb) {
      // A narrower PR panel, so the dialog doesn't cover the start of its lines.
      await sampleWorkspace(sb, { prPanelWidth: 38 });
      const app = await renderApp({ width: COLS, height: ROWS });
      await loginTerminal(sb, app);
      await waitForText(app, "Merge…");
      app.mockInput.pressKey("m");
      await waitForText(app, "▶ Squash and merge");
      await Bun.sleep(300);
      const frame = app.captureSpans();
      app.dispose();
      return frame;
    },
  },
  "add-worktree": {
    title: "agentree — adding a worktree",
    async shoot(sb) {
      await sampleWorkspace(sb, { prPanelHidden: true }); // the dialog is wide; the PR panel isn't needed here
      sb.setOpenPrs([
        { number: 51, title: "Fix flaky checkout test", headRefName: "fix/flaky-checkout" },
        { number: 49, title: "Dark mode for settings", headRefName: "feat/settings-dark" },
      ]);
      const app = await renderApp({ width: COLS, height: ROWS });
      await loginTerminal(sb, app);
      app.mockInput.pressKey("a"); // a worktree for the selected project
      await waitForText(app, "⇄ #51");
      await Bun.sleep(300);
      const frame = app.captureSpans();
      app.dispose();
      return frame;
    },
  },
};

// ── Frame → terminal → PNG ──
//
// The frame is replayed as ANSI into xterm.js (the terminal emulator VS Code
// uses) in headless Chrome, rather than laid out as HTML text: a terminal
// keeps every glyph in its cell (symbols from fallback fonts included), fills
// each cell's background edge to edge, and draws box-drawing lines itself so
// they join up.

/** The sandbox's temp paths, as they'd read on a real machine (same width, so nothing shifts). */
function realPaths(text: string): string {
  return text.replace(/\/tmp\/agentree-\S*?(webapp|api|infra)\b/g, (m, repo: string) => {
    const shown = `~/agentree/${repo}`;
    return shown + " ".repeat(Math.max(0, m.length - shown.length));
  });
}

const rgb = (c: Rgba) => [0, 1, 2].map((i) => Math.round(c.buffer[i] ?? 0)).join(";");

/**
 * The frame as ANSI: each span placed at its own column (so a character the
 * two sides measure differently can't shift the rest of the row), in its
 * colours and attributes.
 */
function toAnsi(frame: Frame): string {
  let out = "\x1b[?25l"; // no cursor
  frame.lines.forEach((line, row) => {
    let col = 0;
    for (const span of line.spans) {
      const sgr = ["0", `38;2;${rgb(span.fg)}`];
      if ((span.bg.buffer[3] ?? 0) > 0) sgr.push(`48;2;${rgb(span.bg)}`);
      if (span.attributes & 1) sgr.push("1");
      if (span.attributes & 2) sgr.push("2");
      if (span.attributes & 4) sgr.push("3");
      if (span.attributes & 8) sgr.push("4");
      out += `\x1b[${row + 1};${col + 1}H\x1b[${sgr.join(";")}m${realPaths(span.text)}`;
      col += Bun.stringWidth(span.text);
    }
  });
  return `${out}\x1b[0m`;
}

function page(frame: Frame, title: string): string {
  const theme = getTheme();
  const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const options = {
    cols: frame.cols,
    rows: frame.rows,
    fontFamily: '"Hack", "DejaVu Sans Mono", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    customGlyphs: true,
    drawBoldTextInBrightColors: false,
    disableStdin: true,
    theme: { background: theme.bg, foreground: theme.fg },
  };
  return `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.css"><style>
  html,body{margin:0;background:#0b0d12}
  .stage{display:inline-block;padding:44px}
  .win{border-radius:12px;overflow:hidden;background:${theme.bg};border:1px solid #2a2f3a;
       box-shadow:0 24px 60px rgba(0,0,0,.55)}
  .bar{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#1b1f27;
       font:500 13px -apple-system,"Inter","Segoe UI",sans-serif;color:#8b93a1;position:relative}
  .dot{width:12px;height:12px;border-radius:50%}
  .title{position:absolute;left:0;right:0;text-align:center;pointer-events:none}
  #term{padding:10px 12px}
  </style><div class="stage"><div class="win"><div class="bar">
  <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>
  <span class="dot" style="background:#28c840"></span><span class="title">${escapeHtml(title)}</span></div>
  <div id="term"></div></div></div>
  <script src="xterm.js"></script><script src="addon-webgl.js"></script><script>
  // The font has to be loaded before xterm measures its cells.
  document.fonts.load('14px "Hack"').then(() => {
    const term = new Terminal(${JSON.stringify(options)});
    term.open(document.getElementById("term"));
    term.loadAddon(new WebglAddon.WebglAddon());
    term.write(${JSON.stringify(toAnsi(frame))});
  });
  </script>`;
}

function chrome(): string {
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    const path = Bun.which(name);
    if (path) return path;
  }
  throw new Error("screenshots need Chrome or Chromium");
}

const xtermFiles = {
  "xterm.js": require.resolve("@xterm/xterm/lib/xterm.js"),
  "xterm.css": require.resolve("@xterm/xterm/css/xterm.css"),
  "addon-webgl.js": require.resolve("@xterm/addon-webgl/lib/addon-webgl.js"),
};

async function photograph(html: string, png: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentree-shot-"));
  for (const [name, from] of Object.entries(xtermFiles)) copyFileSync(from, join(dir, name));
  writeFileSync(join(dir, "page.html"), html);
  const shot = Bun.spawnSync([
    chrome(),
    "--headless=new",
    "--use-angle=swiftshader", // WebGL without a GPU
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=1600,1100",
    "--virtual-time-budget=5000", // let the font load and xterm draw first
    `--screenshot=${png}`,
    `file://${join(dir, "page.html")}`,
  ]);
  rmSync(dir, { recursive: true, force: true });
  if (shot.exitCode !== 0) throw new Error(new TextDecoder().decode(shot.stderr));
  // Trim the empty backdrop down to the window plus a margin.
  const trim = Bun.spawnSync(["magick", png, "-trim", "+repage", "-bordercolor", "#0b0d12", "-border", "56", png]);
  if (trim.exitCode !== 0) throw new Error(new TextDecoder().decode(trim.stderr));
}

mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
for (const [name, scene] of Object.entries(scenes)) {
  if (only.length > 0 && !only.includes(name)) continue;
  const sb = createSandbox();
  try {
    const frame = await scene.shoot(sb);
    const png = join(OUT, `${name}.png`);
    await photograph(page(frame, scene.title), png);
    console.log(`✓ ${png}`);
  } finally {
    sb.cleanup();
  }
}
process.exit(0);
