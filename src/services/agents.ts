/**
 * Live status of the Claude Code agents running in worktree terminals.
 *
 * The agents report it themselves. agentree launches `claude --settings <file>`
 * where the file registers hooks (Claude Code's supported extension point), and
 * each hook overwrites a one-line file named after its tmux session and pane:
 *
 *     <agentStatusDir>/<session>.<pane>   →   "working 1790157274"
 *
 * The hooks only *add* to the user's own Claude settings, and the files live
 * next to state.json — never inside a worktree, so they can't make it dirty.
 *
 * Hooks can't see everything (an Esc interrupt fires no hook, a crash fires no
 * SessionEnd), so the app cross-checks tmux: it knows whether each pane is still
 * alive, and when its window last printed anything.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentCommand, stateFilePath } from "../config";
import type { AgentStatus } from "../data/model";
import { listPaneActivity } from "./tmux";

/** A state a hook can report (everything but "none"). */
export type ReportedState = Exclude<AgentStatus, "none">;

/** An agent pane's last report. `since` is epoch seconds. */
export interface AgentReport {
  state: ReportedState;
  since: number;
}

const REPORTED: readonly ReportedState[] = ["idle", "working", "needs-action", "done"];

/**
 * Seconds without output after which a "working" agent is taken to have
 * stopped. Claude's spinner redraws continuously while it works, so silence
 * means it was interrupted (Esc fires no hook) or died. Kept above the ~6s
 * Claude waits before its permission-prompt notification, so a pending prompt
 * shows "needs action" rather than flickering to idle first.
 */
export const WORKING_SILENCE_S = 10;

/** Which state each Claude Code hook event reports ("gone" removes the file). */
export const HOOK_EVENTS: { event: string; matcher?: string; state: ReportedState | "gone" }[] = [
  { event: "SessionStart", state: "idle" },
  { event: "UserPromptSubmit", state: "working" },
  // Tool events keep "working" fresh, and PostToolUse is what flips a granted
  // permission back from "needs action".
  { event: "PreToolUse", matcher: "*", state: "working" },
  { event: "PostToolUse", matcher: "*", state: "working" },
  // Blocked on the user. Not `idle_prompt`: that's "finished a while ago",
  // which "done" already covers.
  {
    event: "Notification",
    matcher: "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input",
    state: "needs-action",
  },
  { event: "Stop", state: "done" },
  { event: "SessionEnd", state: "gone" },
];

/** Directory the hooks write into — beside state.json, so XDG-aware and sandboxed in tests. */
export function agentStatusDir(): string {
  return join(dirname(stateFilePath()), "agents");
}

/** The Claude settings file (hooks only) passed to agents via `--settings`. */
export function hooksSettingsPath(): string {
  return join(dirname(stateFilePath()), "claude-hooks.json");
}

/**
 * The shell command a hook runs. It relies on environment the tmux session
 * provides (see `agentSessionEnv`) plus tmux's own `$TMUX_PANE`, does nothing
 * outside an agentree session, and prints nothing — Claude feeds the stdout of
 * some hooks (UserPromptSubmit, SessionStart) back into the conversation.
 */
export function hookCommand(state: ReportedState | "gone"): string {
  const file = '"$AGENTREE_AGENT_DIR/$AGENTREE_SESSION.${TMUX_PANE#%}"';
  const action =
    state === "gone"
      ? "rm -f " + file
      : 'mkdir -p "$AGENTREE_AGENT_DIR"' +
        ` && printf '%s %s\\n' ${state} "$(date +%s)" > ${file}.tmp` +
        ` && mv -f ${file}.tmp ${file}`;
  return (
    '[ -n "$AGENTREE_AGENT_DIR" ] && [ -n "$AGENTREE_SESSION" ] && [ -n "$TMUX_PANE" ]' +
    ` && { ${action}; } >/dev/null 2>&1; exit 0`
  );
}

/** The `--settings` JSON: one command hook per event in HOOK_EVENTS. */
export function hooksSettings(): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const { event, matcher, state } of HOOK_EVENTS) {
    (hooks[event] ??= []).push({
      ...(matcher !== undefined && { matcher }),
      hooks: [{ type: "command", command: hookCommand(state), timeout: 5 }],
    });
  }
  return { hooks };
}

/** Write the hooks settings file if it's missing or stale; returns its path. */
export function ensureHooksSettings(): string {
  const path = hooksSettingsPath();
  const content = JSON.stringify(hooksSettings(), null, 2) + "\n";
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // missing — write it
  }
  if (current !== content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + ".tmp", content, "utf8");
    renameSync(path + ".tmp", path);
  }
  return path;
}

/** Environment the tmux session gives its panes, so the hooks know where to report. */
export function agentSessionEnv(session: string): Record<string, string> {
  return { AGENTREE_AGENT_DIR: agentStatusDir(), AGENTREE_SESSION: session };
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * `command` with the status hooks attached, when it launches `claude` (and
 * doesn't already pass its own `--settings`). Anything else — another agent, a
 * custom override — runs untouched.
 */
export function withStatusHooks(command: string, settingsPath = hooksSettingsPath()): string {
  const words = command.trim().split(/\s+/);
  if (!words.includes("claude") || words.includes("--settings")) return command;
  return `${command} --settings ${shellQuote(settingsPath)}`;
}

/** The command a worktree terminal runs to start its agent, status hooks attached. */
export function agentLaunchCommand(): string {
  return withStatusHooks(agentCommand(), ensureHooksSettings());
}

/** Parse a status file: its name (`<session>.<pane>`) and content (`<state> <epoch>`). */
export function parseReport(
  fileName: string,
  content: string,
): ({ session: string; pane: string } & AgentReport) | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  const session = fileName.slice(0, dot);
  const pane = fileName.slice(dot + 1);
  if (!/^\d+$/.test(pane)) return null; // also skips in-flight "*.tmp" files
  const [state, since] = content.trim().split(/\s+/);
  if (!REPORTED.includes(state as ReportedState)) return null;
  const t = Number(since);
  if (!Number.isFinite(t)) return null;
  return { session, pane, state: state as ReportedState, since: t };
}

/**
 * Correct a report with what tmux saw: `lastOutput` is when the pane's window
 * last printed (epoch seconds), `now` likewise.
 */
export function effectiveState(report: AgentReport, lastOutput: number, now: number): ReportedState {
  const { state, since } = report;
  // Interrupted with Esc (no hook fires), or died mid-turn.
  if (state === "working" && now - lastOutput >= WORKING_SILENCE_S && now - since >= WORKING_SILENCE_S) {
    return "idle";
  }
  // The prompt was answered and the agent is printing again. (PostToolUse would
  // say so too, but only once the approved tool finishes.)
  if (state === "needs-action" && lastOutput > since + 1) return "working";
  return state;
}

/** Most urgent first: what a worktree shows when it runs several agents. */
const PRIORITY: readonly ReportedState[] = ["needs-action", "working", "done", "idle"];

/** Combine a worktree's agents into the one status its row shows. */
export function combineReports(reports: AgentReport[]): AgentReport | undefined {
  let best: AgentReport | undefined;
  for (const r of reports) {
    if (!best) {
      best = r;
      continue;
    }
    const rank = PRIORITY.indexOf(r.state) - PRIORITY.indexOf(best.state);
    if (rank < 0 || (rank === 0 && r.since > best.since)) best = r;
  }
  return best;
}

/**
 * Every tmux session's current agent status. Reports from panes that no longer
 * exist are deleted (their agent is gone and fired no SessionEnd).
 */
export async function readAgentStatuses(
  now = Math.floor(Date.now() / 1000),
): Promise<Map<string, AgentReport>> {
  const dir = agentStatusDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return new Map();
  }
  if (names.length === 0) return new Map();

  const panes = await listPaneActivity();
  const bySession = new Map<string, AgentReport[]>();
  for (const name of names) {
    let content: string;
    try {
      content = readFileSync(join(dir, name), "utf8");
    } catch {
      continue; // raced with a hook's rename, or removed
    }
    const report = parseReport(name, content);
    if (!report) continue;
    let state = report.state;
    if (panes) {
      const lastOutput = panes.get(`${report.session}.${report.pane}`);
      if (lastOutput === undefined) {
        rmSync(join(dir, name), { force: true });
        continue;
      }
      state = effectiveState(report, lastOutput, now);
    }
    const list = bySession.get(report.session) ?? [];
    list.push({ state, since: report.since });
    bySession.set(report.session, list);
  }

  const result = new Map<string, AgentReport>();
  for (const [session, reports] of bySession) {
    const combined = combineReports(reports);
    if (combined) result.set(session, combined);
  }
  return result;
}
