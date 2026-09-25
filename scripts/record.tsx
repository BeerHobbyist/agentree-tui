/**
 * Demo recordings: scripted sessions with the real app (the sample workspace
 * in the test sandbox), captured frame by frame while they run, photographed
 * as a terminal window (scripts/lib/terminal.ts) and encoded by ffmpeg.
 *
 *   bun scripts/record.tsx [scene…]   → .recordings/<scene>.gif and .mp4
 *
 * For showing a change off (a PR's description), so not kept in the repo.
 * Needs Chrome (or Chromium), ffmpeg and tmux.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { renderApp, type RenderedApp } from "../test/helpers/app";
import { waitForText } from "../test/helpers/frame";
import { createSandbox, type Sandbox } from "../test/helpers/sandbox";
import { COLS, loginTerminal, ROWS, sampleWorkspace } from "./lib/sample";
import { type Frame, openCamera, toAnsi } from "./lib/terminal";

const OUT = resolve(import.meta.dir, "../.recordings");
const FPS = 12;

/** Grabs the app's screen FPS times a second, from `start()` to `stop()`. */
class Recorder {
  readonly frames: { at: number; frame: Frame }[] = [];
  private t0 = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly app: RenderedApp) {}

  start() {
    this.t0 = performance.now();
    this.grab();
    this.timer = setInterval(() => this.grab(), 1000 / FPS);
  }

  stop() {
    clearInterval(this.timer);
    this.grab();
  }

  private grab() {
    this.frames.push({ at: performance.now() - this.t0, frame: this.app.captureSpans() });
  }
}

/** Driving the app like a person: keys with pauses between them. */
function actor(app: RenderedApp) {
  return {
    wait: (ms: number) => Bun.sleep(ms),
    /** A key — a character, or a named one (return, tab, escape, backspace) — then a pause. */
    async key(name: string, modifiers?: Partial<Pick<KeyEvent, "ctrl" | "shift" | "meta">>, pause = 450) {
      // Named keys have their own helpers: pressKey("return") would type r, e, t, u, r, n.
      const named: Record<string, () => void> = {
        return: () => app.mockInput.pressEnter(),
        tab: () => app.mockInput.pressTab(),
        escape: () => app.mockInput.pressEscape(),
        backspace: () => app.mockInput.pressBackspace(),
      };
      (named[name] ?? (() => app.mockInput.pressKey(name, modifiers)))();
      await Bun.sleep(pause);
    },
    async type(text: string, perKey = 70) {
      for (const ch of text) {
        app.mockInput.pressKey(ch);
        await Bun.sleep(perKey);
      }
    },
  };
}
type Actor = ReturnType<typeof actor>;

interface Scene {
  title: string;
  /** Set up the sandbox and the app, up to where recording starts. */
  setup(sb: Sandbox): Promise<RenderedApp>;
  /** What happens on camera. */
  play(act: Actor, app: RenderedApp): Promise<void>;
}

/** The sample workspace, the login worktree's terminal open, keys on the sidebar. */
async function workspace(sb: Sandbox): Promise<RenderedApp> {
  await sampleWorkspace(sb);
  const app = await renderApp({ width: COLS, height: ROWS });
  await loginTerminal(sb, app);
  await waitForText(app, "Add login screen");
  return app;
}

const scenes: Record<string, Scene> = {
  /** Statuses alive — a spinner working, a pulse waiting — and Tab to the one that needs you. */
  agents: {
    title: "agentree — agents at work",
    setup: workspace,
    async play(act) {
      await act.wait(2800);
      await act.key("tab", undefined, 2800); // to checkout-total, waiting on a permission prompt
      await act.key("g", { ctrl: true }, 1600); // back to the sidebar
    },
  },
  /** ctrl+p → merge → the dialogs → merged → d closes the worktree → a toast says so. */
  palette: {
    title: "agentree — command palette",
    setup: workspace,
    async play(act) {
      await act.wait(1200);
      await act.key("p", { ctrl: true }, 1400);
      await act.type("merge", 140);
      await act.wait(900);
      await act.key("return", undefined, 1400); // the merge dialog
      await act.key("return", undefined, 1400); // squash → confirm
      await act.key("y", undefined, 1800); // merged
      await act.key("d", undefined, 1500); // close the worktree?
      await act.key("y", undefined, 3000); // closed — the toast
    },
  },
  /** t through the themes, OpenCode's among them. */
  themes: {
    title: "agentree — themes",
    setup: workspace,
    async play(act) {
      await act.wait(1400);
      await act.key("t", undefined, 1800); // midnight
      await act.key("t", undefined, 2200); // opencode
      await act.key("t", undefined, 1400); // onedark
    },
  },
};

/** The recorded frames, deduplicated, photographed and encoded to `<name>.gif` and `.mp4`. */
async function encode(name: string, title: string, frames: Recorder["frames"]) {
  const dir = mkdtempSync(join(tmpdir(), "agentree-rec-"));
  const camera = await openCamera(COLS, ROWS, 1);
  try {
    // One picture per distinct frame, shown until the next one.
    const shots: { png: string; seconds: number }[] = [];
    let last = "";
    for (const [i, { at, frame }] of frames.entries()) {
      const next = frames[i + 1]?.at ?? at + 1000 / FPS;
      const ansi = toAnsi(frame);
      if (ansi === last && shots.length > 0) {
        shots[shots.length - 1]!.seconds += (next - at) / 1000;
        continue;
      }
      last = ansi;
      const png = join(dir, `${String(shots.length).padStart(4, "0")}.png`);
      await camera.shoot(frame, title, png);
      shots.push({ png, seconds: (next - at) / 1000 });
    }
    // ffmpeg's concat demuxer: each file for its duration (the last one listed twice, or its duration is dropped).
    const list = join(dir, "list.txt");
    const lines = shots.flatMap((s) => [`file '${s.png}'`, `duration ${s.seconds.toFixed(3)}`]);
    writeFileSync(list, [...lines, `file '${shots.at(-1)!.png}'`].join("\n"));
    const ffmpeg = (args: string[]) => {
      const r = Bun.spawnSync([
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        ...args,
      ]);
      if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
    };
    const gif = join(OUT, `${name}.gif`);
    const mp4 = join(OUT, `${name}.mp4`);
    ffmpeg([
      "-vf",
      `fps=${FPS},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
      "-loop",
      "0",
      gif,
    ]);
    ffmpeg([
      "-vf",
      "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p",
      "-c:v",
      "libx264",
      "-crf",
      "22",
      "-movflags",
      "+faststart",
      mp4,
    ]);
    return { gif, mp4, shots: shots.length };
  } finally {
    await camera.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
for (const [name, scene] of Object.entries(scenes)) {
  if (only.length > 0 && !only.includes(name)) continue;
  const sb = createSandbox();
  process.env.AGENTREE_ANIMATIONS = "on"; // the sandbox holds them still, for tests
  try {
    const app = await scene.setup(sb);
    const rec = new Recorder(app);
    rec.start();
    await scene.play(actor(app), app);
    rec.stop();
    app.dispose();
    const { gif, mp4, shots } = await encode(name, scene.title, rec.frames);
    console.log(`✓ ${gif} (${shots} distinct frames) + ${mp4}`);
  } finally {
    sb.cleanup();
  }
}
process.exit(0);
