/** The agent CLI's pieces that don't need tmux. */
import { describe, expect, test } from "bun:test";
import { HELP, isCliInvocation, parseArgs } from "../../src/cli";
import { AGENT_CONTEXT, contextHookCommand, hooksSettings } from "../../src/services/agents";
import { cliLauncherScript } from "../../src/services/self";
import { SKILL_TEXT } from "../../src/services/skill";

describe("isCliInvocation", () => {
  test("commands run the CLI; nothing (or anything else) opens the app", () => {
    expect(isCliInvocation(["tab", "list"])).toBe(true);
    expect(isCliInvocation(["--help"])).toBe(true);
    expect(isCliInvocation(["status"])).toBe(true);
    expect(isCliInvocation([])).toBe(false);
    expect(isCliInvocation(["--weird"])).toBe(false);
  });
});

describe("parseArgs", () => {
  test("positionals, valued flags (both spellings), switches, repeats, and the command after --", () => {
    const a = parseArgs(["tab", "new", "--name", "dev", "--select", "--cwd=/srv", "--", "npm", "run", "--port", "3000"]);
    expect(a.positional).toEqual(["tab", "new"]);
    expect(a.flags.get("name")).toEqual(["dev"]);
    expect(a.flags.get("cwd")).toEqual(["/srv"]);
    expect(a.flags.has("select")).toBe(true);
    expect(a.rest).toEqual(["npm", "run", "--port", "3000"]);
    expect(parseArgs(["send", "dev", "--key", "C-c", "--key", "Enter"]).flags.get("key")).toEqual(["C-c", "Enter"]);
  });

  test("a valued flag without its value is an error", () => {
    expect(() => parseArgs(["tab", "new", "--name"])).toThrow("--name needs a value");
  });
});

describe("what agents are told", () => {
  test("help lists every command", () => {
    for (const cmd of ["tab list", "tab new", "tab read", "tab send", "tab close", "diff", "notify", "status", "skill"]) {
      expect(HELP).toContain(`agentree ${cmd}`);
    }
  });

  test("the SessionStart context hook speaks only inside an agentree terminal", () => {
    const run = (env: Record<string, string>) =>
      new TextDecoder().decode(Bun.spawnSync(["sh", "-c", contextHookCommand()], { env: { PATH: "/usr/bin:/bin", ...env } }).stdout);
    expect(run({})).toBe("");
    expect(run({ AGENTREE_CLI: "/x/agentree" })).toBe(""); // no session
    expect(run({ AGENTREE_CLI: "/x/agentree", AGENTREE_SESSION: "s" })).toBe(AGENT_CONTEXT + "\n");
  });

  test("it's part of the hooks, on SessionStart", () => {
    expect(JSON.stringify(hooksSettings().hooks.SessionStart)).toContain("AGENTREE_CLI");
  });

  test("the skill has the frontmatter Claude Code needs", () => {
    expect(SKILL_TEXT).toMatch(/^---\nname: agentree\ndescription: .+\n---\n/);
    expect(SKILL_TEXT).toContain("agentree tab new --name dev -- npm run dev");
  });
});

describe("cliLauncherScript", () => {
  test("under bun, it runs the source entry point; compiled, the binary itself", () => {
    expect(cliLauncherScript("/usr/bin/bun")).toMatch(/exec \/usr\/bin\/bun \S+\/src\/index\.tsx "\$@"/);
    expect(cliLauncherScript("/opt/agentree/agentree")).toContain('exec /opt/agentree/agentree "$@"');
  });
});
