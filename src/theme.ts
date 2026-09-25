/**
 * Theming system: a registry of named palettes, a tiny observable store, and a
 * `useTheme()` hook so the whole UI re-renders when the active theme changes.
 */
import { useSyncExternalStore } from "react";

export interface Theme {
  name: string;
  // Surfaces
  bg: string;
  panel: string;
  panelAlt: string;
  activeBg: string;
  border: string;
  // Text
  fg: string;
  fgMuted: string;
  fgFaint: string;
  // Accents
  accent: string;
  accentDim: string;
  // Status
  dirty: string;
  clean: string;
  added: string;
  removed: string;
  agentWaiting: string;
  agentWorking: string;
  ahead: string;
  behind: string;
}

/** Current default — a soft-blue near-black (Tokyo-night-ish). */
const midnight: Theme = {
  name: "midnight",
  bg: "#0d0f14",
  panel: "#12151c",
  panelAlt: "#171b24",
  activeBg: "#1e2530",
  border: "#232833",
  fg: "#e6e9ef",
  fgMuted: "#9aa3b2",
  fgFaint: "#5b6473",
  accent: "#7aa2f7",
  accentDim: "#3d4a63",
  dirty: "#e0af68",
  clean: "#565f70",
  added: "#9ece6a",
  removed: "#f7768e",
  agentWaiting: "#bb9af7",
  agentWorking: "#7dcfff",
  ahead: "#9ece6a",
  behind: "#f7768e",
};

/** One Dark (Atom) palette. */
const onedark: Theme = {
  name: "onedark",
  bg: "#282c34",
  panel: "#21252b",
  panelAlt: "#2c313a",
  activeBg: "#3b4048",
  border: "#3e4451",
  fg: "#abb2bf",
  fgMuted: "#828997",
  fgFaint: "#5c6370",
  accent: "#61afef",
  accentDim: "#3b4a5f",
  dirty: "#e5c07b",
  clean: "#5c6370",
  added: "#98c379",
  removed: "#e06c75",
  agentWaiting: "#c678dd",
  agentWorking: "#56b6c2",
  ahead: "#98c379",
  behind: "#e06c75",
};

/** OpenCode's default dark palette (github.com/sst/opencode, theme "opencode"). */
const opencode: Theme = {
  name: "opencode",
  bg: "#0a0a0a",
  panel: "#141414",
  panelAlt: "#1e1e1e",
  activeBg: "#282828",
  border: "#3c3c3c",
  fg: "#eeeeee",
  fgMuted: "#808080",
  fgFaint: "#5a5a5a",
  accent: "#fab283",
  accentDim: "#5a4636",
  dirty: "#f5a742",
  clean: "#5a5a5a",
  added: "#7fd88f",
  removed: "#e06c75",
  agentWaiting: "#9d7cd8",
  agentWorking: "#56b6c2",
  ahead: "#7fd88f",
  behind: "#e06c75",
};

export const themes: Record<string, Theme> = { onedark, midnight, opencode };

/** `a` mixed with `b`: t = 0 is all `a`, 1 all `b`. Both `#rrggbb`. */
export function mix(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(channel(a, i) * (1 - t) + channel(b, i) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

// --- observable active-theme store ---
let current: Theme = onedark;
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return current;
}

export function themeNames(): string[] {
  return Object.keys(themes);
}

export function setTheme(name: string): void {
  const next = themes[name];
  if (!next || next === current) return;
  current = next;
  for (const l of listeners) l();
}

/** Switch to the next theme in the registry; returns the new name. */
export function cycleTheme(): string {
  const names = themeNames();
  const i = names.indexOf(current.name);
  const next = names[(i + 1) % names.length]!;
  setTheme(next);
  return next;
}

/** Back to the default palette — the global store would otherwise leak between tests. */
export function resetTheme(): void {
  setTheme(onedark.name);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React hook: returns the active theme and re-renders on change. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
