import { useRef, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "../theme";
import { Dialog, rowLook } from "./Dialog";
import { Hints, hintsFrom } from "./Hints";
import type { PrInfo } from "../data/model";
import { mergeSettingsQuery, prDetailsQuery, queryKeys } from "../queries";
import { MERGE_METHODS, mergeOptions, mergePr, mergeStatus, type MergeMethod } from "../services/pr";

interface MergeModalProps {
  /** `owner/name` of the repo. */
  repo: string;
  pr: PrInfo;
  /** The method picked last time, offered first. */
  preferred?: MergeMethod;
  /** A merge (or auto-merge) went through with this method. */
  onMerged: (method: MergeMethod) => void;
  /** After a merge: close the PR's worktree (`d`; that asks first). */
  onCloseWorktree?: () => void;
  onClose: () => void;
}

type Phase =
  | { kind: "choose" }
  // `auto`: enabling auto-merge rather than merging now — fixed when picked, as
  // the PR's details refresh underneath.
  | { kind: "confirm"; method: MergeMethod; auto: boolean }
  | { kind: "merging"; method: MergeMethod; auto: boolean }
  | { kind: "done"; method: MergeMethod; auto: boolean }
  | { kind: "error"; message: string };

/**
 * Merge the PR on screen: pick a method (only those the repo allows), then
 * confirm. A PR that's blocked (review required, checks running) can instead
 * be set to merge once it's ready, when the repo allows auto-merge. Nothing is
 * merged without the confirm step. Owns the keyboard while open.
 */
export function MergeModal({ repo, pr, preferred, onMerged, onCloseWorktree, onClose }: MergeModalProps) {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const detailsQ = useQuery(prDetailsQuery(repo, pr.number));
  const settingsQ = useQuery(mergeSettingsQuery(repo));
  const d = detailsQ.data;
  const settings = settingsQ.data;

  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const [index, setIndex] = useState(0);
  // Mirrors, so a burst of keys acts on current values.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const indexRef = useRef(index);
  indexRef.current = index;
  const go = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };
  const moveTo = (i: number) => {
    indexRef.current = i;
    setIndex(i);
  };

  const options = d && settings ? mergeOptions(d, settings) : null;
  const canMerge = !!options && (options.now || options.auto);
  const auto = !!options && !options.now && options.auto;
  // The repo's methods, the one used last time first.
  const methods = settings
    ? [...settings.methods].sort((a, b) => Number(b === preferred) - Number(a === preferred))
    : [];
  const methodsRef = useRef(methods);
  methodsRef.current = methods;
  const canMergeRef = useRef(canMerge);
  canMergeRef.current = canMerge;
  const autoRef = useRef(auto);
  autoRef.current = auto;

  const labelOf = (m: MergeMethod) => MERGE_METHODS.find((x) => x.method === m)!;
  const into = d?.base || "the base branch";

  const merge = (method: MergeMethod, auto: boolean) => {
    go({ kind: "merging", method, auto });
    mergePr(repo, pr.number, method, { auto, headSha: d?.headSha || undefined })
      .then(() => {
        go({ kind: "done", method, auto });
        onMerged(method);
      })
      .catch((err) => go({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        // The badge and the panel catch up (a merged PR's badge says so).
        void queryClient.invalidateQueries({ queryKey: queryKeys.prDetails(repo, pr.number) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.allPrForBranch });
      });
  };

  const pick = (i: number) => {
    const method = methodsRef.current[i];
    if (method && canMergeRef.current) go({ kind: "confirm", method, auto: autoRef.current });
  };

  useKeyboard((key) => {
    key.preventDefault();
    key.stopPropagation();
    const n = key.name;
    const p = phaseRef.current;
    switch (p.kind) {
      case "choose":
        if (n === "escape" || n === "q") onClose();
        else if (n === "down" || n === "j") moveTo(Math.min(indexRef.current + 1, methodsRef.current.length - 1));
        else if (n === "up" || n === "k") moveTo(Math.max(indexRef.current - 1, 0));
        else if (n === "return") pick(indexRef.current);
        return;
      case "confirm":
        if (n === "y" || n === "return") merge(p.method, p.auto);
        else if (n === "n" || n === "escape") go({ kind: "choose" });
        return;
      case "merging":
        return; // wait for gh
      case "done":
        if (n === "d" && !p.auto && onCloseWorktree) onCloseWorktree();
        else if (n === "return" || n === "escape" || n === "q") onClose();
        return;
      case "error":
        if (n === "return" || n === "escape") go({ kind: "choose" });
        return;
    }
  });

  const hint = (text: string) => <Hints marginTop={1} hints={hintsFrom(text)} />;

  const body = () => {
    if (!d || !settings) {
      const failed = detailsQ.error ?? settingsQ.error;
      return failed ? (
        <>
          <text fg={theme.removed} wrapMode="word">
            {failed instanceof Error ? failed.message : String(failed)}
          </text>
          {hint("esc close")}
        </>
      ) : (
        <text fg={theme.fgMuted}>{"Checking what this repo allows…"}</text>
      );
    }
    const status = mergeStatus(d);
    switch (phase.kind) {
      case "choose":
        return (
          <>
            <text fg={status.tone === "good" ? theme.added : status.tone === "bad" ? theme.removed : theme.dirty}>
              {"● " + status.label}
            </text>
            {!canMerge ? (
              <>
                <text fg={theme.fgMuted} marginTop={1} wrapMode="word">
                  {`Can't merge from here: ${options?.reason ?? status.label}.`}
                </text>
                {hint("esc close")}
              </>
            ) : (
              <>
                {auto && (
                  <text fg={theme.fgMuted} marginTop={1} wrapMode="word">
                    {"Not mergeable yet — pick a method to merge it automatically once it is (auto-merge)."}
                  </text>
                )}
                <box flexDirection="column" marginTop={1}>
                  {methods.map((m, i) => {
                    const look = rowLook(theme, i === index);
                    return (
                      <box
                        key={m}
                        flexDirection="row"
                        backgroundColor={look.bg}
                        onMouseDown={() => {
                          moveTo(i);
                          pick(i);
                        }}
                      >
                        <text fg={look.marker}>{i === index ? " ▶ " : "   "}</text>
                        <text fg={look.fg} attributes={look.bold}>
                          {labelOf(m).label + (auto ? " when ready" : "")}
                        </text>
                      </box>
                    );
                  })}
                </box>
                {hint("↑↓ choose · ⏎ next · esc cancel")}
              </>
            )}
          </>
        );
      case "confirm":
        return (
          <>
            <text fg={theme.fg} wrapMode="word">
              {phase.auto
                ? `Set #${pr.number} to ${labelOf(phase.method).verb} into ${into} once it's ready?`
                : labelOf(phase.method).ask(`#${pr.number}`, into)}
            </text>
            <text fg={theme.fgMuted} marginTop={1} wrapMode="word">
              {phase.auto
                ? "GitHub merges it once reviews and required checks pass; you can turn auto-merge off there. Your worktree stays as it is."
                : "Merges on GitHub. Your worktree and its local branch stay as they are."}
            </text>
            {hint("y / ⏎ confirm · n / esc back")}
          </>
        );
      case "merging":
        return <text fg={theme.fgMuted}>{phase.auto ? "Enabling auto-merge…" : `Merging #${pr.number}…`}</text>;
      case "done":
        return (
          <>
            <text fg={theme.added} wrapMode="word">
              {phase.auto
                ? `✓ Auto-merge on: #${pr.number} will ${labelOf(phase.method).verb} into ${into} once it's ready.`
                : `✓ Merged #${pr.number} into ${into}.`}
            </text>
            {/* Done with the branch: its worktree can go too (that asks first). */}
            {hint(!phase.auto && onCloseWorktree ? "d close the worktree · ⏎ / esc keep it" : "⏎ / esc close")}
          </>
        );
      case "error":
        return (
          <>
            <text fg={theme.removed} wrapMode="word">
              {"Couldn't merge: " + phase.message}
            </text>
            {hint("⏎ / esc back")}
          </>
        );
    }
  };

  return (
    <Dialog
      title={`Merge #${pr.number}`}
      width={62}
      // Not while gh is merging: it's going through either way.
      onClose={phase.kind === "merging" ? undefined : onClose}
      zIndex={150}
    >
      <text fg={theme.fg} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
        {d?.title ?? pr.title}
      </text>
      {d && (
        <text fg={theme.fgMuted} wrapMode="none" truncate marginBottom={1}>
          {`${d.base} ← ${d.head}`}
        </text>
      )}
      {body()}
    </Dialog>
  );
}
