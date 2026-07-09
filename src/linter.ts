import * as fs from 'fs';
import * as path from 'path';
import { parseFile, parseContent } from './parse';
import { analyzeTokens } from './tokens';
import { lintSkill } from './rules/skill';
import { lintAgent } from './rules/agent';
import { scanScriptContent, scanSecurity } from './rules/security';
import { checkBrokenRefs, checkUnresolvedInvocations, detectRoutingConflicts, discoverWorkspaceFiles, DOC_FILENAMES } from './rules/workspace';
import { scoreCategory, computeWeightedScore } from './score';
import type { Config, LintResult, WorkspaceDiagnosis, FileType, Grade, CategoryResult, Finding, ParsedFile } from './types';

export function toGrade(score: number): Grade {
  if (score >= 97) return 'A+';
  if (score >= 93) return 'A';
  if (score >= 90) return 'A-';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B-';
  if (score >= 77) return 'C+';
  if (score >= 73) return 'C';
  if (score >= 70) return 'C-';
  if (score >= 67) return 'D+';
  if (score >= 63) return 'D';
  if (score >= 60) return 'D-';
  return 'F';
}

function detectType(filePath: string, frontmatter: Record<string, unknown> | null): FileType {
  const base = path.basename(filePath).toUpperCase();
  if (base === 'SKILL.MD') return 'skill';
  if (
    base === 'CLAUDE.MD' || base === 'AGENT.MD' || base === 'AGENTS.MD' ||
    base === 'COPILOT-INSTRUCTIONS.MD' ||
    base.endsWith('.AGENT.MD') || base.endsWith('.INSTRUCTIONS.MD')
  ) return 'agent';
  if (filePath.includes(`${path.sep}skills${path.sep}`)) return 'skill';
  if (filePath.includes(`${path.sep}rules${path.sep}`) || filePath.includes(`${path.sep}instructions${path.sep}`)) return 'agent';
  // Frontmatter with name/description signals a skill
  if (frontmatter && 'name' in frontmatter && 'description' in frontmatter) return 'skill';
  return 'unknown';
}

function rescoreCategory(cat: CategoryResult): void {
  cat.score = scoreCategory(cat.findings);
}

function applySeverityOverrides(categories: CategoryResult[], overrides: Record<string, string>): void {
  for (const cat of categories) {
    for (const f of cat.findings) {
      if (overrides[f.ruleId]) {
        f.severity = overrides[f.ruleId] as Finding['severity'];
      }
    }
    rescoreCategory(cat);
  }
}

// <!-- lint-disable --> / <!-- lint-disable-next-line --> comments in the file
function applyInlineDisables(categories: CategoryResult[], parsed: ParsedFile): number {
  if (parsed.disables.length === 0) return 0;

  const fileWide = new Set(parsed.disables.filter(d => d.line === undefined).map(d => d.ruleId));
  const byLine = parsed.disables.filter(d => d.line !== undefined);
  let removed = 0;

  for (const cat of categories) {
    const before = cat.findings.length;
    cat.findings = cat.findings.filter(f =>
      !fileWide.has(f.ruleId) &&
      !byLine.some(d => d.ruleId === f.ruleId && d.line === f.line)
    );
    if (cat.findings.length !== before) {
      removed += before - cat.findings.length;
      rescoreCategory(cat);
    }
  }

  return removed;
}

const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.ts', '.rb', '.pl']);
const MAX_SCRIPT_BYTES = 512 * 1024;

// Skills ship companion files alongside SKILL.md. Scripts execute with the
// user's permissions and markdown referenced from SKILL.md is read into
// Claude's context — both get security-scanned, with findings folded into
// the skill's Security category. Unreferenced companions are flagged instead.
function attachCompanionFindings(result: LintResult, skillDir: string, config: Config, skillRaw?: string): void {
  const suppress = new Set(config.suppress ?? []);
  const overrides = config.severity ?? {};
  const security = result.categories.find(c => c.id === 'security');
  if (!security) return;

  const push = (f: Finding) => {
    if (suppress.has(f.ruleId)) return;
    if (overrides[f.ruleId]) f.severity = overrides[f.ruleId];
    security.findings.push(f);
  };

  const readCapped = (filePath: string): string | null => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return null;
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  };

  // Collect companions one level deep (covers conventional scripts/ and references/)
  const companions: { full: string; relName: string; isMd: boolean }[] = [];
  const collect = (dir: string, prefix: string, recurse: boolean) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const isMd = e.name.toLowerCase().endsWith('.md');
      if (e.isFile() && (isMd || SCRIPT_EXTENSIONS.has(path.extname(e.name).toLowerCase()))) {
        if (e.name.toUpperCase() === 'SKILL.MD') continue;
        companions.push({ full, relName: path.join(prefix, e.name), isMd });
      } else if (recurse && e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        collect(full, path.join(prefix, e.name), false);
      }
    }
  };
  collect(skillDir, '', true);
  if (companions.length === 0) return;

  // Walk the reference graph from SKILL.md: a companion is referenced when its
  // filename appears in SKILL.md or in any already-referenced companion .md
  const texts: string[] = [(skillRaw ?? readCapped(path.join(skillDir, 'SKILL.md')) ?? '').toLowerCase()];
  const referenced = new Set<string>();
  const mdContent = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of companions) {
      if (referenced.has(c.relName)) continue;
      const base = path.basename(c.relName).toLowerCase();
      if (texts.some(t => t.includes(base))) {
        referenced.add(c.relName);
        changed = true;
        if (c.isMd) {
          const content = readCapped(c.full);
          if (content !== null) {
            mdContent.set(c.relName, content);
            texts.push(content.toLowerCase());
          }
        }
      }
    }
  }

  for (const c of companions) {
    if (c.isMd) {
      // Referenced markdown enters Claude's context when the skill runs —
      // scan it for injection with the same rules as SKILL.md itself
      const content = mdContent.get(c.relName);
      if (content !== undefined) {
        for (const f of scanSecurity(parseContent(c.relName, content), 'skill')) {
          push({ ...f, file: c.relName });
        }
      }
    } else {
      // Scripts are scanned regardless of reference — they execute directly
      const content = readCapped(c.full);
      if (content !== null) {
        for (const f of scanScriptContent(c.relName, content)) push(f);
      }
    }

    if (!referenced.has(c.relName) && !DOC_FILENAMES.has(path.basename(c.relName).toUpperCase())) {
      push({
        ruleId: 'security/companion/unreferenced-file',
        severity: 'warn',
        message: `Companion file is never referenced from SKILL.md — dead weight, or a place to hide content`,
        file: c.relName,
        suggestion: 'Reference it from SKILL.md or remove it; unreferenced markdown is not security-scanned',
      });
    }
  }

  rescoreCategory(security);
  result.score = computeWeightedScore(result.categories);
  result.grade = toGrade(result.score);
}

export function lintFile(filePath: string, config: Config = {}, forcedType?: FileType): LintResult {
  return lintParsed(parseFile(filePath), config, forcedType);
}

// Lint an already-parsed file — lets callers that need the ParsedFile for other
// checks (e.g. diagnoseWorkspace) avoid reading and parsing twice.
export function lintParsed(parsed: ParsedFile, config: Config = {}, forcedType?: FileType): LintResult {
  const filePath = parsed.path;
  const suppress = new Set(config.suppress ?? []);
  const overrides = config.severity ?? {};

  const type: FileType = forcedType ?? detectType(filePath, parsed.frontmatter);
  const effectiveType = type === 'unknown' ? 'agent' : type;

  const categories =
    effectiveType === 'skill'
      ? lintSkill(parsed, suppress)
      : lintAgent(parsed, suppress);

  applyInlineDisables(categories, parsed);

  if (Object.keys(overrides).length > 0) {
    applySeverityOverrides(categories, overrides);
  }

  const score = computeWeightedScore(categories);

  return {
    file: filePath,
    type: effectiveType,
    categories,
    score,
    grade: toGrade(score),
    tokens: analyzeTokens(parsed.raw),
    suppressed: suppress.size,
  };
}

// Lint a SKILL.md and scan its companion scripts and referenced markdown
export function lintSkillWithCompanions(skillPath: string, config: Config = {}): LintResult[] {
  const parsed = parseFile(skillPath);
  const result = lintParsed(parsed, config, 'skill');
  attachCompanionFindings(result, path.dirname(skillPath), config, parsed.raw);
  return [result];
}

export function lintDir(dirPath: string, config: Config = {}): LintResult[] {
  const skillPath = path.join(dirPath, 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    return lintSkillWithCompanions(skillPath, config);
  }

  const agentCandidates = ['CLAUDE.md', 'AGENT.md', 'AGENTS.md', 'agent.md', 'agents.md'].map(f => path.join(dirPath, f));
  const found = agentCandidates.filter(f => fs.existsSync(f));
  if (found.length > 0) {
    return found.map(f => lintFile(f, config, 'agent'));
  }

  throw new Error(`No SKILL.md or agent file (CLAUDE.md, AGENT.md, AGENTS.md) found in ${dirPath}`);
}

export function diagnoseWorkspace(root: string, config: Config = {}): WorkspaceDiagnosis {
  const discovered = discoverWorkspaceFiles(root);

  if (discovered.length === 0) {
    throw new Error(`No skills or agent files (SKILL.md, CLAUDE.md, AGENT.md, AGENTS.md) found in ${root}`);
  }

  const parsedFiles = discovered.map(d => parseFile(d.path));
  const results = discovered.map((d, i) => {
    const result = lintParsed(parsedFiles[i], config, d.type);
    // Companions only make sense for a dedicated skill directory — flat-layout
    // skills (skills/foo.md) share their directory with sibling skills
    if (d.type === 'skill' && path.basename(d.path).toUpperCase() === 'SKILL.MD') {
      attachCompanionFindings(result, path.dirname(d.path), config, parsedFiles[i].raw);
    }
    return result;
  });

  const totalTokens = results.reduce((s, r) => s + r.tokens.total, 0);
  const agentTokens = results
    .filter(r => r.type === 'agent')
    .reduce((s, r) => s + r.tokens.total, 0);

  const brokenRefs = checkBrokenRefs(parsedFiles);
  const skillParsed = parsedFiles.filter((_, i) => discovered[i].type === 'skill');
  const routingConflicts = detectRoutingConflicts(skillParsed);
  const unresolvedInvocations = checkUnresolvedInvocations(skillParsed);

  const allFindings = results.flatMap(r => r.categories.flatMap(c => c.findings));
  const totalErrors = allFindings.filter(f => f.severity === 'error').length;
  const totalWarnings = allFindings.filter(f => f.severity === 'warn').length;
  const criticalSecurityIssues = allFindings.filter(
    f => f.ruleId.startsWith('security/') && f.severity === 'error'
  ).length;

  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  const brokenRefPenalty = Math.min(brokenRefs.length * 5, 20);
  const routingPenalty = Math.min(routingConflicts.length * 5, 15);
  const invocationPenalty = Math.min(unresolvedInvocations.length * 3, 12);
  const workspaceScore = Math.max(0, avgScore - brokenRefPenalty - routingPenalty - invocationPenalty);

  return {
    root,
    files: results,
    totalTokens,
    agentTokens,
    tokenBudgetWarning: agentTokens > 8000,
    brokenRefs,
    routingConflicts,
    unresolvedInvocations,
    workspaceScore,
    workspaceGrade: toGrade(workspaceScore),
    totalErrors,
    totalWarnings,
    criticalSecurityIssues,
  };
}

export function loadConfig(configPath?: string): Config {
  const candidates = [
    configPath,
    '.vibe-check.json',
    '.skill-linter.json',
    '.agentlinter.json',
    path.join('.claude', 'linter.json'),
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as Config;
      } catch {
        process.stderr.write(`Warning: could not parse config file ${p}\n`);
      }
    }
  }

  return {};
}
