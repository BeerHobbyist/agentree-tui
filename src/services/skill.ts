/**
 * The agentree skill for Claude Code: when and how an agent in an agentree
 * terminal should use the CLI. Its source is skills/agentree/SKILL.md (bundled
 * into the binary); `agentree skill install` copies it into Claude's skills.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import SKILL from "../../skills/agentree/SKILL.md" with { type: "text" };

export const SKILL_TEXT: string = SKILL;

/** Where Claude Code looks for the user's skills (`$CLAUDE_CONFIG_DIR`, else ~/.claude). */
export function skillPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills", "agentree", "SKILL.md");
}

/** "installed" (current), "outdated" (an older agentree's), or "missing". */
export function skillState(): "installed" | "outdated" | "missing" {
  try {
    return readFileSync(skillPath(), "utf8") === SKILL_TEXT ? "installed" : "outdated";
  } catch {
    return "missing";
  }
}

export function installSkill(): string {
  const path = skillPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, SKILL_TEXT, "utf8");
  return path;
}

/** Remove the skill (only its own directory). Returns whether there was one. */
export function uninstallSkill(): boolean {
  const dir = dirname(skillPath());
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
