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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentCommand, stateFilePath } from "../config";
import type { AgentStatus } from "../data/model";
import { run } from "./proc";
import { isConnected, remoteArgv, shq } from "./ssh";
import { ensureCliOnPath } from "./self";
import { listPaneActivity, socketName } from "./tmux";

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
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, for sh to expand
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

/**
 * What a claude starting in an agentree terminal is told (a SessionStart
 * hook's output becomes context): that it can drive its tabs with the CLI.
 */
export const AGENT_CONTEXT =
  "You are running inside agentree, a terminal workspace where each git worktree has tabs (tmux windows) the user sees. " +
  "The `agentree` command (also at $AGENTREE_CLI) controls this worktree's tabs: run long-lived processes in their own tab " +
  "with `agentree tab new --name dev -- npm run dev` (opens in the background), read a tab's output with `agentree tab read dev`, " +
  "stop it with `agentree tab send dev --key C-c`, show the user a diff with `agentree diff`, and ask for their attention with " +
  "`agentree notify MESSAGE`. See `agentree --help`.";

/** The SessionStart hook that prints AGENT_CONTEXT — only inside an agentree terminal whose CLI is on hand. */
export function contextHookCommand(): string {
  return `[ -n "$AGENTREE_CLI" ] && [ -n "$AGENTREE_SESSION" ] && printf '%s\\n' ${shellQuote(AGENT_CONTEXT)}; exit 0`;
}

/** The `--settings` JSON: one command hook per event in HOOK_EVENTS, plus the context hook. */
export function hooksSettings(): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const { event, matcher, state } of HOOK_EVENTS) {
    const entries = hooks[event] ?? [];
    hooks[event] = entries;
    entries.push({
      ...(matcher !== undefined && { matcher }),
      hooks: [{ type: "command", command: hookCommand(state), timeout: 5 }],
    });
  }
  hooks.SessionStart!.push({ hooks: [{ type: "command", command: contextHookCommand(), timeout: 5 }] });
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

/**
 * Environment the tmux session gives its panes: where the hooks report, and
 * the CLI (on PATH, and by name in $AGENTREE_CLI) for the agents there.
 */
export function agentSessionEnv(session: string): Record<string, string> {
  const cli = ensureCliOnPath();
  return {
    AGENTREE_AGENT_DIR: agentStatusDir(),
    AGENTREE_SESSION: session,
    AGENTREE_CLI: cli,
    PATH: process.env.PATH ?? "",
  };
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
 * Status files (name + content) and what tmux says about the panes (null: tmux
 * couldn't be asked) → each session's status, plus the files whose pane is
 * gone (their agent died without a SessionEnd), to delete.
 */
export function statusesFrom(
  files: { name: string; content: string }[],
  panes: Map<string, number> | null,
  now: number,
): { statuses: Map<string, AgentReport>; stale: string[] } {
  const bySession = new Map<string, AgentReport[]>();
  const stale: string[] = [];
  for (const { name, content } of files) {
    const report = parseReport(name, content);
    if (!report) continue;
    let state = report.state;
    if (panes) {
      const lastOutput = panes.get(`${report.session}.${report.pane}`);
      if (lastOutput === undefined) {
        stale.push(name);
        continue;
      }
      state = effectiveState(report, lastOutput, now);
    }
    const list = bySession.get(report.session) ?? [];
    list.push({ state, since: report.since });
    bySession.set(report.session, list);
  }
  const statuses = new Map<string, AgentReport>();
  for (const [session, reports] of bySession) {
    const combined = combineReports(reports);
    if (combined) statuses.set(session, combined);
  }
  return { statuses, stale };
}

/**
 * Every local tmux session's current agent status. Reports from panes that no
 * longer exist are deleted (their agent is gone and fired no SessionEnd).
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

  const files: { name: string; content: string }[] = [];
  for (const name of names) {
    try {
      files.push({ name, content: readFileSync(join(dir, name), "utf8") });
    } catch {
      // raced with a hook's rename, or removed
    }
  }
  const { statuses, stale } = statusesFrom(files, await listPaneActivity(), now);
  for (const name of stale) rmSync(join(dir, name), { force: true });
  return statuses;
}

// --- agents on SSH hosts ---

/** Where the hooks on an SSH host write (the same place as here, under its home). */
export function remoteAgentDir(home: string): string {
  return `${home}/.config/agentree/agents`;
}

/** The session environment for an SSH host's terminal, so its hooks report there. */
export function remoteSessionEnv(session: string, home: string): Record<string, string> {
  return { AGENTREE_AGENT_DIR: remoteAgentDir(home), AGENTREE_SESSION: session };
}

const PANES_MARK = "--agentree-panes--";
const NO_TMUX_MARK = "--agentree-no-tmux-server--";

/**
 * The agents' status on an SSH host: its status files and its tmux panes, read
 * in one ssh call (over the host's shared connection), combined as locally;
 * files whose pane is gone are deleted there. `onlyIfConnected` (a password
 * host): nothing unless connected — never a login from a poll.
 */
export async function readRemoteAgentStatuses(
  host: string,
  home: string,
  opts: { onlyIfConnected?: boolean; now?: number } = {},
): Promise<Map<string, AgentReport>> {
  if (opts.onlyIfConnected && !(await isConnected(host))) return new Map();
  const dir = remoteAgentDir(home);
  const script = [
    `d=${shq(dir)}`,
    `if [ -d "$d" ]; then for f in "$d"/*; do [ -f "$f" ] || continue; printf '%s\\t%s\\n' "\${f##*/}" "$(cat "$f" 2>/dev/null)"; done; fi`,
    `echo ${PANES_MARK}`,
    `tmux -u -L ${shq(socketName())} list-panes -a -F '#{session_name}	#{pane_id}	#{window_activity}' 2>/dev/null || echo ${NO_TMUX_MARK}`,
  ].join("; ");
  const { code, stdout } = await run(remoteArgv(host, ["sh", "-c", script]));
  if (code !== 0 && !stdout.includes(PANES_MARK)) return new Map(); // couldn't connect
  const [filePart = "", panePart = ""] = stdout.split(PANES_MARK + "\n");
  const files = filePart
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { name: line.slice(0, tab), content: line.slice(tab + 1) };
    });
  const panes: Map<string, number> | null = new Map();
  if (!panePart.includes(NO_TMUX_MARK)) {
    for (const line of panePart.split("\n")) {
      const [session, paneId, activity] = line.split("\t");
      if (session && paneId) panes.set(`${session}.${paneId.replace(/^%/, "")}`, parseInt(activity || "0", 10) || 0);
    }
  }
  const { statuses, stale } = statusesFrom(files, panes, opts.now ?? Math.floor(Date.now() / 1000));
  if (stale.length > 0) {
    await run(remoteArgv(host, ["rm", "-f", ...stale.map((n) => `${dir}/${n}`)])).catch(() => {});
  }
  return statuses;
}

// --- tracking every claude: the hooks in Claude's user settings ---

/** Claude Code's user settings file (`$CLAUDE_CONFIG_DIR`, else ~/.claude). */
export function claudeSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

type ClaudeSettings = Record<string, unknown> & { hooks?: Record<string, unknown[]> };

/** One of our hook commands (the status hooks read AGENTREE_AGENT_DIR, the context hook AGENTREE_CLI). */
function isOurs(entry: unknown): boolean {
  const hooks = (entry as { hooks?: { command?: unknown }[] } | null)?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((h) => typeof h?.command === "string" && /AGENTREE_(AGENT_DIR|CLI)/.test(h.command))
  );
}

/**
 * Claude settings with agentree's hooks taken out — and, with `install`, put
 * back in, current. Everything else (other hooks, other keys) is kept as it was.
 */
export function withGlobalHooks(settings: ClaudeSettings, install: boolean): ClaudeSettings {
  const hooks: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = Array.isArray(entries) ? entries.filter((e) => !isOurs(e)) : entries;
    if (!Array.isArray(kept) || kept.length > 0) hooks[event] = kept as unknown[];
  }
  if (install) {
    for (const [event, entries] of Object.entries(hooksSettings().hooks)) {
      hooks[event] = [...(hooks[event] ?? []), ...entries];
    }
  }
  const { hooks: _, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

/** Whether settings carry agentree's hooks for every event (i.e. tracking is on). */
export function hasGlobalHooks(settings: ClaudeSettings): boolean {
  return HOOK_EVENTS.every(({ event }) => (settings.hooks?.[event] ?? []).some?.((e: unknown) => isOurs(e)));
}

/** Parse a settings file's text; missing → {}; not a JSON object → throws, so nothing gets overwritten. */
export function parseClaudeSettings(text: string | null): ClaudeSettings {
  if (text === null || !text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
  return parsed as ClaudeSettings;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Whether any claude started in an agentree terminal reports its status (hooks in the user settings). */
export function trackingEveryClaude(): boolean {
  try {
    return hasGlobalHooks(parseClaudeSettings(readText(claudeSettingsPath())));
  } catch {
    return false;
  }
}

/**
 * Turn tracking every claude on or off here: add agentree's hooks to (or take
 * them out of) Claude's user settings. They only act inside agentree
 * terminals. A settings file that isn't valid JSON is left alone (throws).
 */
export function setTrackingEveryClaude(on: boolean): void {
  const path = claudeSettingsPath();
  let settings: ClaudeSettings;
  try {
    settings = parseClaudeSettings(readText(path));
  } catch (err) {
    throw new Error(`${path} isn't valid JSON, so it was left alone (${err instanceof Error ? err.message : err})`);
  }
  const next = withGlobalHooks(settings, on);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".agentree.tmp", JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(path + ".agentree.tmp", path);
}

/**
 * The same on an SSH host: its Claude user settings are read, merged here and
 * written back over the shared connection. "unreachable": not connected (a
 * password host), couldn't connect, or its settings aren't JSON to merge into.
 */
export async function setRemoteTracking(
  host: string,
  on: boolean,
  opts: { onlyIfConnected?: boolean } = {},
): Promise<"changed" | "unchanged" | "unreachable"> {
  if (opts.onlyIfConnected && !(await isConnected(host))) return "unreachable";
  const where = `f="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"`;
  const read = await run(remoteArgv(host, ["sh", "-c", `${where}; cat "$f" 2>/dev/null; true`]));
  if (read.code !== 0) return "unreachable";
  let settings: ClaudeSettings;
  try {
    settings = parseClaudeSettings(read.stdout);
  } catch {
    return "unreachable"; // not ours to repair
  }
  const next = withGlobalHooks(settings, on);
  if (JSON.stringify(next) === JSON.stringify(settings)) return "unchanged";
  const content = JSON.stringify(next, null, 2) + "\n";
  const write = await run(
    remoteArgv(host, ["sh", "-c", `${where}; mkdir -p "$(dirname "$f")" && cat > "$f.agentree.tmp" && mv -f "$f.agentree.tmp" "$f"`]),
    { stdin: content },
  );
  return write.code === 0 ? "changed" : "unreachable";
}
