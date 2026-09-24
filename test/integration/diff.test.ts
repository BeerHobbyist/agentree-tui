/** Diff viewer commands, run for real by sh against a real repo. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffCommand, viewer } from "../../src/services/diff";
import { commitAll, git, makeRepo, writeFile } from "../helpers/repo";
import { createSandbox, type Sandbox } from "../helpers/sandbox";

let sandbox: Sandbox;
let root: string;

beforeEach(async () => {
  sandbox = createSandbox();
  root = await makeRepo(join(sandbox.workspace, "widget"));
});
afterEach(() => sandbox.cleanup());

/** Run a diff command in the repo, pressing Enter if it waits. (No terminal, so no pager.) */
function runIn(cmd: string): string {
  const out = Bun.spawnSync(["sh", "-c", cmd], { cwd: root, stdin: Buffer.from("\n") });
  return new TextDecoder().decode(out.stdout);
}

describe("opening a diff", () => {
  test("an empty diff says so and waits, instead of the tab flashing shut", () => {
    const out = runIn(diffCommand(viewer("git"), "working"));
    expect(out).toContain("No changes to show.");
    expect(out).toContain("Press Enter to close.");
  });

  test("a diff with changes goes to the viewer", async () => {
    writeFile(root, "README.md", "changed\n");
    expect(runIn(diffCommand(viewer("git"), "working"))).toContain("+changed");
    await git(["add", "README.md"], root);
    expect(runIn(diffCommand(viewer("git"), "working"))).toContain("No changes to show."); // all staged now
    expect(runIn(diffCommand(viewer("git"), "staged"))).toContain("+changed");
  });

  test("vs base: what the branch changed since it left main", async () => {
    await git(["checkout", "-q", "-b", "feature"], root);
    writeFile(root, "new.txt", "feature work\n");
    await commitAll(root, "feature");
    expect(runIn(diffCommand(viewer("git"), "base", "main"))).toContain("+feature work");
  });
});
