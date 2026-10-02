/** Diff viewers: the commands they run, and which one is used. */
import { describe, expect, test } from "bun:test";
import {
  DIFF_VIEWERS,
  availableViewers,
  diffArgs,
  diffCommand,
  nextViewer,
  pickCommits,
  resolveViewer,
  viewer,
} from "../../src/services/diff";
import type { Commit } from "../../src/services/git";

/** What `sh` makes of a command line: its arguments. */
function words(line: string): string[] {
  const out = Bun.spawnSync(["sh", "-c", `set -- ${line}; for a in "$@"; do printf '%s\\n' "$a"; done`]);
  return new TextDecoder().decode(out.stdout).split("\n").slice(0, -1);
}

describe("diffArgs", () => {
  test("each diff choice as git diff arguments", () => {
    expect(diffArgs("working")).toEqual([]);
    expect(diffArgs("staged")).toEqual(["--staged"]);
    expect(diffArgs("base", "origin/main")).toEqual(["origin/main...HEAD"]);
    expect(diffArgs("base")).toEqual(["main...HEAD"]);
    expect(diffArgs("ref", "v1.0..v2.0")).toEqual(["v1.0..v2.0"]);
    expect(diffArgs("ref")).toEqual(["HEAD"]);
  });
});

describe("the viewers' commands", () => {
  test("hunk takes the git diff arguments itself", () => {
    expect(viewer("hunk").command(["--staged"])).toBe("hunk diff --staged");
  });

  test("git-based viewers page with a less that doesn't quit on a short diff — not the user's own pager", () => {
    for (const id of ["git", "difftastic"] as const) {
      const cmd = viewer(id).command(["main...HEAD"]);
      expect(cmd).toContain("LESS=R git ");
      expect(cmd).toContain("core.pager=less -R");
    }
    expect(viewer("delta").command([])).toContain("--paging=always");
  });

  test("diffnav gets the plain diff on stdin", () => {
    expect(viewer("diffnav").command([])).toMatch(/color\.ui=never.* diff \| diffnav$/);
  });

  test("lumen takes the git diff arguments, except staged changes, which open in plain git", () => {
    expect(viewer("lumen").command(["main...HEAD"])).toBe("lumen diff main...HEAD");
    expect(viewer("lumen").command(["--staged"])).toBe(viewer("git").command(["--staged"]));
  });

  test("diffview speaks its own flag for staged changes", () => {
    expect(words(viewer("diffview").command(["--staged"]))).toEqual(["nvim", "-c", "DiffviewOpen --cached"]);
  });

  test("an odd ref stays one argument", () => {
    expect(words(viewer("hunk").command(["it's; rm -rf ~"]))).toEqual(["hunk", "diff", "it's; rm -rf ~"]);
  });

  test("every command runs under sh, with the empty-diff check first", () => {
    for (const v of DIFF_VIEWERS) {
      const [sh, c, script] = words(diffCommand(v, "base", "main"));
      expect([sh, c]).toEqual(["sh", "-c"]);
      expect(script).toContain("if git diff --quiet main...HEAD; then");
    }
  });
});

describe("which viewer", () => {
  const installed =
    (...cmds: string[]) =>
    (cmd: string) =>
      cmds.includes(cmd) ? `/usr/bin/${cmd}` : null;

  test("installed means all its programs are on PATH", () => {
    const prev = process.env.AGENTREE_DIFF_VIEWERS;
    delete process.env.AGENTREE_DIFF_VIEWERS;
    try {
      expect(availableViewers(installed("git", "delta"))).toEqual(["delta", "git"]);
      // diffnav renders with delta, so it needs both.
      expect(availableViewers(installed("git", "diffnav"))).toEqual(["git"]);
      expect(availableViewers(installed("git", "diffnav", "delta", "nvim"))).toEqual([
        "diffnav",
        "delta",
        "diffview",
        "git",
      ]);
    } finally {
      process.env.AGENTREE_DIFF_VIEWERS = prev;
    }
  });

  test("the chosen one if installed, else the first installed automatic one, else git", () => {
    expect(resolveViewer("delta", ["hunk", "delta", "git"]).id).toBe("delta");
    expect(resolveViewer(undefined, ["hunk", "delta", "git"]).id).toBe("hunk");
    expect(resolveViewer("hunk", ["delta", "git"]).id).toBe("delta"); // chosen, then uninstalled
    expect(resolveViewer(undefined, ["diffview", "git"]).id).toBe("git"); // diffview only when chosen
    expect(resolveViewer(undefined, []).id).toBe("git");
  });

  test("v cycles through the installed ones", () => {
    expect(nextViewer("hunk", ["hunk", "delta", "git"])).toBe("delta");
    expect(nextViewer("git", ["hunk", "delta", "git"])).toBe("hunk");
    expect(nextViewer("git", ["git"])).toBe("git");
  });
});

describe("pickCommits", () => {
  // Newest first, as the commit picker lists them; c1 is the repo's first commit.
  const commit = (n: number, parent: string): Commit => ({
    sha: `c${n}`,
    short: `c${n}`,
    subject: `commit ${n}`,
    parent,
  });
  const commits = [commit(4, "c3"), commit(3, "c2"), commit(2, "c1"), commit(1, "EMPTY")];

  test("nothing marked: from the cursor's commit to HEAD", () => {
    expect(pickCommits(commits, 1)).toEqual({ range: "c2..HEAD", label: "c3 → HEAD · 2 commits" });
    expect(pickCommits(commits, 0)).toEqual({ range: "c3..HEAD", label: "c4 → HEAD · 1 commit" });
  });

  test("marked: the commits between the mark and the cursor, both included, either way round", () => {
    expect(pickCommits(commits, 0, "c3")).toEqual({ range: "c2..c4", label: "c3 → c4 · 2 commits" });
    expect(pickCommits(commits, 1, "c4")).toEqual({ range: "c2..c4", label: "c3 → c4 · 2 commits" });
  });

  test("the mark under the cursor: just that commit", () => {
    expect(pickCommits(commits, 2, "c2")).toEqual({ range: "c1..c2", label: "c2 · 1 commit" });
  });

  test("the first commit is diffed against what it has for a parent: the empty tree", () => {
    expect(pickCommits(commits, 3)?.range).toBe("EMPTY..HEAD");
  });

  test("a mark no longer listed is ignored; no commits, nothing to pick", () => {
    expect(pickCommits(commits, 1, "gone")?.range).toBe("c2..HEAD");
    expect(pickCommits([], 0)).toBeNull();
  });
});
