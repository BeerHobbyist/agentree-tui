/** The sidebar footer's one line of keys, for what's selected. */
import { describe, expect, test } from "bun:test";
import { footerHint, projectKey, worktreeKey } from "../../src/components/Sidebar";
import type { Project, Worktree } from "../../src/data/model";

const wt = (id: string): Worktree => ({
  id,
  name: id,
  branch: id,
  path: `/r/${id}`,
  dirty: false,
  changed: 0,
  added: 0,
  removed: 0,
  ahead: 0,
  behind: 0,
  agent: "none",
});
const merged: Worktree = { ...wt("done"), pr: { number: 42, title: "t", url: "u", draft: false, merged: true } };
const repo: Project = { id: "acme/widget", name: "widget", root: "/r", worktrees: [wt("main"), wt("x"), merged] };
const host: Project = {
  id: "ssh:dev-box",
  name: "dev-box",
  root: "dev-box",
  ssh: { host: "dev-box" },
  worktrees: [wt("api")],
};

describe("footerHint", () => {
  test("says what you can do with the selected row", () => {
    expect(footerHint([repo], projectKey(repo.id), false)).toBe("⏎ fold · a new worktree · ? keys");
    expect(footerHint([repo], worktreeKey(repo.id, "x"), false)).toBe("⏎ open · a new · d close · ? keys");
    expect(footerHint([repo], worktreeKey(repo.id, "main"), false)).toBe("⏎ open · a new worktree · ? keys");
    expect(footerHint([host], projectKey(host.id), false)).toBe("a add dir · d remove · ? keys");
    expect(footerHint([host], worktreeKey(host.id, "api"), false)).toBe("⏎ open · d remove · ? keys");
  });

  test("a worktree whose PR is merged: closing it comes first", () => {
    expect(footerHint([repo], worktreeKey(repo.id, "done"), false)).toBe("merged: d close · ⏎ open · ? keys");
  });

  test("nothing yet: how to add something", () => {
    expect(footerHint([], "", false)).toBe("n add repo · s add host · ? keys");
  });

  test("an agent waiting comes first", () => {
    expect(footerHint([repo], worktreeKey(repo.id, "x"), true)).toBe("Tab next agent · ⏎ open · ? keys");
    expect(footerHint([repo], projectKey(repo.id), true)).toBe("Tab next agent · ? keys");
  });

  test("short enough for the default sidebar", () => {
    // The default sidebar leaves 33 columns for it.
    for (const [projects, key, waiting] of [
      [[repo], projectKey(repo.id), false],
      [[repo], worktreeKey(repo.id, "x"), false],
      [[repo], worktreeKey(repo.id, "main"), false],
      [[repo], worktreeKey(repo.id, "done"), false],
      [[host], projectKey(host.id), false],
      [[host], worktreeKey(host.id, "api"), false],
      [[repo], worktreeKey(repo.id, "x"), true],
      [[repo], projectKey(repo.id), true],
      [[], "", false],
    ] as [Project[], string, boolean][]) {
      expect(Array.from(footerHint(projects, key, waiting)).length).toBeLessThanOrEqual(33);
    }
  });
});
