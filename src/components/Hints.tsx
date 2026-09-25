/**
 * A line of key hints in OpenCode's style: each key bright, what it does
 * muted, `·` between them.
 */
import { useTheme } from "../theme";

/** One hint: a key and what it does — or, without a key, a note. */
export interface Hint {
  key?: string;
  text: string;
}

/**
 * Hints written as text — "↑↓ choose · y / ⏎ confirm · esc cancel" — as
 * pairs: in each, the keys (one, or several joined by " / ") and what they do.
 */
export function hintsFrom(text: string): Hint[] {
  return text.split(" · ").map((part) => {
    const m = /^((?:\S+ \/ )*\S+) (.+)$/.exec(part);
    return m ? { key: m[1], text: m[2]! } : { text: part };
  });
}

/** The hints as plain text, as they read on screen. */
export function hintText(hints: readonly Hint[]): string {
  return hints.map((h) => (h.key ? `${h.key} ${h.text}` : h.text)).join(" · ");
}

export function Hints({ hints, marginTop }: { hints: readonly Hint[]; marginTop?: number }) {
  const theme = useTheme();
  return (
    <text wrapMode="none" truncate marginTop={marginTop} flexShrink={1} minWidth={0}>
      {hints.flatMap((h, i) => {
        const id = `${h.key ?? ""}:${h.text}`;
        return [
          i > 0 ? (
            <span key={`sep ${id}`} fg={theme.fgFaint}>
              {" · "}
            </span>
          ) : null,
          h.key ? (
            <span key={`key ${id}`} fg={theme.fg}>
              {`${h.key} `}
            </span>
          ) : null,
          <span key={`text ${id}`} fg={theme.fgMuted}>
            {h.text}
          </span>,
        ];
      })}
    </text>
  );
}
