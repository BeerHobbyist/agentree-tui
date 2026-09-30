/** The argv the broker hands tmux for a sandboxed tab, run with a stand-in sandbox (`env`). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxArgv } from "../../src/services/broker";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agentree-sandbox-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Run an argv the way tmux starts a pane: in `cwd`; its output. */
const runIn = (cwd: string, argv: string[]) => Bun.spawnSync(argv, { cwd }).stdout.toString().trim();

describe("sandboxArgv", () => {
  test("runs the whole command line inside the sandbox, not just its first command", () => {
    const argv = sandboxArgv("env INSIDE=yes", ["/bin/sh", "-c", 'echo "a=$INSIDE"; echo "b=$INSIDE"']);
    expect(runIn(root, argv)).toBe("a=yes\nb=yes");
  });

  test("starts the sandbox where the pane starts, and only inside it moves to cwd", () => {
    const sub = join(root, "it's $(touch pwned)");
    mkdirSync(sub);
    const argv = sandboxArgv('env ROOT="$PWD"', ["/bin/sh", "-c", 'echo "$ROOT|$PWD"'], sub);
    expect(runIn(root, argv)).toBe(`${root}|${sub}`);
    expect(existsSync(join(root, "pwned")) || existsSync(join(sub, "pwned"))).toBe(false);
  });
});
