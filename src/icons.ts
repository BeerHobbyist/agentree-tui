/**
 * The sidebar's icons: Nerd Font glyphs (nerdfonts.com/cheat-sheet), drawn by
 * a Nerd Font or a terminal that bundles its symbols (Ghostty, WezTerm, kitty).
 * All Octicons, one cell wide, and in the BMP — one UTF-16 unit each, so a
 * string index on a line still matches its column.
 */
export const ICON = {
  folded: "\u{f460}", // nf-oct-chevron_right
  unfolded: "\u{f47c}", // nf-oct-chevron_down
  repo: "\u{f401}", // nf-oct-repo
  host: "\u{f473}", // nf-oct-server
  add: "\u{f44d}", // nf-oct-plus
  branch: "\u{f418}", // nf-oct-git_branch
  folder: "\u{f413}", // nf-oct-file_directory
  pr: "\u{f407}", // nf-oct-git_pull_request
  prDraft: "\u{f4dd}", // nf-oct-git_pull_request_draft
  merged: "\u{f419}", // nf-oct-git_merge
  changed: "\u{f440}", // nf-oct-diff
  ahead: "\u{f431}", // nf-oct-arrow_up
  behind: "\u{f433}", // nf-oct-arrow_down
  needsAction: "\u{f476}", // nf-oct-bell_fill
  working: "\u{f46a}", // nf-oct-sync
  done: "\u{f4a4}", // nf-oct-check_circle_fill
  idle: "\u{f477}", // nf-oct-hubot
  noAgent: "\u{f4c3}", // nf-oct-dot
  hide: "\u{f514}", // nf-oct-sidebar_collapse
  theme: "\u{f48f}", // nf-oct-paintbrush
  help: "\u{f420}", // nf-oct-question
} as const;
