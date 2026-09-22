import { useEffect, useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme";
import { agentCommand } from "../config";
import type { Worktree } from "../data/model";
import {
  applyTheme,
  attachCommand,
  isAvailable,
  killPane,
  killWindow,
  listPaneGeometry,
  listWindows,
  newWindow,
  newWindowCmd,
  nextWindow,
  prevWindow,
  selectPane,
  selectPaneById,
  selectWindow,
  sessionName,
  splitWindow,
  type WindowInfo,
} from "../services/tmux";
import { baseRef } from "../services/git";
import {
  isAvailable as hunkAvailable,
  diffCommand,
  type DiffTarget,
} from "../services/hunk";
import { useTerminalSession } from "../hooks/useTerminalSession";
import { TabBar } from "./TabBar";
import { MenuOverlay, type MenuItem } from "./MenuOverlay";
import "./EmbeddedTerminal"; // registers <embedded-terminal>

const MENU_ITEMS: MenuItem[] = [
  { label: "＋ New shell", hint: "" },
  { label: "✻ New agent", hint: "⌥a" },
  { label: "◨ New diff (hunk)", hint: "⌥d" },
];
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
  /** Whether the terminal should hold keyboard focus. */
  focused: boolean;
  /** Called when the pane is clicked, so the app can switch focus to it. */
  onRequestFocus: () => void;
  /** Called to hand focus back to the sidebar (back button / Ctrl+g). */
  onExit: () => void;
}

function Centered({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
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
  const theme = useTheme();
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
  const theme = useTheme();
  const session = useMemo(
    () => sessionName(repoId, worktree.id),
    [repoId, worktree.id],
  );
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
        agentCommand(),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Live re-theme: re-apply tmux styling (global) when the theme changes.
  useEffect(() => {
    if (status !== "running") return;
    applyTheme({
      bg: theme.bg,
      fg: theme.fg,
      border: theme.border,
      borderActive: theme.accent,
    }).catch(() => {});
  }, [theme, status]);

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
        setTimeout(refreshWindows, 60);
        onRequestFocus();
      });
  };

  // ＋ menu / diff picker overlay.
  const [overlay, setOverlay] = useState<
    "none" | "menu" | "diff" | "diffInput"
  >("none");
  const [menuIndex, setMenuIndex] = useState(0);
  const [refInput, setRefInput] = useState("");
  const [hunkOk, setHunkOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    hunkAvailable().then((ok) => alive && setHunkOk(ok));
    return () => {
      alive = false;
    };
  }, []);

  const openMenu = () => {
    setOverlay("menu");
    setMenuIndex(0);
  };
  const openDiffPicker = () => {
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
        arg ?? (target === "base" ? await baseRef(worktree.path) : undefined);
      await newWindowCmd(
        session,
        worktree.path,
        diffCommand(target, resolved),
        "diff",
      );
    });
  };
  const openAgent = () => {
    act(() => newWindowCmd(session, worktree.path, agentCommand(), "agent"));
  };
  const pickOverlay = (i: number) => {
    if (overlay === "menu") {
      if (i === 0) {
        act(() => newWindow(session, worktree.path));
        closeOverlay();
      } else if (i === 1) {
        openAgent();
        closeOverlay();
      } else {
        openDiffPicker();
      }
    } else if (overlay === "diff") {
      if (hunkOk === false) return; // install hint shown; no-op
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
  const submitRef = () => {
    const ref = refInput.trim();
    if (!ref) return;
    openDiff("ref", ref);
    closeOverlay();
  };

  // Click inside the terminal → focus + select the tmux pane under the cursor.
  // Deterministic: map the click to emulator-local cells (which equal the tmux
  // client grid) and select the pane whose geometry contains it.
  const handleMouseDown = (event: { x: number; y: number }) => {
    onRequestFocus();
    const el = ref.current;
    if (!el) return;
    const lx = event.x - el.screenX;
    const ly = event.y - el.screenY;
    listPaneGeometry(session)
      .then((panes) => {
        if (panes.length <= 1) return;
        const hit = panes.find(
          (p) => lx >= p.left && lx <= p.right && ly >= p.top && ly <= p.bottom,
        );
        if (hit) selectPaneById(hit.id);
      })
      .catch(() => {});
  };


  // Terminal-focused keyboard: return to sidebar + tab management. We
  // preventDefault/stopPropagation so these chords don't also reach the shell
  // (verified: useKeyboard runs before the focused renderable). Everything else
  // falls through to the terminal. tmux-native Ctrl+b keys keep working.
  useKeyboard((key) => {
    if (!focused) return;
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
      const len = overlay === "menu" ? MENU_ITEMS.length : DIFF_ITEMS.length;
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
    // Directional keys move between split panes (vim hjkl + arrows).
    if (n === "h" || n === "left") {
      eat();
      act(() => selectPane(session, "L"));
    } else if (n === "l" || n === "right") {
      eat();
      act(() => selectPane(session, "R"));
    } else if (n === "k" || n === "up") {
      eat();
      act(() => selectPane(session, "U"));
    } else if (n === "j" || n === "down") {
      eat();
      act(() => selectPane(session, "D"));
    } else if (n === ",") {
      eat();
      act(() => prevWindow(session));
    } else if (n === ".") {
      eat();
      act(() => nextWindow(session));
    } else if (n === "t") {
      eat();
      act(() => newWindow(session, worktree.path));
    } else if (n === "w" && !key.shift) {
      eat();
      if (canClosePane) act(() => killPane(session));
    } else if (n === "W" || (n === "w" && key.shift)) {
      eat();
      if (windows.length > 1) act(() => killWindow(session)); // current tab
    } else if (n === "\\") {
      eat();
      act(() => splitWindow(session, "h", worktree.path));
    } else if (n === "-") {
      eat();
      act(() => splitWindow(session, "v", worktree.path));
    } else if (key.number && /^[1-9]$/.test(n)) {
      eat();
      const w = windows[parseInt(n, 10) - 1];
      if (w) act(() => selectWindow(session, w.index));
    }
  });

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
        onNewTab={openMenu}
        onCloseTab={(i) => {
          if (windows.length <= 1) return;
          act(() => killWindow(session, i));
        }}
        onSplit={(dir) => act(() => splitWindow(session, dir, worktree.path))}
        onClosePane={() => {
          if (!canClosePane) return;
          act(() => killPane(session));
        }}
        onExit={onExit}
        canClosePane={canClosePane}
      />
      {/* No fixed cols/rows: the constructor would pin the layout width to
          `cols`. Let it fill the pane; onResize drives sizing. */}
      <embedded-terminal
        ref={ref}
        maxScrollback={5000}
        onData={onData}
        onTerminalResize={onTerminalResize}
        onMouseDown={handleMouseDown}
        flexGrow={1}
        width="100%"
        minWidth={0}
      />
      {overlay === "menu" && (
        <MenuOverlay
          title="New tab"
          items={MENU_ITEMS}
          index={menuIndex}
          onPick={pickOverlay}
          onClose={closeOverlay}
        />
      )}
      {overlay === "diff" && (
        <MenuOverlay
          title="Open diff (hunk)"
          items={DIFF_ITEMS}
          index={menuIndex}
          onPick={pickOverlay}
          onClose={closeOverlay}
          note={
            hunkOk === false
              ? "hunk not found — npm i -g hunkdiff"
              : undefined
          }
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
            <text
              fg={theme.fgFaint}
              attributes={TextAttributes.DIM}
              marginTop={1}
            >
              {"⏎ open · esc back"}
            </text>
          </box>
        </box>
      )}
    </box>
  );
}
