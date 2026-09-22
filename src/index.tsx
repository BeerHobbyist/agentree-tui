/**
 * Entry point: load state, reconcile it against git, mount the app.
 *
 * Kept free of UI so `App` can be rendered headlessly by the tests.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { loadState, reconcile } from "./store";

const state = loadState();
const initialProjects = await reconcile(state);
// exitOnCtrlC is disabled so Ctrl+C reaches the focused terminal (the shell);
// the app provides its own quit (Ctrl+C / q while the sidebar is focused).
const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: false });
createRoot(renderer).render(
  <App initialProjects={initialProjects} state={state} />,
);
