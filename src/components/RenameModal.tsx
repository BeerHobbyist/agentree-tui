import { useRef, useState } from "react";
import { TextAttributes, type ParsedKey } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { useTheme } from "../theme";
import { MAX_LABEL_LENGTH } from "../store";

interface RenameModalProps {
  /** The label it has now (prefilled), or its name when it has none. */
  initial: string;
  /** What it's called without a label — the branch's leaf name. */
  fallback: string;
  /** The full branch, shown for reference. */
  branch: string;
  /** Save this label; blank (or the fallback) clears it. */
  onSave: (label: string) => void;
  onCancel: () => void;
}

/**
 * Give a worktree a label for the sidebar. Only the label changes: the branch
 * and the worktree's directory keep their names. ⏎ saves, esc / click outside
 * cancels, Ctrl+U clears the line; pasting works.
 */
export function RenameModal({ initial, fallback, branch, onSave, onCancel }: RenameModalProps) {
  const theme = useTheme();
  const [value, setValue] = useState(initial);
  // Keys can arrive faster than React re-renders (a paste, key repeat).
  const valueRef = useRef(value);
  const apply = (next: string) => {
    valueRef.current = next;
    setValue(next);
  };
  const append = (text: string) =>
    apply(Array.from(valueRef.current + text).slice(0, MAX_LABEL_LENGTH).join(""));

  useKeyboard((key) => {
    const current = valueRef.current;
    if (key.name === "return") {
      const label = current.trim();
      onSave(label === fallback ? "" : label);
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
    const text = new TextDecoder()
      .decode(event.bytes)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[\u0000-\u001f\u007f]/g, "");
    if (text) append(text);
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={150}
      alignItems="center"
      justifyContent="center"
      shouldFill={false}
      onMouseDown={onCancel}
    >
      <box
        width={54}
        borderStyle="rounded"
        border
        borderColor={theme.accent}
        backgroundColor={theme.panel}
        title=" Rename "
        titleAlignment="center"
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <text fg={theme.fgMuted} wrapMode="none" truncate>
          {`Label for ${branch}`}
        </text>
        <box flexDirection="row" alignItems="center" marginTop={1}>
          <text fg={theme.accent} flexShrink={0}>
            {"❯ "}
          </text>
          {value ? (
            <text fg={theme.fg} flexShrink={1} wrapMode="none" truncate>
              {value}
            </text>
          ) : (
            <text fg={theme.fgFaint} attributes={TextAttributes.DIM} flexShrink={1} wrapMode="none" truncate>
              {fallback}
            </text>
          )}
          <text fg={theme.accent} flexShrink={0}>
            {"▏"}
          </text>
        </box>
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM} marginTop={1} wrapMode="word">
          {"Only the label changes — the branch and folder keep their names. Empty goes back to the branch name."}
        </text>
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM} marginTop={1}>
          {"⏎ save · esc cancel · ^u clear"}
        </text>
      </box>
    </box>
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
