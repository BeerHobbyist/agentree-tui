/**
 * Entry point. `agentree <command>` runs a CLI command (src/cli.ts) — what the
 * agents in its terminals call — and exits; plain `agentree` opens the app.
 */
import { isCliInvocation, runCli } from "./cli";

const args = process.argv.slice(2);
if (isCliInvocation(args)) {
  process.exit(await runCli(args));
} else {
  const { startTui } = await import("./tui");
  await startTui();
}
