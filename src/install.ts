import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Shipped with the package: <root>/skills/vibe-check next to dist/
const SKILL_SOURCE = path.join(__dirname, '..', 'skills', 'vibe-check');

// Where each harness discovers skills. "agents" is the cross-client location
// that Copilot, Cursor, OpenCode, Codex, Gemini, and Windsurf all read.
export const SKILL_TARGETS: Record<string, { project: string; user: string }> = {
  claude:   { project: '.claude/skills',   user: '.claude/skills' },
  opencode: { project: '.opencode/skills', user: '.config/opencode/skills' },
  copilot:  { project: '.github/skills',   user: '.copilot/skills' },
  agents:   { project: '.agents/skills',   user: '.agents/skills' },
};

export interface InstallSkillOptions {
  target?: string;   // claude (default) | opencode | copilot | agents
  project?: boolean; // install into the current project instead of the user-level dir
  force?: boolean;   // overwrite an existing installation
  cwd?: string;
}

export function installSkill(opts: InstallSkillOptions = {}): { dest: string; files: string[] } {
  if (!fs.existsSync(path.join(SKILL_SOURCE, 'SKILL.md'))) {
    throw new Error(`Bundled skill not found at ${SKILL_SOURCE} — broken installation?`);
  }

  const target = SKILL_TARGETS[opts.target ?? 'claude'];
  if (!target) {
    throw new Error(`Unknown target "${opts.target}" — expected one of: ${Object.keys(SKILL_TARGETS).join(', ')}`);
  }

  const skillsDir = opts.project
    ? path.join(opts.cwd ?? process.cwd(), ...target.project.split('/'))
    : path.join(os.homedir(), ...target.user.split('/'));
  const dest = path.join(skillsDir, 'vibe-check');

  if (fs.existsSync(dest) && !opts.force) {
    throw new Error(`${dest} already exists — pass --force to overwrite`);
  }

  fs.mkdirSync(skillsDir, { recursive: true });
  fs.cpSync(SKILL_SOURCE, dest, { recursive: true, force: true });

  const files = fs.readdirSync(dest).sort();
  return { dest, files };
}
