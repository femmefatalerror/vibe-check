import * as fs from 'fs';
import * as path from 'path';
import type { BrokenRef, ParsedFile, RoutingConflict, SkillInvocation, UnresolvedInvocation } from '../types';

export interface DiscoveredFile {
  path: string;
  type: 'skill' | 'agent';
}

// Repo-metadata files that are never skills, even inside a skills/ directory
export const DOC_FILENAMES = new Set([
  'README.MD', 'CHANGELOG.MD', 'CONTRIBUTING.MD', 'LICENSE.MD',
  'CODE_OF_CONDUCT.MD', 'SECURITY.MD',
]);

// Dot-directories that hold agent/skill sources: .claude (Claude Code),
// .apm (APM package source), .agents/.kiro (cross-client skill dirs),
// .opencode (OpenCode), .github (Copilot instructions/agents/skills)
const SOURCE_DOT_DIRS = new Set(['.claude', '.apm', '.agents', '.kiro', '.opencode', '.github']);

// `apm install` copies .apm sources into these harness dirs. When the .apm
// source tree is present, lint the source and skip the deployed copies.
function isApmDeployedCopy(parent: string, name: string): boolean {
  const base = path.basename(parent);
  const root = path.dirname(parent);
  if (name === 'skills' && (base === '.claude' || base === '.agents' || base === '.kiro')) {
    return fs.existsSync(path.join(root, '.apm', 'skills'));
  }
  if (name === 'agents' && base === '.github') {
    return fs.existsSync(path.join(root, '.apm', 'agents'));
  }
  return false;
}

export function discoverWorkspaceFiles(root: string): DiscoveredFile[] {
  const discovered: DiscoveredFile[] = [];
  const seen = new Set<string>();
  const absRoot = path.resolve(root);

  function add(filePath: string, type: 'skill' | 'agent') {
    const abs = path.resolve(filePath);
    if (!seen.has(abs) && fs.existsSync(abs)) {
      seen.add(abs);
      discovered.push({ path: abs, type });
    }
  }

  // underSkillDir: some ancestor directory contains a SKILL.md, so loose .md
  // files here are companions (references/, examples/, …), not flat-layout skills
  function walk(dir: string, underSkillDir = false) {
    if (!fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Directory names are matched relative to the workspace root, so a repo
    // checked out at e.g. ~/dev/skills doesn't turn every .md into a skill
    const rel = path.relative(absRoot, dir);
    const segments = rel === '' ? [] : rel.split(path.sep);
    const inSkillsDir = segments.includes('skills');
    const inRulesDir = segments.includes('rules') || segments.includes('instructions');
    // agent-definition dirs (.claude/agents, .opencode/agent, .github/agents) —
    // only inside a harness dot-dir, so a repo's own agents/ docs dir stays out
    const inAgentDir = (segments.includes('agent') || segments.includes('agents'))
      && segments.some(s => SOURCE_DOT_DIRS.has(s));
    const inSkillTree = underSkillDir ||
      entries.some(e => e.isFile() && e.name.toUpperCase() === 'SKILL.MD');

    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'apm_modules') continue;
      if (e.name.startsWith('.') && !SOURCE_DOT_DIRS.has(e.name)) continue;

      const fullPath = path.join(dir, e.name);

      if (e.isDirectory()) {
        if (isApmDeployedCopy(dir, e.name)) continue;
        walk(fullPath, inSkillTree);
      } else if (e.name.endsWith('.md')) {
        const upper = e.name.toUpperCase();

        if (upper === 'SKILL.MD') {
          add(fullPath, 'skill');
        } else if (
          upper === 'CLAUDE.MD' || upper === 'AGENT.MD' || upper === 'AGENTS.MD' ||
          upper === 'COPILOT-INSTRUCTIONS.MD' ||
          upper.endsWith('.AGENT.MD') || upper.endsWith('.INSTRUCTIONS.MD')
        ) {
          add(fullPath, 'agent');
        } else if (inSkillsDir) {
          // Loose .md in a skills tree is a flat-layout skill — but not repo
          // docs, and not companion references living next to or below a SKILL.md
          if (!DOC_FILENAMES.has(upper) && !inSkillTree) add(fullPath, 'skill');
        } else if ((inRulesDir || inAgentDir) && !DOC_FILENAMES.has(upper)) {
          add(fullPath, 'agent');
        }
      }
    }
  }

  walk(absRoot);

  // Always include CLAUDE.md at root even if walk missed it
  for (const candidate of [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')]) {
    add(candidate, 'agent');
  }

  return discovered;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'when', 'user', 'this', 'that', 'from', 'use',
  'uses', 'used', 'using', 'files', 'file', 'data', 'skill', 'mentions', 'asks',
  'working', 'needs', 'wants', 'them', 'into', 'about', 'also',
]);

function descriptionWords(desc: string): Set<string> {
  return new Set(
    desc.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !STOPWORDS.has(w))
  );
}

// Two skills with near-identical descriptions compete for the same triggers —
// Claude's routing between them becomes arbitrary.
export function detectRoutingConflicts(skillFiles: ParsedFile[]): RoutingConflict[] {
  const conflicts: RoutingConflict[] = [];
  const skills = skillFiles
    .filter(f => f.frontmatter && typeof f.frontmatter['description'] === 'string')
    .map(f => ({
      path: f.path,
      name: String(f.frontmatter!['name'] ?? ''),
      words: descriptionWords(String(f.frontmatter!['description'])),
    }));

  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i], b = skills[j];

      if (a.name && a.name === b.name) {
        conflicts.push({ skillA: a.path, skillB: b.path, reason: `duplicate skill name "${a.name}"` });
        continue;
      }

      if (a.words.size < 4 || b.words.size < 4) continue;
      const intersection = [...a.words].filter(w => b.words.has(w)).length;
      const union = new Set([...a.words, ...b.words]).size;
      const jaccard = intersection / union;
      if (jaccard >= 0.5) {
        conflicts.push({
          skillA: a.path,
          skillB: b.path,
          reason: `descriptions are ${Math.round(jaccard * 100)}% similar — Claude cannot reliably choose between them`,
        });
      }
    }
  }

  return conflicts;
}

// A skill can invoke another skill by its slash-command name, e.g. `/grilling`.
// These are cross-skill dependencies (resolved by skill name), not file links.
// Root/system paths that share the /word shape but are never skill invocations.
const SYSTEM_PATHS = new Set([
  'tmp', 'usr', 'etc', 'bin', 'dev', 'var', 'opt', 'root', 'home', 'sys',
  'proc', 'mnt', 'lib', 'sbin', 'srv', 'boot', 'run', 'media', 'users',
  'private', 'net', 'cores',
]);

// Claude Code built-in slash commands — legitimately invoked from skill docs
// but not skills, so they must not be reported as skill dependencies.
const BUILTIN_COMMANDS = new Set([
  'compact', 'clear', 'help', 'review', 'init', 'config', 'cost', 'doctor',
  'login', 'logout', 'model', 'resume', 'status', 'vim', 'memory', 'agents',
  'bug', 'mcp', 'permissions', 'add-dir', 'pr-comments', 'release-notes',
  'terminal-setup', 'context', 'rewind', 'usage', 'hooks', 'output-style',
  'ide', 'fast', 'exit', 'quit', 'feedback',
]);

// A slash-command token: `/name` where name is skill-name-shaped (no leading or
// trailing hyphen, 2–64 chars), preceded by a boundary (start, whitespace,
// backtick, or paren) and not continued by a path separator, dot, hyphen, or
// word char — so `scripts/x`, `/tmp/y`, `/a.json`, `<t>/foo-<x>`, and `http://`
// don't match.
const INVOCATION_RE = /(?:^|[\s`(])\/([a-z][a-z0-9-]{0,62}[a-z0-9])(?![/.\w-])/g;

// Extract the distinct skills a SKILL.md invokes by slash-command name. Skips
// fenced code blocks (shell examples there tend to be paths, not invocations)
// and known system paths.
export function extractSkillInvocations(parsed: ParsedFile): SkillInvocation[] {
  const out: SkillInvocation[] = [];
  const seen = new Set<string>();
  let inFence = false;

  parsed.bodyLines.forEach((line, i) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    INVOCATION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INVOCATION_RE.exec(line)) !== null) {
      const name = m[1];
      if (SYSTEM_PATHS.has(name) || BUILTIN_COMMANDS.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, line: parsed.bodyLineOffset + i + 1 });
    }
  });

  return out;
}

// Cross-skill invocations that don't resolve to any skill name in the workspace
// — either a dangling reference (renamed/removed skill) or a non-skill token.
export function checkUnresolvedInvocations(skillFiles: ParsedFile[]): UnresolvedInvocation[] {
  const known = new Set(
    skillFiles
      .map(f => String(f.frontmatter?.['name'] ?? '').trim().toLowerCase())
      .filter(Boolean)
  );

  const unresolved: UnresolvedInvocation[] = [];
  for (const file of skillFiles) {
    for (const inv of extractSkillInvocations(file)) {
      if (!known.has(inv.name.toLowerCase())) {
        unresolved.push({ source: file.path, name: inv.name, line: inv.line });
      }
    }
  }
  return unresolved;
}

export function checkBrokenRefs(files: ParsedFile[]): BrokenRef[] {
  const broken: BrokenRef[] = [];

  for (const file of files) {
    for (const link of file.links) {
      if (link.href.startsWith('http') || link.href.startsWith('#') || link.href.startsWith('mailto:')) continue;

      const cleanHref = link.href.split('#')[0];
      if (!cleanHref) continue;

      const resolved = path.resolve(path.dirname(file.path), cleanHref);
      if (!fs.existsSync(resolved)) {
        broken.push({ source: file.path, ref: link.href, line: link.line });
      }
    }
  }

  return broken;
}
