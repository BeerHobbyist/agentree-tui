/**
 * The README's screenshots: the real app, rendered headlessly with sample data
 * (the same sandbox and fakes the tests use), and photographed as a terminal
 * window (scripts/lib/terminal.ts).
 *
 *   bun scripts/screenshots.tsx [scene…]   → docs/screenshots/*.png
 *
 * Needs Chrome (or Chromium) and tmux. Re-run it when the UI changes.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderApp } from "../test/helpers/app";
import { waitForText } from "../test/helpers/frame";
import { createSandbox, type Sandbox } from "../test/helpers/sandbox";
import { COLS, loginTerminal, ROWS, sampleWorkspace } from "./lib/sample";
import { type Frame, openCamera } from "./lib/terminal";

const OUT = resolve(import.meta.dir, "../docs/screenshots");

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
      await sampleWorkspace(sb);
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
      await sampleWorkspace(sb);
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

mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const camera = await openCamera(COLS, ROWS);
try {
  for (const [name, scene] of Object.entries(scenes)) {
    if (only.length > 0 && !only.includes(name)) continue;
    const sb = createSandbox();
    process.env.AGENTREE_ANIMATIONS = "on"; // the sandbox holds them still, for tests
    try {
      const frame = await scene.shoot(sb);
      const png = join(OUT, `${name}.png`);
      await camera.shoot(frame, scene.title, png);
      console.log(`✓ ${png}`);
    } finally {
      sb.cleanup();
    }
  }
} finally {
  await camera.close();
}
process.exit(0);
