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
  const tracking = (on: boolean): Overlay => ({ kind: "tracking", on });
  const add: Overlay = { kind: "add", preselect: null };

  test("opening puts it on top; one of the same kind is replaced, not stacked", () => {
    const s = withOpened(withOpened([add], tracking(true)), tracking(false));
    expect(s).toEqual([add, tracking(false)]);
  });

  test("closing takes the top off, or a given kind wherever it is", () => {
    const s = [add, help, tracking(true)];
    expect(withClosed(s)).toEqual([add, help]);
    expect(withClosed(s, "help")).toEqual([add, tracking(true)]);
    expect(withClosed([])).toEqual([]);
  });
});
