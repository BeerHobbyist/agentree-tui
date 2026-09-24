/**
 * The agents' status, per tmux session: reported by their hooks (see
 * services/agents) — here, and on the SSH hosts whose terminals are open — with
 * "done" turned into "idle" once its terminal has been on screen. Also keeps
 * SSH hosts' hooks in place while tracking every claude is on, and notifies
 * the user when an agent needs them or finishes while they're elsewhere.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { focusManager, useQueries, useQuery } from "@tanstack/react-query";
import { displayName, type AgentStatus, type Project } from "../data/model";
import { agentStatusQuery, remoteAgentStatusQuery, trackingQuery } from "../queries";
import { setRemoteTracking, type AgentReport } from "../services/agents";
import { notify } from "../services/notify";
import { sessionName } from "../services/tmux";

export interface RemoteHost {
  host: string;
  home: string;
  needsPassword: boolean;
}

export function useAgents(
  projects: Project[],
  /** Worktrees whose terminals are open (mounted), and the one on screen. */
  opened: { repoId: string; worktreeId: string }[],
  open: { repoId: string; worktreeId: string } | null,
  /** The projects as shown (display names), for notifications. */
  projectsRef: RefObject<Project[]>,
) {
  const localReports = useQuery(agentStatusQuery()).data;
  // SSH hosts with a terminal open here: their agents report on the host, read over ssh.
  const remoteHosts: RemoteHost[] = projects
    .filter((p) => p.ssh?.home && opened.some((o) => o.repoId === p.id))
    .map((p) => ({ host: p.ssh!.host, home: p.ssh!.home!, needsPassword: !!p.ssh!.needsPassword }));
  const remoteReports = useQueries({
    queries: remoteHosts.map((h) => remoteAgentStatusQuery(h.host, h.home, h.needsPassword)),
  });
  const remoteSig = remoteReports.map((q) => JSON.stringify(q.data ?? null)).join("|");
  const reports = useMemo(() => {
    const all: Record<string, AgentReport> = { ...localReports };
    for (const q of remoteReports) Object.assign(all, q.data);
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localReports, remoteSig]);

  // Tracking every claude (H): agentree's hooks in Claude's user settings, here
  // and — once one of their terminals is open — on SSH hosts.
  const tracking = useQuery(trackingQuery()).data ?? false;
  const hookedHosts = useRef(new Set<string>());
  const hookingHosts = useRef(new Set<string>());
  const remotePolls = remoteReports.map((q) => q.dataUpdatedAt).join(",");
  useEffect(() => {
    if (!tracking) {
      hookedHosts.current.clear();
      return;
    }
    for (const h of remoteHosts) {
      if (hookedHosts.current.has(h.host) || hookingHosts.current.has(h.host)) continue;
      hookingHosts.current.add(h.host);
      void setRemoteTracking(h.host, true, { onlyIfConnected: h.needsPassword })
        .then((result) => {
          if (result !== "unreachable") hookedHosts.current.add(h.host);
        })
        .finally(() => hookingHosts.current.delete(h.host));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking, remotePolls]);

  const openSession = open ? sessionName(open.repoId, open.worktreeId) : null;
  /** When each session's terminal was last on screen (epoch seconds). */
  const [seenAt, setSeenAt] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!openSession) return;
    const now = Math.floor(Date.now() / 1000);
    setSeenAt((prev) => (prev[openSession] === now ? prev : { ...prev, [openSession]: now }));
  }, [openSession, reports]);
  const status: Record<string, AgentStatus> = {};
  for (const [session, r] of Object.entries(reports)) {
    const seen = session === openSession || (seenAt[session] ?? 0) >= r.since;
    status[session] = r.state === "done" && seen ? "idle" : r.state;
  }

  // Tell the user when an agent starts needing them or finishes — unless
  // they're looking at it (its terminal on screen, in a focused window). Only
  // for changes since agentree started watching: an old "done" found at
  // startup, or on a host opened later, isn't news.
  const [watchingSince] = useState(() => Math.floor(Date.now() / 1000));
  const notified = useRef<Record<string, AgentStatus>>({});
  const statusSig = JSON.stringify(status);
  useEffect(() => {
    for (const [session, state] of Object.entries(status)) {
      const before = notified.current[session];
      notified.current[session] = state;
      if (state !== "needs-action" && state !== "done") continue;
      if (before === state || (reports[session]?.since ?? 0) < watchingSince) continue;
      if (session === openSession && focusManager.isFocused()) continue;
      const where = projectsRef.current
        .flatMap((p) => p.worktrees.map((w) => ({ p, w })))
        .find(({ p, w }) => sessionName(p.id, w.id) === session);
      if (!where) continue;
      const name = displayName(where.w);
      notify(state === "needs-action" ? `${name} needs you` : `${name} is done`, where.p.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusSig]);

  return {
    /** Each session's last report (as the hooks wrote it, corrected by tmux). */
    reports,
    /** Each session's status as shown. */
    status,
    tracking,
    /** SSH hosts with a terminal open. */
    remoteHosts,
    /** SSH hosts whose hooks are in place (tracking on). */
    hookedHosts,
  };
}
