import { describe, expect, test } from "bun:test";
import { diffCommand } from "../../src/services/hunk";

describe("diffCommand", () => {
  test("working changes are hunk's default", () => {
    expect(diffCommand("working")).toBe("hunk diff");
  });

  test("staged uses --staged", () => {
    expect(diffCommand("staged")).toBe("hunk diff --staged");
  });

  test("base diffs the merge base against HEAD", () => {
    expect(diffCommand("base", "origin/main")).toBe("hunk diff origin/main...HEAD");
  });

  test("base falls back to main when the base ref is unknown", () => {
    expect(diffCommand("base")).toBe("hunk diff main...HEAD");
  });

  test("ref passes the argument through, including ranges", () => {
    expect(diffCommand("ref", "abc123")).toBe("hunk diff abc123");
    expect(diffCommand("ref", "v1.0..v2.0")).toBe("hunk diff v1.0..v2.0");
  });

  test("ref falls back to HEAD when nothing was typed", () => {
    expect(diffCommand("ref")).toBe("hunk diff HEAD");
  });
});
