import { describe, expect, test } from "bun:test";
import { lastCursorStyleRequest } from "../../src/components/EmbeddedTerminal";

describe("lastCursorStyleRequest", () => {
  test("is undefined when the child never asks for a cursor shape", () => {
    expect(lastCursorStyleRequest("$ ls\r\nfoo  bar\r\n$ ")).toBeUndefined();
  });

  test("reads an explicit shape (nvim's steady block, a blinking bar)", () => {
    expect(lastCursorStyleRequest("\x1b[2 q")).toBe(2);
    expect(lastCursorStyleRequest("text\x1b[5 qmore")).toBe(5);
  });

  test("treats Ps 0 and an empty Ps as 'terminal default'", () => {
    expect(lastCursorStyleRequest("\x1b[0 q")).toBe(0);
    expect(lastCursorStyleRequest("\x1b[ q")).toBe(0);
  });

  test("the last request in a chunk wins", () => {
    // e.g. nvim sets a block, then resets to default on exit.
    expect(lastCursorStyleRequest("\x1b[2 q…\x1b[0 q")).toBe(0);
    expect(lastCursorStyleRequest("\x1b[0 q…\x1b[6 q")).toBe(6);
  });

  test("ignores look-alikes that aren't DECSCUSR", () => {
    expect(lastCursorStyleRequest("\x1b[2q")).toBeUndefined(); // no space → not DECSCUSR
    expect(lastCursorStyleRequest("\x1b[2 J")).toBeUndefined();
  });
});
