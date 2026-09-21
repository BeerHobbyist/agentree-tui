import { useEffect, useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { theme } from "../theme";
import type { Worktree } from "../data/model";
import {
  attachCommand,
  isAvailable,
  killPane,
  listWindows,
  newWindow,
  selectWindow,
  sessionName,
  splitWindow,
  type WindowInfo,
} from "../services/tmux";
import { useTerminalSession } from "../hooks/useTerminalSession";
import { TabBar } from "./TabBar";
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
  const session = useMemo(
    () => sessionName(repoId, worktree.id),
    [repoId, worktree.id],
  );
  const command = useMemo(
    () =>
      attachCommand(session, worktree.path, {
        bg: theme.bg,
        fg: theme.fg,
        border: theme.border,
        borderActive: theme.accent,
      }),
    [session, worktree.path],
  );
  const { ref, onData, onTerminalResize, status, error } =
    useTerminalSession(command);

  // Route focus to the emulator whenever the app hands it focus.
  useEffect(() => {
    if (status !== "running") return;
    if (focused) ref.current?.focus();
    else ref.current?.blur();
  }, [focused, status, ref]);

  // Poll the session's windows (tabs) so the bar reflects tmux state — our own
  // actions plus native Ctrl+b changes and programs exiting.
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const refreshWindows = () => {
    listWindows(session).then((w) => setWindows(w)).catch(() => {});
  };
  useEffect(() => {
    if (status !== "running") return;
    refreshWindows();
    const id = setInterval(refreshWindows, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, status]);

  // Run a tmux action, then refresh the bar and keep keys on the terminal.
  const act = (fn: () => Promise<void>) => {
    fn()
      .catch(() => {})
      .finally(() => {
        setTimeout(refreshWindows, 60);
        onRequestFocus();
      });
  };

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
      <TabBar
        windows={windows}
        onSelect={(i) => act(() => selectWindow(session, i))}
        onNewTab={() => act(() => newWindow(session, worktree.path))}
        onSplit={(dir) => act(() => splitWindow(session, dir, worktree.path))}
        onClosePane={() => act(() => killPane(session))}
        onExit={onExit}
      />
      {/* No fixed cols/rows: the constructor would pin the layout width to
          `cols`. Let it fill the pane; onResize drives sizing. */}
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
