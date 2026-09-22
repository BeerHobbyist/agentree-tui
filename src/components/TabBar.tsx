import { TextAttributes } from "@opentui/core";
import { useTheme } from "../theme";
import type { WindowInfo } from "../services/tmux";

interface TabBarProps {
  windows: WindowInfo[];
  onSelect: (index: number) => void;
  onNewTab: () => void;
  onCloseTab: (index: number) => void;
  onSplit: (dir: "h" | "v") => void;
  onClosePane: () => void;
  onExit: () => void;
  /** False when this is the only pane in the only tab — closing it would kill the session. */
  canClosePane: boolean;
}

/**
 * App-styled bar above the embedded terminal. Tabs = tmux windows; the split /
 * close buttons drive tmux panes. All controls are mouse (onMouseDown) so they
 * never conflict with keys going to the focused terminal.
 */
export function TabBar({
  windows,
  onSelect,
  onNewTab,
  onCloseTab,
  onSplit,
  onClosePane,
  onExit,
  canClosePane,
}: TabBarProps) {
  const theme = useTheme();
  return (
    <box
      flexDirection="row"
      alignItems="center"
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Back to sidebar */}
      <text fg={theme.accent} flexShrink={0} onMouseDown={onExit}>
        {"‹ "}
      </text>

      {/* Tabs (each its own click target) */}
      <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        {windows.map((w) => (
          <box
            key={String(w.index)}
            flexDirection="row"
            flexShrink={0}
            backgroundColor={w.active ? theme.activeBg : theme.panel}
          >
            <text
              fg={w.active ? theme.fg : theme.fgMuted}
              attributes={w.active ? TextAttributes.BOLD : undefined}
              onMouseDown={() => onSelect(w.index)}
            >
              {` ${w.active ? "●" : "○"} ${w.name}${w.panes > 1 ? ` ⑂${w.panes}` : ""} `}
            </text>
            {/* Per-tab close button (delete this window). Hidden for the last
                remaining tab: tmux can't have a session with zero windows, so
                closing it would kill the session and strand the pane. */}
            {windows.length > 1 && (
              <text
                fg={w.active ? theme.removed : theme.fgFaint}
                onMouseDown={() => onCloseTab(w.index)}
              >
                {"× "}
              </text>
            )}
          </box>
        ))}
        <text fg={theme.accent} flexShrink={0} onMouseDown={onNewTab}>
          {" ＋"}
        </text>
      </box>

      {/* Pane toolbar */}
      <text fg={theme.fgMuted} flexShrink={0} onMouseDown={() => onSplit("h")}>
        {"  ⬌"}
      </text>
      <text fg={theme.fgMuted} flexShrink={0} onMouseDown={() => onSplit("v")}>
        {" ⬍"}
      </text>
      <text
        fg={canClosePane ? theme.removed : theme.fgFaint}
        flexShrink={0}
        onMouseDown={canClosePane ? onClosePane : undefined}
      >
        {"  ✕"}
      </text>
      <text
        fg={theme.fgFaint}
        attributes={TextAttributes.DIM}
        flexShrink={1}
        minWidth={0}
        wrapMode="none"
        truncate
      >
        {"  ⌥t tab · ⌥d diff · ⌥w pane · ⌥hjkl pane · ^g sidebar"}
      </text>
    </box>
  );
}
