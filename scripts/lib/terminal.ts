/**
 * A camera for the app's screen: frames captured from the test renderer are
 * replayed as ANSI into xterm.js (the terminal emulator VS Code uses, WebGL
 * renderer) in headless Chrome, inside a terminal-window frame, and
 * photographed. Used for the README's screenshots and the demo recordings.
 *
 * Why a real emulator rather than HTML text: a terminal keeps every glyph in
 * its cell (symbols from fallback fonts included), fills each cell's
 * background edge to edge, and draws box-drawing lines itself so they join up.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";
import { getTheme } from "../../src/theme";
import type { RenderedApp } from "../../test/helpers/app";

/** What the harness captures: every line's spans of text, with colours and attributes. */
export type Frame = ReturnType<RenderedApp["captureSpans"]>;
type Rgba = Frame["lines"][number]["spans"][number]["fg"];

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
export function toAnsi(frame: Frame): string {
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

function pageHtml(cols: number, rows: number): string {
  const theme = getTheme();
  const options = {
    cols,
    rows,
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
  .stage{display:inline-block;padding:44px 44px 56px}
  .win{border-radius:12px;overflow:hidden;background:${theme.bg};border:1px solid #2a2f3a;
       box-shadow:0 24px 60px rgba(0,0,0,.55)}
  .bar{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#1b1f27;
       font:500 13px -apple-system,"Inter","Segoe UI",sans-serif;color:#8b93a1;position:relative}
  .dot{width:12px;height:12px;border-radius:50%}
  .title{position:absolute;left:0;right:0;text-align:center;pointer-events:none}
  #term{padding:10px 12px}
  </style><div class="stage"><div class="win"><div class="bar">
  <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>
  <span class="dot" style="background:#28c840"></span><span class="title" id="title"></span></div>
  <div id="term"></div></div></div>
  <script src="xterm.js"></script><script src="addon-webgl.js"></script><script>
  const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // The font has to be loaded before xterm measures its cells.
  window.ready = document.fonts.load('14px "Hack"').then(() => {
    const term = new Terminal(${JSON.stringify(options)});
    term.open(document.getElementById("term"));
    term.loadAddon(new WebglAddon.WebglAddon());
    window.show = (ansi, title) => new Promise((resolve) => {
      document.getElementById("title").textContent = title;
      term.reset();
      term.write(ansi, () => paint().then(resolve));
    });
  });
  </script>`;
}

function chrome(): string {
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    const path = Bun.which(name);
    if (path) return path;
  }
  throw new Error("this needs Chrome or Chromium");
}

const xtermFiles = {
  "xterm.js": require.resolve("@xterm/xterm/lib/xterm.js"),
  "xterm.css": require.resolve("@xterm/xterm/css/xterm.css"),
  "addon-webgl.js": require.resolve("@xterm/addon-webgl/lib/addon-webgl.js"),
};

export interface Camera {
  /** Photograph one frame, in a window titled `title`, to `png`. */
  shoot(frame: Frame, title: string, png: string): Promise<void>;
  close(): Promise<void>;
}

/** A headless Chrome page holding a `cols`×`rows` xterm, at `scale`× pixel density. */
export async function openCamera(cols: number, rows: number, scale = 2): Promise<Camera> {
  const dir = mkdtempSync(join(tmpdir(), "agentree-camera-"));
  for (const [name, from] of Object.entries(xtermFiles)) copyFileSync(from, join(dir, name));
  writeFileSync(join(dir, "page.html"), pageHtml(cols, rows));
  const browser: Browser = await puppeteer.launch({
    executablePath: chrome(),
    headless: true,
    // The pixel density is Chrome's own, not puppeteer's emulated one — xterm's
    // WebGL renderer draws at the wrong size under emulation.
    defaultViewport: null,
    args: [
      "--use-angle=swiftshader", // WebGL without a GPU
      "--enable-unsafe-swiftshader",
      "--hide-scrollbars",
      `--force-device-scale-factor=${scale}`,
      "--window-size=2400,1400",
    ],
  });
  const page: Page = await browser.newPage();
  await page.goto(`file://${join(dir, "page.html")}`);
  await page.evaluate(() => (window as unknown as { ready: Promise<void> }).ready);
  const stage = (await page.$(".stage")) as ElementHandle<Element>;
  return {
    async shoot(frame, title, png) {
      await page.evaluate(
        (ansi, t) => (window as unknown as { show(a: string, t: string): Promise<void> }).show(ansi, t),
        toAnsi(frame),
        title,
      );
      await stage.screenshot({ path: png as `${string}.png` });
    },
    async close() {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
