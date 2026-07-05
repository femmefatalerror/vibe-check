import * as fs from 'fs';
import * as path from 'path';
import type { BrokenRef, ParsedFile, RoutingConflict } from '../types';

export interface DiscoveredFile {
  path: string;
  type: 'skill' | 'agent';
}

// Repo-metadata files that are never skills, even inside a skills/ directory
export const DOC_FILENAMES = new Set([
  'README.MD', 'CHANGELOG.MD', 'CONTRIBUTING.MD', 'LICENSE.MD',
  'CODE_OF_CONDUCT.MD', 'SECURITY.MD',
]);

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

  function walk(dir: string) {
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
    const hasSiblingSkill = entries.some(e => e.isFile() && e.name.toUpperCase() === 'SKILL.MD');

    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      // allow .claude directory even though it starts with '.'
      if (e.name.startsWith('.') && e.name !== '.claude') continue;

      const fullPath = path.join(dir, e.name);

      if (e.isDirectory()) {
        walk(fullPath);
      } else if (e.name.endsWith('.md')) {
        const upper = e.name.toUpperCase();

        if (upper === 'SKILL.MD') {
          add(fullPath, 'skill');
        } else if (upper === 'CLAUDE.MD' || upper === 'AGENT.MD' || upper === 'AGENTS.MD') {
          add(fullPath, 'agent');
        } else if (inSkillsDir) {
          // Loose .md in a skills tree is a flat-layout skill — but not repo
          // docs, and not companion references living next to a SKILL.md
          if (!DOC_FILENAMES.has(upper) && !hasSiblingSkill) add(fullPath, 'skill');
        } else if (inRulesDir) {
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
