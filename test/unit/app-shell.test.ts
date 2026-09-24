/** The app shell's pure pieces: key names, and the pop-up stack. */
import { describe, expect, test } from "bun:test";
import { keyIds } from "../../src/app";
import { withClosed, withOpened, type Overlay } from "../../src/app/overlays";

describe("keyIds", () => {
  const key = (name: string, mods: { ctrl?: boolean; shift?: boolean } = {}) =>
    keyIds({ name, ctrl: !!mods.ctrl, shift: !!mods.shift });

  test("plain keys go by their name", () => {
    expect(key("j")).toEqual(["j"]);
    expect(key("return")).toEqual(["return"]);
  });

  test("Shift+letter is the capital first, then the letter (unbound capitals act as the letter)", () => {
    expect(key("r", { shift: true })).toEqual(["R", "r"]);
    expect(key("?", { shift: true })).toEqual(["?"]); // not a letter
  });

  test("Ctrl+key is C-key first, then the key", () => {
    expect(key("c", { ctrl: true })).toEqual(["C-c", "c"]);
  });
});

describe("the pop-up stack", () => {
  const help: Overlay = { kind: "help" };
  const notice = (message: string): Overlay => ({ kind: "notice", title: "Oops", message });
  const add: Overlay = { kind: "add", preselect: null };

  test("opening puts it on top; one of the same kind is replaced, not stacked", () => {
    const s = withOpened(withOpened([add], notice("a")), notice("b"));
    expect(s).toEqual([add, notice("b")]);
  });

  test("closing takes the top off, or a given kind wherever it is", () => {
    const s = [add, help, notice("x")];
    expect(withClosed(s)).toEqual([add, help]);
    expect(withClosed(s, "help")).toEqual([add, notice("x")]);
    expect(withClosed([])).toEqual([]);
  });
});
