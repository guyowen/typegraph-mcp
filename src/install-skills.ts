/**
 * Skill installation.
 *
 * Skills are copied from this package into whichever directories the selected
 * agents read (see computeSkillTargets). Nothing else is copied — there is no
 * plugin directory, so a skill that needs to invoke this package must be told
 * how to reach the installed package.
 *
 * Project dependencies use a project-relative path to the public CLI, while the
 * warned external-checkout fallback stays absolute. The copied command invokes
 * `node` from PATH: unlike an installer-machine absolute path, that remains
 * valid in a committed skill on Windows, macOS, Linux, and other teammates'
 * machines. The CLI trampoline reports a clear version error below Node 22.18.
 */
import fs from "node:fs";
import path from "node:path";
import {
  AGENTS,
  agentsServedBy,
  computeSkillTargets,
  SKILLS_DIRS,
  SKILLS_DIR_PATHS,
  type AgentId,
  type SkillsDir,
} from "./agents.ts";
import { portableNodePath } from "./install-paths.ts";

export const SKILL_NAMES = [
  "tool-selection",
  "impact-analysis",
  "refactor-safety",
  "dependency-audit",
  "code-exploration",
  "deep-survey",
] as const;

export const ROOT_PLACEHOLDER = "__TYPEGRAPH_ROOT__";
export const NODE_PLACEHOLDER = "__TYPEGRAPH_NODE__";
export const CHECK_PLACEHOLDER = "__TYPEGRAPH_CHECK__";
export const CLI_PLACEHOLDER = "__TYPEGRAPH_CLI__";
export const TSCONFIG_PLACEHOLDER = "__TYPEGRAPH_TSCONFIG__";

/** Tokens that must never reach disk. Includes the two we replaced. */
export const LEGACY_PLACEHOLDERS = ["__TYPEGRAPH_PLUGIN_ROOT__", "${CLAUDE_PLUGIN_ROOT}"];

export interface SkillInstallResult {
  targets: SkillsDir[];
  written: number;
  unchanged: number;
  byTarget: Record<string, { dir: string; agents: string[]; written: number }>;
}

export interface SkillInstallOptions {
  /** Absolute path to this package — the source of skills/ and the value of __TYPEGRAPH_ROOT__. */
  sourceDir: string;
  projectRoot: string;
  /**
   * Absolute path the skills should invoke this package through. Defaults to
   * sourceDir; differs when the project depends on its own installed copy.
   */
  packageRoot?: string;
  /** Project-relative tsconfig path written into health-check commands. */
  tsconfig?: string;
  selectedAgents: readonly AgentId[];
  dryRun?: boolean;
}

function cliEntrypoint(packageRoot: string): string {
  const dist = path.join(packageRoot, "dist", "cli.cjs");
  return fs.existsSync(dist) ? dist : path.join(packageRoot, "src", "cli.cjs");
}

function portableCliEntrypoint(projectRoot: string, packageRoot: string): string {
  const absolute = cliEntrypoint(packageRoot);
  const relative = path.relative(projectRoot, absolute);
  const isInside = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (!isInside) return portableNodePath(absolute);
  const portable = portableNodePath(relative);
  return `./${portable}`;
}

function templateSkill(
  content: string,
  projectRoot: string,
  packageRoot: string,
  tsconfig: string,
): string {
  let out = content.replaceAll(ROOT_PLACEHOLDER, packageRoot);
  out = out.replaceAll(CLI_PLACEHOLDER, portableCliEntrypoint(projectRoot, packageRoot));
  out = out.replaceAll(TSCONFIG_PLACEHOLDER, tsconfig);
  for (const legacy of LEGACY_PLACEHOLDERS) out = out.replaceAll(legacy, packageRoot);
  return out.replaceAll(NODE_PLACEHOLDER, "node");
}

export function skillsDirFor(projectRoot: string, target: SkillsDir): string {
  return path.resolve(projectRoot, SKILLS_DIR_PATHS[target]);
}

export function installSkills(options: SkillInstallOptions): SkillInstallResult {
  const { sourceDir, projectRoot, selectedAgents, dryRun = false } = options;
  const packageRoot = options.packageRoot ?? sourceDir;
  const tsconfig = options.tsconfig ?? "./tsconfig.json";
  const targets = computeSkillTargets(selectedAgents);

  const result: SkillInstallResult = {
    targets,
    written: 0,
    unchanged: 0,
    byTarget: {},
  };

  for (const target of targets) {
    const destRoot = skillsDirFor(projectRoot, target);
    let written = 0;

    for (const skill of SKILL_NAMES) {
      const src = path.join(sourceDir, "skills", skill, "SKILL.md");
      if (!fs.existsSync(src)) continue;

      const content = templateSkill(
        fs.readFileSync(src, "utf-8"),
        projectRoot,
        packageRoot,
        tsconfig,
      );
      const dest = path.join(destRoot, skill, "SKILL.md");

      if (fs.existsSync(dest) && fs.readFileSync(dest, "utf-8") === content) {
        result.unchanged++;
        continue;
      }
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
      }
      written++;
      result.written++;
    }

    result.byTarget[target] = {
      dir: destRoot,
      agents: agentsServedBy(selectedAgents, target),
      written,
    };
  }

  return result;
}

/** Remove only our skills, never the containing directory. */
export function removeSkills(projectRoot: string): number {
  let removed = 0;
  for (const target of SKILLS_DIRS) {
    const destRoot = skillsDirFor(projectRoot, target);
    for (const skill of SKILL_NAMES) {
      const dir = path.join(destRoot, skill);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    }
    if (fs.existsSync(destRoot) && fs.readdirSync(destRoot).length === 0) {
      fs.rmdirSync(destRoot);
    }
  }
  return removed;
}

export { AGENTS };
