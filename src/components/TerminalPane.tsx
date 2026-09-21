import { useEffect, useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { theme } from "../theme";
import type { Worktree } from "../data/model";
import { attachCommand, isAvailable, sessionName } from "../services/tmux";
import { useTerminalSession } from "../hooks/useTerminalSession";
import "./EmbeddedTerminal"; // registers <embedded-terminal>

interface TerminalPaneProps {
  repoId: string;
  worktree: Worktree;
  /** Whether the terminal should hold keyboard focus. */
  focused: boolean;
  /** Called when the pane is clicked, so the app can switch focus to it. */
  onRequestFocus: () => void;
  /** Called to hand focus back to the sidebar (back button / Ctrl+g). */
  onExit: () => void;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <box
      flexGrow={1}
      flexDirection="column"
      backgroundColor={theme.bg}
      alignItems="center"
      justifyContent="center"
    >
      {children}
    </box>
  );
}

export function TerminalPane(props: TerminalPaneProps) {
  const [tmuxOk, setTmuxOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    isAvailable().then((ok) => {
      if (alive) setTmuxOk(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (tmuxOk === null) {
    return (
      <Centered>
        <text fg={theme.fgMuted}>{"Starting…"}</text>
      </Centered>
    );
  }
  if (!tmuxOk) {
    return (
      <Centered>
        <text fg={theme.dirty}>{"tmux not found"}</text>
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM}>
          {"Install it to use terminals:  sudo pacman -S tmux"}
        </text>
      </Centered>
    );
  }
  // Remount the view (and its PTY) when the worktree changes.
  return <TerminalView key={props.repoId + ":" + props.worktree.id} {...props} />;
}

function TerminalView({
  repoId,
  worktree,
  focused,
  onRequestFocus,
  onExit,
}: TerminalPaneProps) {
  const command = useMemo(
    () =>
      attachCommand(sessionName(repoId, worktree.id), worktree.path, {
        bg: theme.bg,
        fg: theme.fg,
      }),
    [repoId, worktree.id, worktree.path],
  );
  const { ref, onData, onTerminalResize, status, error } =
    useTerminalSession(command);

  // Route focus to the emulator whenever the app hands it focus.
  useEffect(() => {
    if (status !== "running") return;
    if (focused) ref.current?.focus();
    else ref.current?.blur();
  }, [focused, status, ref]);

  if (status === "error") {
    return (
      <Centered>
        <text fg={theme.dirty}>{"Could not start terminal"}</text>
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM}>
          {error ?? ""}
        </text>
      </Centered>
    );
  }

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={theme.bg}>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={focused ? theme.activeBg : theme.panel}
      >
        <text fg={focused ? theme.accent : theme.fgFaint} flexShrink={0}>
          {focused ? "● " : "○ "}
        </text>
        <text fg={theme.fg} flexGrow={1} wrapMode="none" truncate>
          {worktree.branch}
        </text>
        {/* Clickable back-to-sidebar button (also bound to Ctrl+g). */}
        <text
          fg={theme.accent}
          flexShrink={0}
          onMouseDown={onExit}
        >
          {status === "exited" ? " session ended " : " ‹ sidebar (^g) "}
        </text>
      </box>
      {/* No fixed cols/rows: the constructor would pin the layout width to
          `cols`. Let it fill the pane; onScreenChange/onResize drive sizing. */}
      <embedded-terminal
        ref={ref}
        maxScrollback={5000}
        onData={onData}
        onTerminalResize={onTerminalResize}
        onMouseDown={onRequestFocus}
        flexGrow={1}
        width="100%"
        minWidth={0}
      />
    </box>
  );
}
