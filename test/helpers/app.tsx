/**
 * Mount the whole app headlessly, the way `src/index.tsx` does at startup.
 */
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { App } from "../../src/app";
import { loadState, reconcile, type State } from "../../src/store";

export interface RenderAppOptions {
  width?: number;
  height?: number;
}

export interface RenderedApp extends TestRendererSetup {
  /** The state object the app is mutating (same instance it was handed). */
  state: State;
  /** How many times the app tried to quit. */
  quitCount(): number;
  dispose(): void;
}

/** Load state from the sandbox, reconcile it against git, and render `App`. */
export async function renderApp(opts: RenderAppOptions = {}): Promise<RenderedApp> {
  const state = loadState();
  const initialProjects = await reconcile(state);
  let quits = 0;

  const setup = await testRender(
    <App initialProjects={initialProjects} state={state} onQuit={() => void quits++} />,
    { width: opts.width ?? 100, height: opts.height ?? 30 },
  );

  // `testRender` turns React's act environment on, but the app updates from
  // promises (git/gh subprocesses) that no act() call can wrap; leaving it on
  // would print an act(...) warning per keystroke. The initial render above
  // already went through act().
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

  return {
    ...setup,
    state,
    quitCount: () => quits,
    dispose() {
      try {
        setup.renderer.destroy();
      } catch {
        // already torn down
      }
    },
  };
}
