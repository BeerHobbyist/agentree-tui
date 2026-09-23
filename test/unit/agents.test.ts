import { describe, expect, test } from "bun:test";
import {
  HOOK_EVENTS,
  WORKING_SILENCE_S,
  combineReports,
  effectiveState,
  hooksSettings,
  parseReport,
  withStatusHooks,
} from "../../src/services/agents";

describe("parseReport", () => {
  test("reads the session and pane from the name and the state from the content", () => {
    expect(parseReport("agentree_acme-widget-x_1a2b3c4d.3", "working 1790000000\n")).toEqual({
      session: "agentree_acme-widget-x_1a2b3c4d",
      pane: "3",
      state: "working",
      since: 1790000000,
    });
  });

  test("skips a hook's in-flight temp file", () => {
    expect(parseReport("agentree_x.3.tmp", "working 1")).toBeNull();
  });

  test("rejects unknown states and garbage timestamps", () => {
    expect(parseReport("agentree_x.3", "sleeping 1790000000")).toBeNull();
    expect(parseReport("agentree_x.3", "working soon")).toBeNull();
    expect(parseReport("agentree_x.3", "")).toBeNull();
    expect(parseReport("no-pane", "working 1")).toBeNull();
  });
});

describe("effectiveState", () => {
  const now = 2_000_000;

  test("trusts a report while the pane keeps printing", () => {
    expect(effectiveState({ state: "working", since: now - 60 }, now - 1, now)).toBe("working");
  });

  test("a working agent that has gone quiet was interrupted (Esc fires no hook)", () => {
    const silent = now - WORKING_SILENCE_S;
    expect(effectiveState({ state: "working", since: now - 60 }, silent, now)).toBe("idle");
  });

  test("a prompt submitted just now isn't mistaken for silence", () => {
    // The window's last output predates the prompt, but it's only a second old.
    expect(effectiveState({ state: "working", since: now - 1 }, now - 300, now)).toBe("working");
  });

  test("needs-action turns back to working once the agent prints again", () => {
    expect(effectiveState({ state: "needs-action", since: now - 5 }, now, now)).toBe("working");
    expect(effectiveState({ state: "needs-action", since: now - 5 }, now - 5, now)).toBe(
      "needs-action",
    );
  });

  test("leaves done and idle alone", () => {
    expect(effectiveState({ state: "done", since: now - 100 }, now - 100, now)).toBe("done");
    expect(effectiveState({ state: "idle", since: now - 100 }, now - 100, now)).toBe("idle");
  });
});

describe("combineReports", () => {
  test("a worktree with several agents shows the most urgent", () => {
    const combined = combineReports([
      { state: "working", since: 10 },
      { state: "needs-action", since: 5 },
      { state: "done", since: 20 },
    ]);
    expect(combined?.state).toBe("needs-action");
  });

  test("among equals, the latest wins", () => {
    expect(combineReports([{ state: "done", since: 10 }, { state: "done", since: 30 }])?.since).toBe(
      30,
    );
  });

  test("nothing to combine", () => {
    expect(combineReports([])).toBeUndefined();
  });
});

describe("withStatusHooks", () => {
  const path = "/home/me/.config/agentree/claude-hooks.json";

  test("attaches the hooks to a claude launch", () => {
    expect(withStatusHooks("claude", path)).toBe(`claude --settings '${path}'`);
    expect(withStatusHooks("caffeinate -is claude", path)).toBe(
      `caffeinate -is claude --settings '${path}'`,
    );
    expect(withStatusHooks("claude --model opus", path)).toBe(
      `claude --model opus --settings '${path}'`,
    );
  });

  test("leaves other agents and explicit --settings alone", () => {
    expect(withStatusHooks("codex", path)).toBe("codex");
    expect(withStatusHooks("claude --settings mine.json", path)).toBe(
      "claude --settings mine.json",
    );
  });

  test("quotes the settings path for the shell", () => {
    expect(withStatusHooks("claude", "/it's/here.json")).toBe(
      `claude --settings '/it'\\''s/here.json'`,
    );
  });
});

describe("hooksSettings", () => {
  const { hooks } = hooksSettings();

  test("registers one command hook for every event it maps", () => {
    expect(Object.keys(hooks).sort()).toEqual(HOOK_EVENTS.map((e) => e.event).sort());
    for (const entries of Object.values(hooks)) {
      const [entry] = entries as { hooks: { type: string; command: string }[] }[];
      expect(entry!.hooks[0]!.type).toBe("command");
    }
  });

  test("only blocking notifications count as needs-action", () => {
    const [notification] = hooks.Notification as { matcher: string }[];
    expect(notification!.matcher).toContain("permission_prompt");
    expect(notification!.matcher).not.toContain("idle_prompt");
  });
});
