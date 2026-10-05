import { useTerminalDimensions } from "@opentui/react";
import { pickCommits } from "../services/diff";
import type { Commit } from "../services/git";
import { useTheme } from "../theme";
import { Dialog, rowLook } from "./Dialog";
import { Hints, hintsFrom } from "./Hints";

interface CommitPickerProps {
  title: string;
  /** Newest first; undefined while they're read. */
  commits: Commit[] | undefined;
  /** The row under the cursor (keyboard). */
  cursor: number;
  /** The marked commit's sha: one end of the range. */
  mark: string | null;
  /** A row clicked: diff up to it, as ⏎ there would. */
  onPick: (i: number) => void;
  onClose: () => void;
}

/**
 * The diff picker's commit list, à la `git rebase -i`: ⏎ diffs from the
 * cursor's commit to HEAD, or between it and the marked one. It scrolls to
 * keep the cursor in view; the parent drives the keyboard.
 */
export function CommitPicker({ title, commits, cursor, mark, onPick, onClose }: CommitPickerProps) {
  const theme = useTheme();
  const { height } = useTerminalDimensions();
  const top = Math.max(1, Math.floor(height / 4));
  const list = commits ?? [];
  // What the dialog has room for besides its title, padding and footer.
  const rows = Math.max(3, Math.min(list.length, 20, height - top - 9));
  const first = Math.max(0, Math.min(cursor - Math.floor(rows / 2), list.length - rows));
  const pick = pickCommits(list, cursor, mark);
  const m = mark ? list.findIndex((c) => c.sha === mark) : -1;
  // The rows the diff takes in: up to HEAD with nothing marked.
  const [from, to] = m < 0 ? [0, cursor] : [Math.min(m, cursor), Math.max(m, cursor)];

  return (
    <Dialog title={title} width={72} top={top} onClose={onClose} zIndex={150}>
      {commits === undefined ? (
        <text fg={theme.fgMuted}>{"Reading commits…"}</text>
      ) : list.length === 0 ? (
        <text fg={theme.fgMuted}>{"No commits to pick from."}</text>
      ) : (
        list.slice(first, first + rows).map((c, k) => {
          const i = first + k;
          const look = rowLook(theme, i === cursor);
          const gutter = i === m ? "●" : i >= from && i <= to ? "│" : " ";
          return (
            <box key={c.sha} flexDirection="row" backgroundColor={look.bg} onMouseDown={() => onPick(i)}>
              <text fg={look.marker} flexShrink={0}>
                {i === cursor ? " ▶" : "  "}
              </text>
              <text fg={i === cursor ? look.fg : theme.accent} flexShrink={0}>
                {` ${gutter} `}
              </text>
              <text fg={look.muted} flexShrink={0}>
                {`${c.short}  `}
              </text>
              <text
                fg={look.fg}
                attributes={look.bold}
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                wrapMode="none"
                truncate
              >
                {c.subject}
              </text>
            </box>
          );
        })
      )}
      {pick && (
        <text fg={theme.accent} marginTop={1} wrapMode="none" truncate>
          {pick.label}
        </text>
      )}
      <Hints marginTop={1} hints={hintsFrom("↑↓ move · space mark · ⏎ diff · esc back")} />
    </Dialog>
  );
}
