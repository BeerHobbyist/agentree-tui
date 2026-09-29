/**
 * The app's pop-ups — prompts, confirmations, notices — as one stack. The top
 * one is on screen and owns the keyboard (the app's own keys stay inert while
 * any is open); closing it shows the one below. One place to add a pop-up,
 * instead of a state, a ref and a keyboard guard each.
 */
import type { PrInfo } from "../data/model";
import { AddWorktreeModal, type PreselectRepo, type Selection } from "../components/AddWorktreeModal";
import { type Command, CommandPalette } from "../components/CommandPalette";
import { ConfirmModal } from "../components/ConfirmModal";
import { HelpOverlay } from "../components/HelpOverlay";
import { MergeModal } from "../components/MergeModal";
import { RenameModal } from "../components/RenameModal";
import { SshModal } from "../components/SshModal";
import type { Project } from "../data/model";
import { claudeSettingsPath } from "../services/agents";
import type { MergeMethod } from "../services/pr";
import { MAX_LABEL_LENGTH, type State } from "../store";
import { useLive } from "./live";

export type Overlay =
  /** Add a worktree (or a project): `n`, `a`, a header's ＋. */
  | { kind: "add"; preselect: PreselectRepo | null }
  /** Add an SSH host, or a directory to one: `s`, its ＋. */
  | { kind: "ssh"; host?: string }
  | { kind: "help" }
  /** The command palette (`ctrl+p`). */
  | { kind: "palette" }
  /** Delete a worktree from disk (`d`). `what` names it: `"label" (branch)`, or `"name"`. */
  | { kind: "close-worktree"; repoId: string; worktreeId: string; what: string; dirty: boolean; missing: boolean }
  /** Forget a repo project and its worktrees, leaving them on disk (`d` on its header). */
  | { kind: "remove-project"; repoId: string; name: string }
  /** Forget an SSH directory, or (no `dirId`) the whole host (`d`). */
  | { kind: "forget"; host: string; dirId?: string; what: string; needsPassword?: boolean }
  /** Turn tracking every claude on or off (`H`) — it edits Claude's settings, so it asks. */
  | { kind: "tracking"; on: boolean }
  /** Merge the PR on screen (`m`); `worktreeId` is its worktree, which `d` can close after. */
  | { kind: "merge"; repo: string; pr: PrInfo; worktreeId: string }
  /** A worktree's label (`R`, right-click). */
  | { kind: "rename"; repoId: string; worktreeId: string; label: string; name: string; branch: string };

export type OverlayKind = Overlay["kind"];

/** A pop-up opened on top of the stack — replacing one of the same kind (there's only ever one of each). */
export function withOpened(stack: readonly Overlay[], overlay: Overlay): Overlay[] {
  return [...stack.filter((o) => o.kind !== overlay.kind), overlay];
}

/** The stack without the top pop-up — or, given a kind, without that one wherever it is. */
export function withClosed(stack: readonly Overlay[], kind?: OverlayKind): Overlay[] {
  return kind === undefined ? stack.slice(0, -1) : stack.filter((o) => o.kind !== kind);
}

/** The stack. `open` puts a pop-up on top; `close` takes one off. */
export function useOverlays() {
  const [stack, stackRef, setStack] = useLive<Overlay[]>([]);
  return {
    top: stack.at(-1),
    /** For the keyboard handler: is any pop-up up, and which is on top (current even mid key burst). */
    topRef: {
      get current() {
        return stackRef.current.at(-1);
      },
    },
    open: (overlay: Overlay) => setStack(withOpened(stackRef.current, overlay)),
    close: (kind?: OverlayKind) => setStack(withClosed(stackRef.current, kind)),
  };
}

export type Overlays = ReturnType<typeof useOverlays>;

/** What the pop-ups do when answered — the app's handlers. */
export interface OverlayActions {
  state: State;
  themeName: string;
  onApplied(projects: Project[], selection: Selection): void;
  closeWorktree(target: Extract<Overlay, { kind: "close-worktree" }>): void;
  removeProject(target: Extract<Overlay, { kind: "remove-project" }>): void;
  forget(target: Extract<Overlay, { kind: "forget" }>): void;
  setTracking(on: boolean): void;
  saveLabel(target: Extract<Overlay, { kind: "rename" }>, label: string): void;
  merged(method: MergeMethod): void;
  /** After a merge, `d`: ask to close the PR's worktree. */
  closeMergedWorktree(target: Extract<Overlay, { kind: "merge" }>): void;
  /** What the palette offers now. */
  paletteCommands(): Command[];
}

/** The pop-up on top of the stack, if any. */
export function OverlayLayer({ overlays, actions }: { overlays: Overlays; actions: OverlayActions }) {
  const o = overlays.top;
  if (!o) return null;
  const close = () => overlays.close(o.kind);
  switch (o.kind) {
    case "add":
      return (
        <AddWorktreeModal state={actions.state} preselect={o.preselect} onClose={close} onApplied={actions.onApplied} />
      );
    case "ssh":
      return <SshModal state={actions.state} host={o.host} onClose={close} onAdded={actions.onApplied} />;
    case "help":
      return <HelpOverlay themeName={actions.themeName} onClose={close} />;
    case "palette":
      return <CommandPalette commands={actions.paletteCommands()} onClose={close} />;
    case "close-worktree":
      return (
        <ConfirmModal
          title="Close worktree"
          message={`Delete ${o.what} from disk? This cannot be undone.`}
          detail={
            o.missing
              ? "Already gone on disk — this only forgets it."
              : o.dirty
                ? "It has uncommitted changes, which will be lost."
                : undefined
          }
          onConfirm={() => actions.closeWorktree(o)}
          onCancel={close}
        />
      );
    case "remove-project":
      return (
        <ConfirmModal
          title="Remove project"
          message={`Remove ${o.name} and its worktrees from agentree?`}
          detail="Their terminals end (and anything running in them); the clone and its worktrees stay on disk."
          onConfirm={() => actions.removeProject(o)}
          onCancel={close}
        />
      );
    case "forget":
      return (
        <ConfirmModal
          title={o.dirId ? "Remove directory" : "Remove host"}
          message={
            o.dirId
              ? `Remove ${o.what} on ${o.host} from agentree?`
              : `Remove ${o.host} and its directories from agentree?`
          }
          detail={
            o.needsPassword
              ? "Their tmux sessions on the host end if agentree is connected to it right now (it logs in with a password); no files are touched."
              : "Their tmux sessions on the host end (and anything running in them); no files are touched."
          }
          onConfirm={() => actions.forget(o)}
          onCancel={close}
        />
      );
    case "tracking":
      return (
        <ConfirmModal
          title={o.on ? "Track every claude" : "Stop tracking every claude"}
          message={
            o.on
              ? `Show the status of any claude you start in an agentree terminal — not just the ones agentree starts? This adds agentree's hooks to ${claudeSettingsPath()} (and on SSH hosts, once you open one).`
              : `Take agentree's hooks out of ${claudeSettingsPath()} (and SSH hosts you have open)? The agents agentree starts keep reporting.`
          }
          detail={
            o.on
              ? "They do nothing outside agentree terminals, and your other settings are left as they are. H again takes them out."
              : undefined
          }
          onConfirm={() => actions.setTracking(o.on)}
          onCancel={close}
        />
      );
    case "merge":
      return (
        <MergeModal
          repo={o.repo}
          pr={o.pr}
          preferred={actions.state.ui?.mergeMethod}
          onMerged={actions.merged}
          onCloseWorktree={() => actions.closeMergedWorktree(o)}
          onClose={close}
        />
      );
    case "rename":
      return (
        <RenameModal
          initial={o.label}
          heading={`Label for ${o.branch}`}
          placeholder={o.name}
          note="Only the label changes — the branch and folder keep their names. Empty goes back to the branch name."
          maxLength={MAX_LABEL_LENGTH}
          onSave={(label) => actions.saveLabel(o, label)}
          onCancel={close}
        />
      );
  }
}
