/**
 * The layout preferences agentree remembers in state.json: the sidebar's width
 * and whether it's hidden, the PR panel's width, whether it's shown and which
 * sections are folded, and the diff viewer. A default isn't stored, so a
 * future change to it still applies.
 */
import type { RefObject } from "react";
import type { PrSection } from "../components/PrPanel";
import {
  DEFAULT_PR_PANEL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MIN_CONTENT_WIDTH,
  MIN_PR_PANEL_WIDTH,
  clampSidebarWidth,
} from "../layout";
import type { DiffViewerId } from "../services/diff";
import { saveState, type State, type UiState } from "../store";
import { useLive } from "./live";

export function usePrefs(
  state: State,
  /** The screen's width, and the rendered side panels (set while rendering). */
  screenWidthRef: RefObject<number>,
  layoutRef: RefObject<{ sidebar: number; panel: number }>,
) {
  // The sidebar width you chose; what's rendered is this clamped to the screen,
  // so shrinking the window doesn't lose it.
  const [sidebarWidth, sidebarWidthRef, setSidebarWidth] = useLive(() => state.ui?.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH);
  const [sidebarHidden, sidebarHiddenRef, setSidebarHidden] = useLive(() => state.ui?.sidebarHidden ?? false);
  const [prPanelHidden, prPanelHiddenRef, setPrPanelHidden] = useLive(() => state.ui?.prPanelHidden ?? false);
  const [prPanelWidth, prPanelWidthRef, setPrPanelWidth] = useLive(() => state.ui?.prPanelWidth ?? DEFAULT_PR_PANEL_WIDTH);
  const [prCollapsed, prCollapsedRef, setPrCollapsed] = useLive(() => (state.ui?.prPanelCollapsed ?? []) as PrSection[]);
  const [diffViewer, , setDiffViewer] = useLive<DiffViewerId | undefined>(() => state.ui?.diffViewer);

  /** Merge UI preferences into state.json; `undefined` drops a field. No-op if nothing changed. */
  const saveUi = (patch: Partial<UiState>) => {
    const ui: Record<string, unknown> = { ...state.ui };
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (ui[key] === value) continue;
      changed = true;
      if (value === undefined) delete ui[key];
      else ui[key] = value;
    }
    if (!changed) return;
    if (Object.keys(ui).length > 0) state.ui = ui as UiState;
    else delete state.ui;
    // Written straight away rather than debounced, so quitting right after a
    // change can't drop it.
    void saveState(state).catch(() => {});
  };

  const sidebar = {
    width: sidebarWidth,
    widthRef: sidebarWidthRef,
    hidden: sidebarHidden,
    hiddenRef: sidebarHiddenRef,
    /** Set the width (clamped to the screen); returns what it became. */
    resize(width: number) {
      const next = clampSidebarWidth(width, screenWidthRef.current);
      setSidebarWidth(next);
      return next;
    },
    /** Remember the width: when a drag is released, and on each `[` `]` `=`. */
    persistWidth() {
      const width = sidebarWidthRef.current;
      saveUi({ sidebarWidth: width === DEFAULT_SIDEBAR_WIDTH ? undefined : width });
    },
    resetWidth() {
      sidebar.resize(DEFAULT_SIDEBAR_WIDTH);
      sidebar.persistWidth();
    },
    setHidden(hidden: boolean) {
      setSidebarHidden(hidden);
      saveUi({ sidebarHidden: hidden || undefined });
    },
  };

  const prPanel = {
    width: prPanelWidth,
    hidden: prPanelHidden,
    collapsed: prCollapsed,
    /** Show / hide it (`p`, ⌥p, its ✕, the tab bar's PR button). */
    toggle() {
      const hidden = !prPanelHiddenRef.current;
      setPrPanelHidden(hidden);
      saveUi({ prPanelHidden: hidden || undefined });
    },
    /** Fold / unfold a section. */
    toggleSection(section: PrSection) {
      const prev = prCollapsedRef.current;
      const next = prev.includes(section) ? prev.filter((s) => s !== section) : [...prev, section];
      setPrCollapsed(next);
      saveUi({ prPanelCollapsed: next.length > 0 ? next : undefined });
    },
    /** Resize it, within what's left beside the sidebar and content. */
    resize(width: number) {
      const room = screenWidthRef.current - layoutRef.current.sidebar - MIN_CONTENT_WIDTH;
      setPrPanelWidth(Math.round(Math.min(Math.max(width, MIN_PR_PANEL_WIDTH), Math.max(room, MIN_PR_PANEL_WIDTH))));
    },
    persistWidth() {
      const width = prPanelWidthRef.current;
      saveUi({ prPanelWidth: width === DEFAULT_PR_PANEL_WIDTH ? undefined : width });
    },
    resetWidth() {
      prPanel.resize(DEFAULT_PR_PANEL_WIDTH);
      prPanel.persistWidth();
    },
  };

  return {
    saveUi,
    sidebar,
    prPanel,
    diffViewer,
    /** The diff viewer picked with `v` in the diff picker. */
    chooseDiffViewer(id: DiffViewerId) {
      setDiffViewer(id);
      saveUi({ diffViewer: id });
    },
  };
}
