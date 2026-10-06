/** Diff viewer commands, run for real by sh against a real repo. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffCommand, pickCommits, viewer } from "../../src/services/diff";
import { branchCommits } from "../../src/services/git";
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

  test("picked commits: only their changes", async () => {
    await git(["checkout", "-q", "-b", "feature"], root);
    for (const n of [1, 2, 3]) {
      writeFile(root, `f${n}.txt`, `change ${n}\n`);
      await commitAll(root, `feature ${n}`);
    }
    const commits = await branchCommits(root, "main"); // feature 3, 2, 1
    const out = runIn(diffCommand(viewer("git"), "ref", pickCommits(commits, 1, commits[2]!.sha)!.range));
    expect(out).toContain("+change 1");
    expect(out).toContain("+change 2");
    expect(out).not.toContain("+change 3");
  });

  test("picked from the first commit: everything since the repo began", async () => {
    writeFile(root, "later.txt", "later\n");
    await commitAll(root, "later");
    const commits = await branchCommits(root, "main"); // later, init
    const out = runIn(diffCommand(viewer("git"), "ref", pickCommits(commits, 1)!.range));
    expect(out).toContain("+# fixture");
    expect(out).toContain("+later");
  });
});
