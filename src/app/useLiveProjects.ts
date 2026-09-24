/**
 * The projects as the sidebar shows them: state.json's worktrees plus what the
 * query cache knows live (src/queries.ts) — git status and each branch's open
 * PR — and the agents' status. Local git only: an SSH project's directories
 * have no git status or PRs.
 */
import { useEffect, useRef } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { AgentStatus, PrInfo, Project } from "../data/model";
import { gitStatusQuery, prForBranchQuery, queryKeys } from "../queries";
import type { AgentReport } from "../services/agents";
import { sessionName } from "../services/tmux";

/** At most one extra PR lookup this often (agent state changes come in bursts). */
const PR_LOOKUP_THROTTLE_MS = 15_000;

function samePr(a: PrInfo | undefined, b: PrInfo | undefined): boolean {
  if (!a || !b) return a === b;
  return a.number === b.number && a.title === b.title && a.url === b.url && a.draft === b.draft && a.checks === b.checks;
}

export function useLiveProjects(
  projects: Project[],
  agentStatus: Record<string, AgentStatus>,
  agentReports: Record<string, AgentReport>,
) {
  const queryClient = useQueryClient();
  const liveWorktrees = projects
    .filter((p) => !p.ssh)
    .flatMap((p) => p.worktrees.filter((w) => !w.missing).map((w) => ({ repoId: p.id, worktree: w })));

  // Git status (dirty, changed files, +/−, ahead/behind) — polled per worktree,
  // invalidated when an agent changes state (it has probably touched files).
  const gitStatuses = useQueries({
    queries: liveWorktrees.map(({ worktree }) => gitStatusQuery(worktree.path)),
  });

  // Each branch's open PR (the ⇡#N badge) — polled every minute, invalidated
  // when an agent changes state and on `r`. A failed lookup keeps the last
  // answer rather than dropping the badge.
  const prTargets = liveWorktrees.filter(({ worktree: w }) => w.branch && w.branch !== "(detached)");
  const branchPrs = useQueries({
    queries: prTargets.map(({ repoId, worktree }) => prForBranchQuery(repoId, worktree.branch)),
  });

  // A PR whose checks or title moved has newer details too: mark its cached
  // details stale, so the panel refetches them when it next shows that PR.
  const knownPrs = useRef(new Map<string, PrInfo>());
  const branchPrSig = branchPrs.map((q) => JSON.stringify(q.data ?? null)).join("|");
  useEffect(() => {
    const next = new Map<string, PrInfo>();
    prTargets.forEach(({ repoId }, i) => {
      const pr = branchPrs[i]?.data;
      if (!pr) return;
      const key = `${repoId}#${pr.number}`;
      const before = knownPrs.current.get(key);
      if (before && !samePr(before, pr)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.prDetails(repoId, pr.number) });
      }
      next.set(key, pr);
    });
    knownPrs.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchPrSig]);

  /** Re-ask GitHub for every branch's PR, at most once per PR_LOOKUP_THROTTLE_MS. */
  const lastPrLookup = useRef(0);
  const refreshPrsSoon = () => {
    const now = Date.now();
    if (now - lastPrLookup.current < PR_LOOKUP_THROTTLE_MS) return;
    lastPrLookup.current = now;
    void queryClient.invalidateQueries({ queryKey: queryKeys.allPrForBranch });
  };

  // An agent changing state has probably touched files, and may have opened
  // or pushed to a PR.
  const reportsSig = JSON.stringify(agentReports);
  const lastReportsSig = useRef<string | null>(null);
  useEffect(() => {
    if (lastReportsSig.current !== null && lastReportsSig.current !== reportsSig) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.allGitStatus });
      refreshPrsSoon();
    }
    lastReportsSig.current = reportsSig;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportsSig]);

  const statusByPath = new Map(liveWorktrees.map(({ worktree }, i) => [worktree.path, gitStatuses[i]?.data]));
  const prByWorktree = new Map(prTargets.map(({ repoId, worktree }, i) => [`${repoId}:${worktree.id}`, branchPrs[i]?.data]));
  const viewProjects: Project[] = projects.map((p) => ({
    ...p,
    worktrees: p.worktrees.map((w) => {
      const st = w.missing ? undefined : statusByPath.get(w.path);
      const pr = prByWorktree.get(`${p.id}:${w.id}`) ?? undefined;
      return { ...w, ...st, pr, agent: agentStatus[sessionName(p.id, w.id)] ?? "none" };
    }),
  }));

  return {
    viewProjects,
    /** `r`: look every branch's PR up again now (and don't re-ask for a while). */
    refreshPrs() {
      lastPrLookup.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: queryKeys.allPrForBranch });
    },
  };
}
