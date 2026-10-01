/**
 * The app: load state, reconcile it against git, mount the UI.
 *
 * Kept apart from the entry point so `agentree <command>` (src/cli.ts) never
 * loads the UI, and free of UI setup so `App` can be rendered headlessly by
 * the tests.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { startBroker } from "./services/broker";
import { loadState, reconcile } from "./store";

export async function startTui(): Promise<void> {
  // Tabs for the agents in a sandbox (src/services/broker.ts), while the app runs.
  const broker = await startBroker().catch(() => null);
  if (broker) process.on("exit", () => broker.stop());
  const state = loadState();
  const initialProjects = await reconcile(state);
  // exitOnCtrlC is disabled so Ctrl+C reaches the focused terminal (the shell);
  // the app provides its own quit (Ctrl+C / q while the sidebar is focused).
  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: false });
  createRoot(renderer).render(<App initialProjects={initialProjects} state={state} />);
}
