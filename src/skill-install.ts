import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import unshitSkill from "./resources/unshit-skill/SKILL.md" with { type: "text" };

export const SKILL_NAME = "unshit";
export const SKILL_MARKER = "<!-- installed by unshit; update with: unshit --install-skill -->";
export const UNSHIT_SKILL: string = unshitSkill;

export type SkillAgent = "claude" | "codex" | "custom";

export interface SkillTarget {
  agent: SkillAgent;
  /** The folder that holds one sub-folder per skill. */
  skillsRoot: string;
}

export type SkillInstallStatus = "installed" | "updated" | "unchanged" | "skipped" | "failed";

export interface SkillInstallResult {
  agent: SkillAgent;
  path: string;
  status: SkillInstallStatus;
  reason?: string;
}

/**
 * Skill folders of the agents found in `home`:
 * Claude Code: `skills` in `$CLAUDE_CONFIG_DIR` (default `~/.claude`), when that folder exists.
 * Codex: `skills` in `$CODEX_HOME` (default `~/.codex`), when that folder exists; and `~/.agents/skills`,
 * when the Codex folder or `~/.agents` exists.
 */
export async function defaultSkillTargets(home: string, env: Record<string, string | undefined>): Promise<SkillTarget[]> {
  const targets: SkillTarget[] = [];
  const claudeHome = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, ".claude");
  if (await isDirectory(claudeHome)) targets.push({ agent: "claude", skillsRoot: path.join(claudeHome, "skills") });
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex");
  const agentsHome = path.join(home, ".agents");
  const codexFound = await isDirectory(codexHome);
  if (codexFound) targets.push({ agent: "codex", skillsRoot: path.join(codexHome, "skills") });
  if (codexFound || await isDirectory(agentsHome)) targets.push({ agent: "codex", skillsRoot: path.join(agentsHome, "skills") });
  return targets;
}

/**
 * Writes the embedded skill to `<skillsRoot>/unshit/SKILL.md` for each target.
 * A SKILL.md that unshit did not write is replaced only with `force`.
 * An `unshit` folder or a SKILL.md that is a symbolic link is not followed; a symbolic link in `skillsRoot` or above
 * it is followed.
 */
export async function installSkill(targets: SkillTarget[], options: { force?: boolean } = {}): Promise<SkillInstallResult[]> {
  const results: SkillInstallResult[] = [];
  for (const target of targets) results.push(await installOne(target, options.force === true));
  return results;
}

async function installOne(target: SkillTarget, force: boolean): Promise<SkillInstallResult> {
  const directory = path.join(target.skillsRoot, SKILL_NAME);
  const file = path.join(directory, "SKILL.md");
  const result = (status: SkillInstallStatus, reason?: string): SkillInstallResult => ({
    agent: target.agent,
    path: file,
    status,
    ...(reason ? { reason } : {}),
  });
  try {
    const folder = await lstatIfPresent(directory);
    if (folder?.isSymbolicLink()) return result("skipped", `${directory} is a symbolic link and was not followed`);
    if (folder && !folder.isDirectory()) return result("failed", `${directory} exists and is not a folder`);

    let status: SkillInstallStatus = "installed";
    const existing = await lstatIfPresent(file);
    if (existing) {
      if (!existing.isFile()) return result("failed", `${file} is not a regular file`);
      const current = await readFile(file, "utf8");
      if (current === UNSHIT_SKILL) return result("unchanged");
      if (!current.includes(SKILL_MARKER) && !force) {
        return result("failed", `${file} was not installed by unshit; pass --force to replace it`);
      }
      status = "updated";
    }

    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.SKILL.md.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, UNSHIT_SKILL, { flag: "wx", mode: 0o644 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return result(status);
  } catch (error) {
    return result("failed", describeFileError(error));
  }
}

async function lstatIfPresent(target: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function describeFileError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return `file system error ${error.code}`;
  }
  return "file system error";
}
