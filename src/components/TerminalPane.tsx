import { useEffect, useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme";
import type { Worktree } from "../data/model";
import {
  attachCommand,
  sessionName,
  tmuxInstallHint,
  tmuxOn,
  MAX_TAB_NAME_LENGTH,
  type WindowInfo,
} from "../services/tmux";
import { diffCommand, nextViewer, resolveViewer, viewer, type DiffTarget, type DiffViewerId } from "../services/diff";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { baseRefQuery, diffViewersQuery, queryKeys, tmuxAvailableQuery, tmuxWindowsQuery } from "../queries";
import { useTerminalSession } from "../hooks/useTerminalSession";
import { agentLaunchCommand, agentSessionEnv, remoteSessionEnv } from "../services/agents";
import { remoteAgentCommand } from "../config";
import { TabBar } from "./TabBar";
import { MenuOverlay, type MenuItem } from "./MenuOverlay";
import { RenameModal } from "./RenameModal";
import "./EmbeddedTerminal"; // registers <embedded-terminal>

const MENU_ITEMS: MenuItem[] = [
  { label: "＋ New shell", hint: "" },
  { label: "✻ New agent", hint: "⌥a" },
  { label: "◨ New diff", hint: "⌥d" },
];
/** An SSH directory has no git features, so no diff viewer. */
const REMOTE_MENU_ITEMS = MENU_ITEMS.slice(0, 2);
const DIFF_ITEMS: MenuItem[] = [
  { label: "Working changes", hint: "uncommitted" },
  { label: "Staged", hint: "index" },
  { label: "vs base branch", hint: "<base>...HEAD" },
  { label: "Specific ref / commit…", hint: "type a ref or range" },
];
const DIFF_TARGETS: DiffTarget[] = ["working", "staged", "base", "ref"];

interface TerminalPaneProps {
  repoId: string;
  worktree: Worktree;
  /**
   * Whether this pane is the visible one. Hidden panes stay mounted (keeping
   * their PTY/tmux attach alive) so switching back doesn't re-attach and flash;
   * they're display:none, so they take no layout space.
   */
  visible: boolean;
  /** Whether the terminal should hold keyboard focus. */
  focused: boolean;
  /** Called when the pane is clicked, so the app can switch focus to it. */
  onRequestFocus: () => void;
  /** Called to hand focus back to the sidebar (back button / Ctrl+g). */
  onExit: () => void;
  /** Whether the PR panel is showing (the tab bar's PR button reflects it). */
  prPanelShown?: boolean;
  /** Show / hide the PR panel (⌥p, or the tab bar's PR button). */
  onTogglePrPanel?: () => void;
  /** The diff viewer picked in the diff picker (`v`); unset = the first installed. */
  diffViewer?: DiffViewerId;
  onDiffViewer?: (id: DiffViewerId) => void;
  /** ⌥n: go to the next agent that needs you. */
  onJumpNext?: () => void;
}

function Centered({ visible = true, children }: { visible?: boolean; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <box
      visible={visible}
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
  const theme = useTheme();
  // A local terminal is a tmux session on this machine, so it needs tmux here.
  // An SSH directory's runs tmux on the host (checked when it was added) and
  // only needs ssh here. Checked once for the whole app.
  const local = !props.worktree.host;
  const tmuxOk = useQuery({ ...tmuxAvailableQuery(), enabled: local }).data ?? null;

  if (local && tmuxOk === null) {
    return (
      <Centered visible={props.visible}>
        <text fg={theme.fgMuted}>{"Starting…"}</text>
      </Centered>
    );
  }
  if (local && !tmuxOk) {
    return (
      <Centered visible={props.visible}>
        <text fg={theme.dirty}>{"tmux not found"}</text>
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM}>
          {`Install it to use terminals:  ${tmuxInstallHint()}`}
        </text>
      </Centered>
    );
  }
  // Keep the view mounted across worktree switches — useTerminalSession
  // already tears down and re-spawns the PTY when `command` changes.
  // Remounting here would also destroy and recreate the embedded-terminal
  // renderable, which briefly flashes black before the new PTY's first frame.
  return <TerminalView {...props} />;
}

function TerminalView({
  repoId,
  worktree,
  visible,
  focused,
  onRequestFocus,
  onExit,
  prPanelShown = false,
  onTogglePrPanel,
  diffViewer,
  onDiffViewer,
  onJumpNext,
}: TerminalPaneProps) {
  const theme = useTheme();
  const session = useMemo(() => sessionName(repoId, worktree.id), [repoId, worktree.id]);
  // An SSH project's directory: tmux (and everything in it) runs on the host.
  const host = worktree.host;
  // A password host: talk to it only over the connection its terminal opened.
  const onlyIfConnected = !!worktree.hostNeedsPassword;
  const tmux = useMemo(() => tmuxOn(host, { onlyIfConnected }), [host, onlyIfConnected]);
  const menuItems = host ? REMOTE_MENU_ITEMS : MENU_ITEMS;
  // Initial attach applies the theme once; theme changes are re-applied live
  // via applyTheme below (not by rebuilding the command, which would re-spawn).
  const command = useMemo(
    () =>
      attachCommand(
        session,
        worktree.path,
        {
          bg: theme.bg,
          fg: theme.fg,
          border: theme.border,
          borderActive: theme.accent,
        },
        // A remote directory starts a plain shell (the agent's hooks file is on
        // this machine); its session tells a claude started there — with
        // tracking on — where on the host to report.
        host ? undefined : agentLaunchCommand(),
        host ? (worktree.hostHome ? remoteSessionEnv(session, worktree.hostHome) : {}) : agentSessionEnv(session),
        host,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, worktree.path, host, worktree.hostHome],
  );
  const { ref, onData, onTerminalResize, status, error } = useTerminalSession(command);

  // Route focus to the emulator whenever the app hands it focus.
  useEffect(() => {
    if (status !== "running") return;
    if (focused) ref.current?.focus();
    else ref.current?.blur();
  }, [focused, status, ref]);

  // Live re-theme: re-apply tmux styling (global) when the theme changes.
  useEffect(() => {
    if (status !== "running") return;
    tmux
      .applyTheme({
        bg: theme.bg,
        fg: theme.fg,
        border: theme.border,
        borderActive: theme.accent,
      })
      .catch(() => {});
  }, [theme, status, tmux]);

  // The session's windows (tabs), so the bar reflects tmux state — our own
  // actions plus native Ctrl+b changes and programs exiting. Polled only while
  // this terminal is on screen (hidden ones stay mounted); the last answer is
  // kept across a refetch so the bar never blanks.
  const queryClient = useQueryClient();
  const windowsQuery = useQuery({
    ...tmuxWindowsQuery(session, host, onlyIfConnected),
    enabled: status === "running" && visible,
    placeholderData: keepPreviousData,
  });
  const windows: WindowInfo[] = windowsQuery.data ?? [];
  const refreshWindows = () => void queryClient.invalidateQueries({ queryKey: queryKeys.tmuxWindows(session) });

  // A session always needs at least one window with at least one pane; closing
  // the last pane of the last tab would kill the tmux session out from under
  // the attached PTY, leaving no way to open a new terminal for this worktree.
  const activeWindow = windows.find((w) => w.active);
  const canClosePane = windows.length > 1 || (activeWindow?.panes ?? 1) > 1;

  // Run a tmux action, then refresh the bar and keep keys on the terminal.
  const act = (fn: () => Promise<void>) => {
    fn()
      .catch(() => {})
      .finally(() => {
        refreshWindows();
        onRequestFocus();
      });
  };

  // ＋ menu / diff picker / tab rename overlay.
  const [overlay, setOverlay] = useState<"none" | "menu" | "diff" | "diffInput" | "rename">("none");
  const [menuIndex, setMenuIndex] = useState(0);
  const [refInput, setRefInput] = useState("");
  /** The tab being renamed. */
  const [renameTab, setRenameTab] = useState<WindowInfo | null>(null);

  // The view stays mounted across worktree switches (see TerminalPane), so
  // session-scoped UI state must be reset by hand instead of by remounting.
  // (`windows` keeps its previous answer until the new session's arrives —
  // blanking the tab bar on a switch reads as a glitch.)
  useEffect(() => {
    setOverlay("none");
    setMenuIndex(0);
    setRefInput("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  // The installed diff viewers, and the one a diff opens in.
  const viewers = useQuery(diffViewersQuery()).data ?? [];
  const diffIn = resolveViewer(diffViewer, viewers);

  const openMenu = () => {
    setOverlay("menu");
    setMenuIndex(0);
  };
  const openDiffPicker = () => {
    if (host) return; // no git over ssh
    setOverlay("diff");
    setMenuIndex(0);
  };
  const closeOverlay = () => {
    setOverlay("none");
    onRequestFocus();
  };
  const openDiff = (target: DiffTarget, arg?: string) => {
    act(async () => {
      const resolved =
        arg ?? (target === "base" ? await queryClient.fetchQuery(baseRefQuery(worktree.path)) : undefined);
      await tmux.newWindowCmd(session, worktree.path, diffCommand(diffIn, target, resolved), "diff");
    });
  };
  const openAgent = () => {
    const command = host ? remoteAgentCommand() : agentLaunchCommand();
    act(() => tmux.newWindowCmd(session, worktree.path, command, "agent"));
  };
  const pickOverlay = (i: number) => {
    if (overlay === "menu") {
      if (i === 0) {
        act(() => tmux.newWindow(session, worktree.path));
        closeOverlay();
      } else if (i === 1) {
        openAgent();
        closeOverlay();
      } else {
        openDiffPicker();
      }
    } else if (overlay === "diff") {
      const t = DIFF_TARGETS[i];
      if (t === "ref") {
        setRefInput("");
        setOverlay("diffInput");
      } else if (t) {
        openDiff(t);
        closeOverlay();
      }
    }
  };
  /** Rename a tab (⌥r, or right-click it). Keys go to the prompt, not the shell. */
  const openRename = (index: number) => {
    const tab = windows.find((w) => w.index === index);
    if (!tab) return;
    onRequestFocus(); // so the sidebar's keys stay inert while the prompt is up
    setRenameTab(tab);
    setOverlay("rename");
  };
  /** Name the tab; empty hands its name back to tmux (it follows the running program). */
  const saveTabName = (name: string) => {
    const tab = renameTab;
    closeOverlay();
    if (!tab) return;
    act(() => (name ? tmux.renameWindow(session, tab.index, name) : tmux.autoNameWindow(session, tab.index)));
  };
  const submitRef = () => {
    const ref = refInput.trim();
    if (!ref) return;
    openDiff("ref", ref);
    closeOverlay();
  };

  // Click inside the terminal → give it app focus so keys route to the shell.
  //
  // Uses the generic `onMouse` slot, NOT `onMouseDown`. EmbeddedTerminal installs
  // its own per-type handlers (onMouseDown/Up/Move/Drag/Scroll) that forward the
  // event to the child program; passing an `onMouseDown` prop would overwrite the
  // "down" forwarder (the React reconciler assigns straight into that slot), so
  // clicks would stop reaching vim/nvim. `onMouse` is a separate listener that
  // runs alongside the forwarders. Pane selection is left to tmux (`mouse on`).
  const handleMouse = (event: { type: string }) => {
    if (event.type === "down") onRequestFocus();
  };

  // Terminal-focused keyboard: return to sidebar + tab management. We
  // preventDefault/stopPropagation so these chords don't also reach the shell
  // (verified: useKeyboard runs before the focused renderable). Everything else
  // falls through to the terminal. tmux-native Ctrl+b keys keep working.
  useKeyboard((key) => {
    if (!focused) return;
    // The rename prompt owns the keyboard (it consumes every key itself).
    if (overlay === "rename") return;
    const n = key.name;
    const eat = () => {
      key.preventDefault();
      key.stopPropagation();
    };

    // The ref/commit text input owns the keyboard while open.
    if (overlay === "diffInput") {
      if (n === "escape") {
        eat();
        openDiffPicker(); // back to the picker
      } else if (n === "return") {
        eat();
        submitRef();
      } else if (n === "backspace") {
        eat();
        setRefInput((v) => v.slice(0, -1));
      } else if (/^[A-Za-z0-9._/~^-]$/.test(n)) {
        eat();
        setRefInput((v) => v + n);
      }
      return;
    }

    // An overlay (＋ menu / diff picker) owns the keyboard while open.
    if (overlay !== "none") {
      const len = overlay === "menu" ? menuItems.length : DIFF_ITEMS.length;
      if (n === "escape") {
        eat();
        closeOverlay();
      } else if (n === "down" || n === "j") {
        eat();
        setMenuIndex((i) => Math.min(i + 1, len - 1));
      } else if (n === "up" || n === "k") {
        eat();
        setMenuIndex((i) => Math.max(i - 1, 0));
      } else if (n === "return") {
        eat();
        pickOverlay(menuIndex);
      } else if (n === "v" && overlay === "diff") {
        // Next installed viewer — remembered.
        eat();
        onDiffViewer?.(nextViewer(diffIn.id, viewers));
      }
      return;
    }

    if (key.ctrl && n === "g") {
      eat();
      onExit();
      return;
    }
    if (!(key.option || key.meta)) return;
    if (n === "a") {
      eat();
      openAgent();
      return;
    }
    if (n === "d") {
      eat();
      openDiffPicker();
      return;
    }
    if (n === "p") {
      eat();
      onTogglePrPanel?.();
      return;
    }
    if (n === "r") {
      eat();
      if (activeWindow) openRename(activeWindow.index);
      return;
    }
    if (n === "n") {
      eat();
      onJumpNext?.();
      return;
    }
    // Directional keys move between split panes (vim hjkl + arrows).
    if (n === "h" || n === "left") {
      eat();
      act(() => tmux.selectPane(session, "L"));
    } else if (n === "l" || n === "right") {
      eat();
      act(() => tmux.selectPane(session, "R"));
    } else if (n === "k" || n === "up") {
      eat();
      act(() => tmux.selectPane(session, "U"));
    } else if (n === "j" || n === "down") {
      eat();
      act(() => tmux.selectPane(session, "D"));
    } else if (n === ",") {
      eat();
      act(() => tmux.prevWindow(session));
    } else if (n === ".") {
      eat();
      act(() => tmux.nextWindow(session));
    } else if (n === "t") {
      eat();
      act(() => tmux.newWindow(session, worktree.path));
    } else if (n === "w" && !key.shift) {
      eat();
      if (canClosePane) act(() => tmux.killPane(session));
    } else if (n === "W" || (n === "w" && key.shift)) {
      eat();
      if (windows.length > 1) act(() => tmux.killWindow(session)); // current tab
    } else if (n === "\\") {
      eat();
      act(() => tmux.splitWindow(session, "h", worktree.path));
    } else if (n === "-") {
      eat();
      act(() => tmux.splitWindow(session, "v", worktree.path));
    } else if (key.number && /^[1-9]$/.test(n)) {
      eat();
      const w = windows[parseInt(n, 10) - 1];
      if (w) act(() => tmux.selectWindow(session, w.index));
    }
  });

  if (status === "error") {
    return (
      <Centered visible={visible}>
        <text fg={theme.dirty}>{"Could not start terminal"}</text>
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM}>
          {error ?? ""}
        </text>
      </Centered>
    );
  }

  return (
    <box visible={visible} flexGrow={1} flexDirection="column" backgroundColor={theme.bg}>
      <TabBar
        windows={windows}
        onSelect={(i) => act(() => tmux.selectWindow(session, i))}
        onRenameTab={openRename}
        onNewTab={openMenu}
        onCloseTab={(i) => {
          if (windows.length <= 1) return;
          act(() => tmux.killWindow(session, i));
        }}
        onSplit={(dir) => act(() => tmux.splitWindow(session, dir, worktree.path))}
        onClosePane={() => {
          if (!canClosePane) return;
          act(() => tmux.killPane(session));
        }}
        onExit={onExit}
        canClosePane={canClosePane}
        pr={worktree.pr}
        prPanelShown={prPanelShown}
        onTogglePr={onTogglePrPanel}
      />
      {/* No fixed cols/rows: the constructor would pin the layout width to
          `cols`. Let it fill the pane; onResize drives sizing. */}
      {/* selectable=false: don't let OpenTUI draw its own cell-selection overlay
          over the terminal — dragging should reach the program inside (nvim does
          its own visual selection), not paint the emulator grid. */}
      <embedded-terminal
        ref={ref}
        maxScrollback={5000}
        selectable={false}
        onData={onData}
        onTerminalResize={onTerminalResize}
        onMouse={handleMouse}
        flexGrow={1}
        width="100%"
        minWidth={0}
      />
      {overlay === "menu" && (
        <MenuOverlay title="New tab" items={menuItems} index={menuIndex} onPick={pickOverlay} onClose={closeOverlay} />
      )}
      {overlay === "diff" && (
        <MenuOverlay
          title={`Open diff · ${diffIn.label}`}
          items={DIFF_ITEMS}
          index={menuIndex}
          onPick={pickOverlay}
          onClose={closeOverlay}
          note={
            viewers.length > 1 ? `v switches viewer · ${viewers.map((id) => viewer(id).label).join(", ")}` : undefined
          }
        />
      )}
      {overlay === "rename" && renameTab && (
        <RenameModal
          initial={renameTab.name}
          heading={`Name for tab ${windows.findIndex((w) => w.index === renameTab.index) + 1}`}
          placeholder="automatic — the program running in it"
          note="Only the tab's name changes. Empty goes back to naming it after the program running in it."
          maxLength={MAX_TAB_NAME_LENGTH}
          onSave={saveTabName}
          onCancel={closeOverlay}
        />
      )}
      {overlay === "diffInput" && (
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
          onMouseDown={() => openDiffPicker()}
        >
          <box
            width={48}
            borderStyle="rounded"
            border
            borderColor={theme.accent}
            backgroundColor={theme.panel}
            title=" Diff vs ref / commit "
            titleAlignment="center"
            flexDirection="column"
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
          >
            <text fg={theme.fgMuted} marginBottom={1}>
              {"ref, branch, commit, or range (A..B)"}
            </text>
            <box flexDirection="row" alignItems="center">
              <text fg={theme.accent}>{"❯ "}</text>
              <text fg={theme.fg}>{refInput}</text>
              <text fg={theme.accent}>{"▏"}</text>
            </box>
            <text fg={theme.fgFaint} attributes={TextAttributes.DIM} marginTop={1}>
              {"⏎ open · esc back"}
            </text>
          </box>
        </box>
      )}
    </box>
  );
}
