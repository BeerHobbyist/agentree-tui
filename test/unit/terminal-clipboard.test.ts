import { describe, expect, test } from "bun:test";
import { clipboardWrites } from "../../src/components/EmbeddedTerminal";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("clipboardWrites", () => {
  test("reads what OSC 52 puts on the clipboard, ended by BEL or ST", () => {
    expect(clipboardWrites(`\x1b]52;c;${b64("hello")}\x07`)).toEqual({ texts: ["hello"], rest: "" });
    expect(clipboardWrites(`\x1b]52;;${b64("héllo ✓")}\x1b\\`)).toEqual({ texts: ["héllo ✓"], rest: "" });
  });

  test("finds every one among other output", () => {
    const text = `$ ls\r\n\x1b[1mfoo\x1b[0m\x1b]52;c;${b64("a")}\x07bar\x1b]52;p;${b64("b")}\x07`;
    expect(clipboardWrites(text).texts).toEqual(["a", "b"]);
  });

  test("ignores a clipboard query and other OSCs", () => {
    expect(clipboardWrites("\x1b]52;c;?\x07").texts).toEqual([]);
    expect(clipboardWrites("\x1b]0;title\x07\x1b]11;#000000\x1b\\").texts).toEqual([]);
  });

  test("hands back one cut off at the end of a chunk, to finish with the next", () => {
    const whole = `\x1b]52;c;${b64("split")}\x1b\\`;
    for (let cut = 1; cut < whole.length; cut++) {
      const first = clipboardWrites(`out${whole.slice(0, cut)}`);
      expect(first.texts).toEqual([]);
      expect(first.rest).toBe(whole.slice(0, cut));
      expect(clipboardWrites(first.rest + whole.slice(cut)).texts).toEqual(["split"]);
    }
  });

  test("hands back nothing when a chunk ends outside one", () => {
    expect(clipboardWrites("plain output").rest).toBe("");
    expect(clipboardWrites(`\x1b]52;c;${b64("x")}\x07`).rest).toBe("");
    expect(clipboardWrites("\x1b[0m").rest).toBe("");
    expect(clipboardWrites("\x1b]0;title").rest).toBe("");
  });
});
