/**
 * Open a URL in the user's browser. `AGENTREE_OPEN_CMD` overrides the opener
 * (tests point it at a fake, so a test run never launches a browser).
 */
import { spawn } from "node:child_process";

export function openerCommand(): string {
  return process.env.AGENTREE_OPEN_CMD || (process.platform === "darwin" ? "open" : "xdg-open");
}

/** Fire and forget: the opener is detached, and a missing one is ignored. */
export function openExternal(url: string): void {
  if (!/^https?:\/\//.test(url)) return;
  try {
    const child = spawn(openerCommand(), [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no opener available — nothing to do
  }
}
