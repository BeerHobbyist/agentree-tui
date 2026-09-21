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
}: TerminalPaneProps) {
  const command = useMemo(
    () => attachCommand(sessionName(repoId, worktree.id), worktree.path),
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
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM} flexShrink={0}>
          {status === "exited" ? "session ended" : "^g sidebar"}
        </text>
      </box>
      <embedded-terminal
        ref={ref}
        cols={80}
        rows={24}
        maxScrollback={5000}
        onData={onData}
        onTerminalResize={onTerminalResize}
        onMouseDown={onRequestFocus}
        flexGrow={1}
      />
    </box>
  );
}
