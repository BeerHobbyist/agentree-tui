import { describe, expect, test } from "bun:test";
import { buildRows, rowKey } from "../../src/app";
import { project, worktree } from "../helpers/model";

const projects = [
  project("acme/widget", [worktree("main"), worktree("feat-x")]),
  project("acme/gadget", [worktree("main")]),
];

describe("buildRows", () => {
  test("lists every project header with its worktrees underneath", () => {
    const rows = buildRows(projects, new Set());
    expect(rows.map(rowKey)).toEqual([
      "acme/widget",
      "acme/widget:main",
      "acme/widget:feat-x",
      "acme/gadget",
      "acme/gadget:main",
    ]);
  });

  test("a collapsed project contributes only its header", () => {
    const rows = buildRows(projects, new Set(["acme/widget"]));
    expect(rows.map(rowKey)).toEqual(["acme/widget", "acme/gadget", "acme/gadget:main"]);
  });

  test("every row carries its project, so `a` works on worktree rows too", () => {
    const rows = buildRows(projects, new Set());
    expect(rows[2]!.project.id).toBe("acme/widget");
  });

  test("a project with no worktrees still gets a header", () => {
    expect(buildRows([project("acme/empty")], new Set())).toHaveLength(1);
  });

  test("no projects means no rows", () => {
    expect(buildRows([], new Set())).toEqual([]);
  });
});
