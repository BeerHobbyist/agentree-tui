import { useRef, useState } from "react";
import type { ParsedKey } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { ICON } from "../icons";
import { useTheme } from "../theme";
import { Dialog } from "./Dialog";
import { Hints, hintsFrom } from "./Hints";

interface RenameModalProps {
  /** What it's called now (prefilled). */
  initial: string;
  /** The line above the input, e.g. "Label for feature/x". */
  heading: string;
  /** Shown dimmed in an empty input: what saving it empty gives you. */
  placeholder: string;
  /** A sentence under the input about what renaming does and doesn't touch. */
  note: string;
  /** Longest name accepted (in characters). */
  maxLength: number;
  /** Save this name, trimmed; the caller decides what empty means. */
  onSave: (name: string) => void;
  onCancel: () => void;
}

/**
 * A one-line rename prompt (worktree labels, terminal tabs). ⏎ saves, esc /
 * click outside cancels, Ctrl+U clears the line; pasting works.
 *
 * It owns the keyboard while open: every key and paste is consumed, so none
 * leaks to a focused terminal underneath (global key handlers run before the
 * focused renderable).
 */
export function RenameModal({ initial, heading, placeholder, note, maxLength, onSave, onCancel }: RenameModalProps) {
  const theme = useTheme();
  const [value, setValue] = useState(initial);
  // Keys can arrive faster than React re-renders (a paste, key repeat).
  const valueRef = useRef(value);
  const apply = (next: string) => {
    valueRef.current = next;
    setValue(next);
  };
  const append = (text: string) =>
    apply(
      Array.from(valueRef.current + text)
        .slice(0, maxLength)
        .join(""),
    );

  useKeyboard((key) => {
    key.preventDefault();
    key.stopPropagation();
    const current = valueRef.current;
    if (key.name === "return") {
      onSave(current.trim());
    } else if (key.name === "escape") {
      onCancel();
    } else if (key.name === "backspace") {
      apply(Array.from(current).slice(0, -1).join(""));
    } else if (key.ctrl && key.name === "u") {
      apply("");
    } else {
      const typed = typedText(key);
      if (typed) append(typed);
    }
  });

  // A bracketed paste arrives as one event, not as keys. Line breaks and tabs
  // become spaces; other control characters are dropped.
  usePaste((event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = new TextDecoder()
      .decode(event.bytes)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[\u0000-\u001f\u007f]/g, "");
    if (text) append(text);
  });

  return (
    <Dialog title="Rename" icon={ICON.rename} width={58} onClose={onCancel} zIndex={150}>
      <text fg={theme.fgMuted} wrapMode="none" truncate>
        {heading}
      </text>
      <box flexDirection="row" alignItems="center" marginTop={1}>
        <text fg={theme.accent} flexShrink={0}>
          {ICON.prompt + " "}
        </text>
        {value ? (
          <text fg={theme.fg} flexShrink={1} wrapMode="none" truncate>
            {value}
          </text>
        ) : (
          <text fg={theme.fgFaint} flexShrink={1} wrapMode="none" truncate>
            {placeholder}
          </text>
        )}
        <text fg={theme.accent} flexShrink={0}>
          {"▏"}
        </text>
      </box>
      <text fg={theme.fgMuted} marginTop={1} wrapMode="word">
        {note}
      </text>
      <Hints marginTop={1} hints={hintsFrom("⏎ save · esc cancel · ^u clear")} />
    </Dialog>
  );
}

/** What a key typed — a character, or a whole paste — or null for keys that type nothing. */
function typedText(key: ParsedKey): string | null {
  if (key.ctrl || key.meta || key.option) return null;
  const seq = key.sequence ?? "";
  // Control characters (escape sequences, tabs, newlines) aren't label text.
  if (!seq || /[\u0000-\u001f\u007f]/.test(seq)) return null;
  return seq;
}
