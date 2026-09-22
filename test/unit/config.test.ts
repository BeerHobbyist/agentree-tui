import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  branchLeaf,
  repoDir,
  sanitizeBranchForPath,
  stateFilePath,
  workspaceRoot,
  worktreePath,
} from "../../src/config";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe("sanitizeBranchForPath", () => {
  test("keeps a plain branch name", () => {
    expect(sanitizeBranchForPath("feature")).toBe("feature");
  });

  test("collapses path separators and other unsafe characters", () => {
    expect(sanitizeBranchForPath("feature/new-thing")).toBe("feature-new-thing");
    expect(sanitizeBranchForPath("fix/#42 crash")).toBe("fix-42-crash");
    expect(sanitizeBranchForPath("a//b///c")).toBe("a-b-c");
  });

  test("trims leading and trailing separators", () => {
    expect(sanitizeBranchForPath("/leading")).toBe("leading");
    expect(sanitizeBranchForPath("trailing/")).toBe("trailing");
  });

  test("falls back when nothing survives sanitizing", () => {
    expect(sanitizeBranchForPath("///")).toBe("worktree");
    expect(sanitizeBranchForPath("")).toBe("worktree");
  });

  test("keeps dots and underscores, which are legal in paths", () => {
    expect(sanitizeBranchForPath("release_1.2.x")).toBe("release_1.2.x");
  });
});

describe("branchLeaf", () => {
  test("returns the last segment", () => {
    expect(branchLeaf("feature/x")).toBe("x");
    expect(branchLeaf("a/b/c")).toBe("c");
  });

  test("returns the whole name when there is no slash", () => {
    expect(branchLeaf("main")).toBe("main");
  });

  test("falls back to the input for a trailing slash", () => {
    expect(branchLeaf("feature/")).toBe("feature/");
  });
});

describe("locations", () => {
  test("workspaceRoot honours AGENTREE_HOME", () => {
    process.env.AGENTREE_HOME = "/tmp/elsewhere";
    expect(workspaceRoot()).toBe("/tmp/elsewhere");
  });

  test("workspaceRoot defaults to ~/agentree", () => {
    delete process.env.AGENTREE_HOME;
    expect(workspaceRoot()).toBe(join(homedir(), "agentree"));
  });

  test("stateFilePath is XDG-aware", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/cfg";
    expect(stateFilePath()).toBe("/tmp/cfg/agentree/state.json");
    delete process.env.XDG_CONFIG_HOME;
    expect(stateFilePath()).toBe(join(homedir(), ".config", "agentree", "state.json"));
  });

  test("repoDir sits under the workspace", () => {
    process.env.AGENTREE_HOME = "/tmp/ws";
    expect(repoDir("widget")).toBe("/tmp/ws/widget");
  });

  test("worktreePath sanitizes only the directory, never the branch", () => {
    expect(worktreePath("/repo", "feature/x")).toBe("/repo/.worktrees/feature-x");
  });
});
