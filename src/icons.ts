/**
 * The app's icons: Nerd Font glyphs (nerdfonts.com/cheat-sheet), drawn by a
 * Nerd Font or a terminal that bundles its symbols (Ghostty, WezTerm, kitty).
 * All Octicons, one cell wide, and in the BMP — one UTF-16 unit each, so a
 * string index on a line still matches its column.
 */
export const ICON = {
  folded: "\u{f460}", // nf-oct-chevron_right
  unfolded: "\u{f47c}", // nf-oct-chevron_down
  back: "\u{f47d}", // nf-oct-chevron_left
  pointer: "\u{f44a}", // nf-oct-triangle_right
  repo: "\u{f401}", // nf-oct-repo
  lock: "\u{f456}", // nf-oct-lock
  host: "\u{f473}", // nf-oct-server
  add: "\u{f44d}", // nf-oct-plus
  close: "\u{f467}", // nf-oct-x
  closePane: "\u{f52f}", // nf-oct-x_circle
  branch: "\u{f418}", // nf-oct-git_branch
  commit: "\u{f417}", // nf-oct-git_commit
  compare: "\u{f47f}", // nf-oct-git_compare
  folder: "\u{f413}", // nf-oct-file_directory
  file: "\u{f4a5}", // nf-oct-file
  pr: "\u{f407}", // nf-oct-git_pull_request
  prDraft: "\u{f4dd}", // nf-oct-git_pull_request_draft
  merged: "\u{f419}", // nf-oct-git_merge
  changed: "\u{f440}", // nf-oct-diff
  edited: "\u{f448}", // nf-oct-pencil
  history: "\u{f464}", // nf-oct-history
  ahead: "\u{f431}", // nf-oct-arrow_up
  behind: "\u{f433}", // nf-oct-arrow_down
  needsAction: "\u{f476}", // nf-oct-bell_fill
  working: "\u{f46a}", // nf-oct-sync
  done: "\u{f4a4}", // nf-oct-check_circle_fill
  idle: "\u{f477}", // nf-oct-hubot
  noAgent: "\u{f4c3}", // nf-oct-dot
  terminal: "\u{f489}", // nf-oct-terminal
  splitRight: "\u{f4b4}", // nf-oct-columns
  splitDown: "\u{f50b}", // nf-oct-rows
  check: "\u{f42e}", // nf-oct-check
  changesRequested: "\u{f4d2}", // nf-oct-file_diff
  pending: "\u{f444}", // nf-oct-dot_fill
  skipped: "\u{f517}", // nf-oct-skip
  dismissed: "\u{f468}", // nf-oct-circle_slash
  failed: "\u{f530}", // nf-oct-x_circle_fill
  warning: "\u{f40c}", // nf-oct-alert_fill
  info: "\u{f449}", // nf-oct-info
  person: "\u{f415}", // nf-oct-person
  reviews: "\u{f441}", // nf-oct-eye
  checks: "\u{f45e}", // nf-oct-checklist
  label: "\u{f412}", // nf-oct-tag
  description: "\u{f405}", // nf-oct-book
  comment: "\u{f41f}", // nf-oct-comment
  refresh: "\u{f46a}", // nf-oct-sync
  search: "\u{f422}", // nf-oct-search
  prompt: "\u{f460}", // nf-oct-chevron_right
  commands: "\u{f4b5}", // nf-oct-command_palette
  rename: "\u{f448}", // nf-oct-pencil
  remove: "\u{f48e}", // nf-oct-trash
  view: "\u{f50c}", // nf-oct-screen_full
  app: "\u{f423}", // nf-oct-gear
  hide: "\u{f514}", // nf-oct-sidebar_collapse
  theme: "\u{f48f}", // nf-oct-paintbrush
  help: "\u{f420}", // nf-oct-question
} as const;
