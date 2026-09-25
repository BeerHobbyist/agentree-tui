/**
 * The command palette (`ctrl+p`, as in OpenCode): every action agentree has,
 * searchable, grouped by what it acts on, each with the key that does it
 * directly — so nothing needs remembering, and using it teaches the keys.
 */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme";
import { Dialog, rowLook } from "./Dialog";
import { Hints, hintsFrom } from "./Hints";

export interface Command {
  id: string;
  title: string;
  /** What it acts on — the palette's groups, in the order they first appear. */
  category: string;
  /** The key that does it without the palette. */
  keys?: string;
  /** A word on what it'll do now (the theme it switches to, the PR it merges). */
  detail?: string;
  run: () => void;
}

/**
 * How well `query` matches `text` (0 = not at all): all of it in order is the
 * least; the more of it in one piece, at the start or a word's start, the more.
 */
export function matchScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 1;
  const at = t.indexOf(q);
  if (at === 0) return 100;
  if (at > 0) return /\W/.test(t[at - 1]!) ? 80 : 60;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 20 : 0;
}

/** The commands matching `query`: best first (title counting double), or all, grouped, when it's empty. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  if (!query.trim()) {
    const order = [...new Set(commands.map((c) => c.category))];
    return [...commands].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  }
  return commands
    .map((c) => ({ c, score: Math.max(matchScore(query, c.title) * 2, matchScore(query, c.category)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

export function CommandPalette({ commands, onClose }: { commands: readonly Command[]; onClose: () => void }) {
  const theme = useTheme();
  const { height } = useTerminalDimensions();
  const listRef = useRef<ScrollBoxRenderable>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // Mirrors, so a burst of keys (typing, key repeat) acts on current values.
  const queryRef = useRef(query);
  const indexRef = useRef(index);
  const set = (q: string, i: number) => {
    queryRef.current = q;
    indexRef.current = i;
    setQuery(q);
    setIndex(i);
  };

  const shown = filterCommands(commands, query);
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  useKeyboard((key) => {
    // The palette owns the keyboard while it's open.
    key.preventDefault();
    key.stopPropagation();
    const list = filterCommands(commands, queryRef.current);
    const i = indexRef.current;
    const n = key.name;
    if (n === "escape" || (key.ctrl && n === "p")) onClose();
    else if (n === "return") run(list[i]);
    else if (n === "down" || (key.ctrl && n === "n")) set(queryRef.current, Math.min(i + 1, list.length - 1));
    else if (n === "up") set(queryRef.current, Math.max(i - 1, 0));
    else if (n === "backspace") set(queryRef.current.slice(0, -1), 0);
    else if (key.ctrl && n === "u") set("", 0);
    else if (!key.ctrl && !key.meta && key.sequence && !/[\u0000-\u001f\u007f]/.test(key.sequence)) {
      set(queryRef.current + key.sequence, 0);
    }
  });
  usePaste((event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = new TextDecoder().decode(event.bytes).replace(/[\u0000-\u001f\u007f]/g, "");
    if (text) set(queryRef.current + text, 0);
  });

  const grouped = !query.trim();
  // As tall as the list, up to what's left of the dialog's room (a quarter of
  // the screen down; title, search and hints take 8 rows of it).
  const headings = grouped ? new Set(shown.map((c) => c.category)).size : 0;
  const lines = shown.length + headings * 2 - (headings > 0 ? 1 : 0);
  const room = Math.max(4, height - Math.max(1, Math.floor(height / 4)) - 9);
  // The list scrolls on a short screen; the selection stays in view.
  const selectedId = shown[index]?.id;
  useEffect(() => {
    if (selectedId) listRef.current?.scrollChildIntoView(`command:${selectedId}`);
  }, [selectedId]);

  return (
    <Dialog title="Commands" width={64} onClose={onClose} zIndex={160}>
      <box flexDirection="row" flexShrink={0} marginBottom={1}>
        <text fg={theme.accent} flexShrink={0}>
          {"❯ "}
        </text>
        {query ? (
          <text fg={theme.fg} flexShrink={1} wrapMode="none" truncate>
            {query}
          </text>
        ) : (
          <text fg={theme.fgFaint}>{"Search"}</text>
        )}
        <text fg={theme.accent} flexShrink={0}>
          {"▏"}
        </text>
      </box>
      {shown.length === 0 && <text fg={theme.fgMuted}>{"No matching commands."}</text>}
      <scrollbox ref={listRef} height={Math.min(lines, room)} flexShrink={0} scrollY>
        {shown.map((c, i) => {
          const look = rowLook(theme, i === index);
          const heading = grouped && (i === 0 || shown[i - 1]?.category !== c.category);
          return (
            <box key={c.id} flexDirection="column" flexShrink={0}>
              {heading && (
                <text fg={theme.accent} attributes={TextAttributes.BOLD} marginTop={i === 0 ? 0 : 1}>
                  {c.category}
                </text>
              )}
              <box
                id={`command:${c.id}`}
                flexDirection="row"
                backgroundColor={look.bg}
                onMouseDown={() => {
                  set(queryRef.current, i);
                  run(c);
                }}
              >
                <text fg={look.marker} flexShrink={0}>
                  {i === index ? " ▶ " : "   "}
                </text>
                <text fg={look.fg} attributes={look.bold} flexShrink={0}>
                  {c.title}
                </text>
                <text fg={look.muted} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
                  {c.detail ? `  ${c.detail}` : ""}
                </text>
                {c.keys && (
                  <text fg={look.muted} flexShrink={0}>
                    {` ${c.keys} `}
                  </text>
                )}
              </box>
            </box>
          );
        })}
      </scrollbox>
      <Hints marginTop={1} hints={hintsFrom("↑↓ move · ⏎ run · esc close")} />
    </Dialog>
  );
}
