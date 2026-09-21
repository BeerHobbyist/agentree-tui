/**
 * Dark theme palette for the Worktree TUI.
 *
 * Tuned to feel close to Superset's project sidebar: a near-black surface,
 * a slightly lifted panel, a warm accent for the active row, and muted greys
 * for secondary metadata.
 */
export const theme = {
  // Surfaces
  bg: "#0d0f14", // app background
  panel: "#12151c", // sidebar surface
  panelAlt: "#171b24", // hover / subtle blocks
  activeBg: "#1e2530", // selected row background
  border: "#232833",

  // Text
  fg: "#e6e9ef", // primary text
  fgMuted: "#9aa3b2", // secondary text
  fgFaint: "#5b6473", // tertiary / hints

  // Accents
  accent: "#7aa2f7", // selection / primary accent (soft blue)
  accentDim: "#3d4a63",

  // Status
  dirty: "#e0af68", // uncommitted changes (amber)
  clean: "#565f70", // clean worktree (grey)
  added: "#9ece6a", // + lines (green)
  removed: "#f7768e", // - lines (red)
  agentWaiting: "#bb9af7", // agent needs input (purple)
  agentWorking: "#7dcfff", // agent running (cyan)
  ahead: "#9ece6a",
  behind: "#f7768e",
} as const;

export type Theme = typeof theme;
