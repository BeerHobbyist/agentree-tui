import { useRef, useState } from "react";
import type { ParsedKey } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { useTheme } from "../theme";
import type { Project } from "../data/model";
import { addRemoteDir, reconcile, sshProjectId, type State } from "../store";
import { configuredHosts, isValidHost, probeRemoteDir, SshAuthError } from "../services/ssh";
import type { Selection } from "./AddWorktreeModal";
import { Dialog, rowLook } from "./Dialog";
import { Hints, hintsFrom } from "./Hints";

interface SshModalProps {
  state: State;
  /** Adding a directory to this host (its + / `a`): skip straight to the directory. */
  host?: string;
  onClose: () => void;
  /** Added: the new project list, and the directory to select. */
  onAdded: (projects: Project[], selection: Selection) => void;
}

type Phase = "host" | "dir" | "password" | "checking" | "error";

/** Most suggestions shown under the host input. */
const MAX_SUGGESTIONS = 6;

/**
 * Add an SSH project, or a directory to one: pick a host (typed, or from
 * ~/.ssh/config), then a directory on it. Before saving, it connects once to
 * check the directory exists and tmux is installed there. A host that wants a
 * password (or a key passphrase) gets asked for it; it's used for that one
 * login, which the host's later connections reuse, and never stored. Owns the
 * keyboard.
 */
export function SshModal({ state, host: preset, onClose, onAdded }: SshModalProps) {
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>(preset ? "dir" : "host");
  const [hostInput, setHostInput] = useState("");
  const [host, setHost] = useState(preset ?? "");
  const [dir, setDir] = useState("~");
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [suggestions] = useState(() => configuredHosts());

  // Mirrors: keys can arrive faster than React re-renders.
  const s = useRef({ phase, hostInput, host, dir, index, password });
  s.current = { phase, hostInput, host, dir, index, password };
  const set = {
    phase(v: Phase) {
      s.current.phase = v;
      setPhase(v);
    },
    hostInput(v: string) {
      s.current.hostInput = v;
      setHostInput(v);
      set.index(0);
    },
    host(v: string) {
      s.current.host = v;
      setHost(v);
    },
    dir(v: string) {
      s.current.dir = v;
      setDir(v);
    },
    index(v: number) {
      s.current.index = v;
      setIndex(v);
    },
    password(v: string) {
      s.current.password = v;
      setPassword(v);
    },
  };

  /** Host rows: what you typed (if it's not already listed), then matching ~/.ssh/config hosts. */
  const hostRows = (typed: string) => {
    const q = typed.trim().toLowerCase();
    const matches = suggestions.filter((h) => h.toLowerCase().includes(q)).slice(0, MAX_SUGGESTIONS);
    return typed.trim() && !matches.includes(typed.trim()) ? [typed.trim(), ...matches] : matches;
  };

  const chooseHost = (h: string) => {
    if (!isValidHost(h)) return;
    set.host(h);
    set.phase("dir");
  };

  /** Connect and check the directory — with the password typed, once one was asked for. */
  const check = (withPassword = false) => {
    const { host: h, dir: d, password: pw } = s.current;
    const path = d.trim() || "~";
    set.phase("checking");
    probeRemoteDir(h, path, withPassword ? { password: pw } : {})
      .then(async (found) => {
        const id = await addRemoteDir(state, h, found, { needsPassword: withPassword });
        const projects = await reconcile(state);
        onAdded(projects, { repoId: sshProjectId(h), worktreeId: id });
      })
      .catch((err) => {
        if (err instanceof SshAuthError) {
          // Refused: ask for the password (again, if the one typed was wrong).
          setPasswordError(withPassword ? "That didn't work — try again." : "");
          set.password("");
          set.phase("password");
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        set.phase("error");
      });
  };

  const type = (text: string) => {
    const { phase: p, hostInput: hi, dir: d, password: pw } = s.current;
    if (p === "host") set.hostInput(hi + text.replace(/\s/g, ""));
    else if (p === "dir") set.dir(d + text);
    else if (p === "password") set.password(pw + text);
  };

  useKeyboard((key) => {
    key.preventDefault();
    key.stopPropagation();
    const n = key.name;
    const { phase: p, hostInput: hi, dir: d, index: i } = s.current;
    if (p === "checking") return; // wait for ssh
    if (p === "error") {
      if (n === "return" || n === "escape") set.phase("dir");
      return;
    }
    if (n === "escape") {
      if (p === "password") set.phase("dir");
      else if (p === "dir" && !preset) set.phase("host");
      else onClose();
      return;
    }
    if (p === "password") {
      const pw = s.current.password;
      if (n === "return") check(true);
      else if (n === "backspace") set.password(Array.from(pw).slice(0, -1).join(""));
      else if (key.ctrl && n === "u") set.password("");
      else {
        const t = typedText(key);
        if (t) type(t);
      }
      return;
    }
    if (p === "host") {
      const rows = hostRows(hi);
      if (n === "down") set.index(Math.min(i + 1, Math.max(rows.length - 1, 0)));
      else if (n === "up") set.index(Math.max(i - 1, 0));
      else if (n === "return") {
        const pick = rows[i];
        if (pick) chooseHost(pick);
      } else if (n === "backspace") set.hostInput(hi.slice(0, -1));
      else if (key.ctrl && n === "u") set.hostInput("");
      else {
        const t = typedText(key);
        if (t) type(t);
      }
      return;
    }
    // dir
    if (n === "return") check();
    else if (n === "backspace") set.dir(Array.from(d).slice(0, -1).join(""));
    else if (key.ctrl && n === "u") set.dir("");
    else {
      const t = typedText(key);
      if (t) type(t);
    }
  });

  usePaste((event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = new TextDecoder().decode(event.bytes).replace(/[\u0000-\u001f\u007f]/g, "");
    if (text) type(text);
  });

  const hint = (text: string) => <Hints marginTop={1} hints={hintsFrom(text)} />;
  const input = (value: string, placeholder: string) => (
    <box flexDirection="row" alignItems="center">
      <text fg={theme.accent} flexShrink={0}>
        {"❯ "}
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
  );

  const body = () => {
    switch (phase) {
      case "host": {
        const rows = hostRows(hostInput);
        return (
          <>
            <text fg={theme.fgMuted} marginBottom={1}>
              {"Host — an ~/.ssh/config name, user@host, or ssh://user@host:port"}
            </text>
            {input(hostInput, "dev-box")}
            {rows.length > 0 && (
              <box flexDirection="column" marginTop={1}>
                {rows.map((h, i) => {
                  const look = rowLook(theme, i === index);
                  return (
                    <box key={h} flexDirection="row" backgroundColor={look.bg} onMouseDown={() => chooseHost(h)}>
                      <text fg={look.marker}>{i === index ? " ▶ " : "   "}</text>
                      <text fg={look.fg} attributes={look.bold} wrapMode="none" truncate>
                        {"⌁ " + h}
                      </text>
                    </box>
                  );
                })}
              </box>
            )}
            {hint("type or ↑↓ · ⏎ next · esc cancel")}
          </>
        );
      }
      case "dir":
        return (
          <>
            <text fg={theme.fgMuted} marginBottom={1} wrapMode="none" truncate>
              {`Directory on ${host}`}
            </text>
            {input(dir, "~")}
            <text fg={theme.fgMuted} marginTop={1} wrapMode="word">
              {"Its terminal runs on the host, in tmux there — it keeps running if the connection drops."}
            </text>
            {hint(preset ? "⏎ add · esc cancel" : "⏎ add · esc back")}
          </>
        );
      case "password":
        return (
          <>
            <text fg={theme.fgMuted} marginBottom={1} wrapMode="none" truncate>
              {`Password (or key passphrase) for ${host}`}
            </text>
            {input("•".repeat(Array.from(password).length), "")}
            {passwordError && (
              <text fg={theme.removed} marginTop={1}>
                {passwordError}
              </text>
            )}
            <text fg={theme.fgMuted} marginTop={1} wrapMode="word">
              {
                "Used for this one login, which agentree keeps open and reuses; never saved. After a restart, its terminal asks again."
              }
            </text>
            {hint("⏎ connect · esc back")}
          </>
        );
      case "checking":
        return <text fg={theme.fgMuted}>{`Connecting to ${host}…`}</text>;
      case "error":
        return (
          <>
            <text fg={theme.removed} wrapMode="word">
              {error}
            </text>
            {hint("⏎ / esc back")}
          </>
        );
    }
  };

  return (
    <Dialog
      title={preset ? `Add a directory on ${preset}` : "Add an SSH host"}
      width={66}
      // Not while it's connecting.
      onClose={phase === "checking" ? undefined : onClose}
      zIndex={150}
    >
      {body()}
    </Dialog>
  );
}

/** What a key typed, or null for keys that type nothing. */
function typedText(key: ParsedKey): string | null {
  if (key.ctrl || key.meta || key.option) return null;
  const seq = key.sequence ?? "";
  if (!seq || /[\u0000-\u001f\u007f]/.test(seq)) return null;
  return seq;
}
