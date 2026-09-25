/** The pure parts of the OpenCode-style UI: palette search, hint parsing, colour mixing, animation frames. */
import { describe, expect, test } from "bun:test";
import { PULSE, SPINNER } from "../../src/anim";
import { type Command, filterCommands, matchScore } from "../../src/components/CommandPalette";
import { hintsFrom, hintText } from "../../src/components/Hints";
import { mix } from "../../src/theme";

const command = (title: string, category: string): Command => ({ id: title, title, category, run: () => {} });

describe("palette search", () => {
  test("a match at the start beats one at a word's start, beats one inside, beats letters in order", () => {
    expect(matchScore("mer", "Merge pull request")).toBe(100);
    expect(matchScore("pull", "Merge pull request")).toBe(80);
    expect(matchScore("erge", "Merge pull request")).toBe(60);
    expect(matchScore("mpr", "Merge pull request")).toBe(20);
    expect(matchScore("xyz", "Merge pull request")).toBe(0);
  });

  test("an empty query lists everything, grouped in the order the groups first appear", () => {
    const list = [command("Open", "Worktree"), command("Merge", "Pull request"), command("Close", "Worktree")];
    expect(filterCommands(list, "").map((c) => c.title)).toEqual(["Open", "Close", "Merge"]);
  });

  test("a query keeps the matches, best first; the title counts more than the group", () => {
    const list = [command("Refresh pull requests", "Pull request"), command("Merge pull request", "Pull request")];
    expect(filterCommands(list, "merge").map((c) => c.title)).toEqual(["Merge pull request"]);
    // Both match through their group; the one whose title matches too comes first.
    expect(filterCommands(list, "pull").map((c) => c.title)[0]).toBe("Refresh pull requests");
    expect(filterCommands(list, "zzz")).toEqual([]);
  });
});

describe("hints", () => {
  test("a hint line reads as keys and what they do; keys can be alternatives", () => {
    expect(hintsFrom("↑↓ choose · y / ⏎ confirm · esc cancel")).toEqual([
      { key: "↑↓", text: "choose" },
      { key: "y / ⏎", text: "confirm" },
      { key: "esc", text: "cancel" },
    ]);
    expect(hintsFrom("d close the worktree")).toEqual([{ key: "d", text: "close the worktree" }]);
  });

  test("and reads back the same", () => {
    const line = "⏎ / esc close · r retry";
    expect(hintText(hintsFrom(line))).toBe(line);
  });
});

describe("colours and animation frames", () => {
  test("mix goes from one colour to the other", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#ff0000", "#0000ff", 0.5)).toBe("#800080");
  });

  test("the pulse breathes out and back, never fading the glyph away entirely", () => {
    expect(PULSE[0]).toBe(0);
    expect(Math.max(...PULSE)).toBeLessThan(1);
    expect(PULSE[5]!).toBeGreaterThan(PULSE[0]!);
    expect(PULSE[PULSE.length - 1]!).toBeLessThan(PULSE[PULSE.length / 2]!);
  });

  test("the spinner is one cell wide on every frame", () => {
    for (const frame of SPINNER) expect(Bun.stringWidth(frame)).toBe(1);
  });
});
