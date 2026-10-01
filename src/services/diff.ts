/**
 * Diff viewers: a worktree's changes open in one of these, in their own tmux
 * tab at the worktree's directory (the tab closes when the viewer exits).
 *
 * Every diff choice is a set of `git diff` arguments, so any viewer that takes
 * a git diff fits. Which one: the one picked in the diff picker (`v`), else the
 * first installed of hunk, diffnav, delta, difftastic, lumen — else plain `git diff`,
 * which is always there.
 */
import { shellJoin, shq } from "./shell";

export type DiffTarget = "working" | "staged" | "base" | "ref";

export type DiffViewerId = "hunk" | "diffnav" | "delta" | "difftastic" | "lumen" | "diffview" | "git";

/** The `git diff` arguments for a diff choice. */
export function diffArgs(target: DiffTarget, arg?: string): string[] {
  switch (target) {
    case "staged":
      return ["--staged"];
    case "base":
      return [`${arg || "main"}...HEAD`];
    case "ref":
      // A ref, or a range like "A..B" / "A...B".
      return [arg || "HEAD"];
    default: // "working": the uncommitted changes
      return [];
  }
}

export interface DiffViewer {
  id: DiffViewerId;
  label: string;
  /** Programs it needs on PATH. */
  needs: string[];
  /** Picked automatically when installed (in this list's order); else only when chosen. */
  auto: boolean;
  /** The shell command showing `git diff <args>` in it. */
  command(args: string[]): string;
}

/**
 * `git diff` paged by plain `less -R` — not the user's own `core.pager` (often
 * delta, which would also mangle difftastic's output) — with `LESS=R`: unlike
 * git's default `FRX`, it doesn't quit when the diff fits on one screen, which
 * would close the tab at once. `config` overrides for the viewers that page
 * differently.
 */
const git = (args: string[], config: string[] = ["core.pager=less -R"]) =>
  "LESS=R " + ["git", ...config.flatMap((c) => ["-c", c]), "diff", ...args].map(shq).join(" ");

export const DIFF_VIEWERS: DiffViewer[] = [
  {
    id: "hunk",
    label: "hunk",
    needs: ["hunk"],
    auto: true,
    command: (args) => shellJoin(["hunk", "diff", ...args]),
  },
  {
    // A file tree beside delta's rendering, à la GitHub; reads the diff on stdin.
    id: "diffnav",
    label: "diffnav",
    needs: ["diffnav", "delta"],
    auto: true,
    command: (args) => `${git(args, ["color.ui=never", "core.pager=cat"])} | diffnav`,
  },
  {
    // Side by side; n / N jump between files.
    id: "delta",
    label: "delta",
    needs: ["delta"],
    auto: true,
    command: (args) =>
      `DELTA_PAGER='less -R' ${git(args, ["core.pager=delta --side-by-side --navigate --paging=always"])}`,
  },
  {
    // Diffs by syntax, so reindents and moved code read as what they are.
    id: "difftastic",
    label: "difftastic",
    needs: ["difft"],
    auto: true,
    command: (args) =>
      `DFT_COLOR=always DFT_WIDTH=$(tput cols 2>/dev/null || echo 120) ${git(args, ["diff.external=difft", "core.pager=less -R"])}`,
  },
  {
    // Side by side. It has no flag for staged changes, so those open in plain git.
    id: "lumen",
    label: "lumen",
    needs: ["lumen"],
    auto: true,
    command: (args) => (args.includes("--staged") ? git(args) : shellJoin(["lumen", "diff", ...args])),
  },
  {
    // Neovim with the diffview.nvim plugin (can't tell if it's installed, so only when chosen).
    id: "diffview",
    label: "nvim diffview",
    needs: ["nvim"],
    auto: false,
    command: (args) =>
      shellJoin(["nvim", "-c", ["DiffviewOpen", ...args.map((a) => (a === "--staged" ? "--cached" : a))].join(" ")]),
  },
  {
    id: "git",
    label: "git diff",
    needs: ["git"],
    auto: true,
    command: (args) => git(args),
  },
];

export function viewer(id: DiffViewerId): DiffViewer {
  return DIFF_VIEWERS.find((v) => v.id === id)!;
}

/**
 * The viewers whose programs are on PATH, in DIFF_VIEWERS order.
 * `AGENTREE_DIFF_VIEWERS` (comma-separated ids) says instead — for tests,
 * whose machines have different viewers installed.
 */
export function availableViewers(
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd, { PATH: process.env.PATH }),
): DiffViewerId[] {
  const listed = process.env.AGENTREE_DIFF_VIEWERS;
  if (listed) {
    const ids = listed.split(",").map((s) => s.trim());
    return DIFF_VIEWERS.filter((v) => ids.includes(v.id)).map((v) => v.id);
  }
  return DIFF_VIEWERS.filter((v) => v.needs.every((cmd) => which(cmd))).map((v) => v.id);
}

/**
 * The viewer to use: the chosen one if it's installed, else the first
 * installed automatic one, else plain git.
 */
export function resolveViewer(choice: DiffViewerId | undefined, available: DiffViewerId[]): DiffViewer {
  if (choice && available.includes(choice)) return viewer(choice);
  const auto = DIFF_VIEWERS.find((v) => v.auto && available.includes(v.id));
  return auto ?? viewer("git");
}

/** The viewer after `current` among the installed ones (the diff picker's `v`). */
export function nextViewer(current: DiffViewerId, available: DiffViewerId[]): DiffViewerId {
  const list = available.length > 0 ? available : ["git" as const];
  const i = list.indexOf(current);
  return list[(i + 1) % list.length]!;
}

/**
 * The command opening this diff choice in a viewer. An empty diff says so and
 * waits for Enter rather than having the viewer exit at once (the tab would
 * just flash). Run by `sh`, since tmux starts it with the user's own shell.
 */
export function diffCommand(v: DiffViewer, target: DiffTarget, arg?: string): string {
  const args = diffArgs(target, arg);
  const script = [
    `if ${shellJoin(["git", "diff", "--quiet", ...args])}; then`,
    `printf '\\n  No changes to show.\\n\\n  Press Enter to close. '; read -r _;`,
    `else ${v.command(args)}; fi`,
  ].join(" ");
  return shellJoin(["sh", "-c", script]);
}
