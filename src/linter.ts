import * as fs from 'fs';
import * as path from 'path';
import { parseFile } from './parse';
import { analyzeTokens } from './tokens';
import { lintSkill } from './rules/skill';
import { lintAgent } from './rules/agent';
import { scanScriptContent } from './rules/security';
import { checkBrokenRefs, detectRoutingConflicts, discoverWorkspaceFiles } from './rules/workspace';
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

function computeScore(categories: CategoryResult[]): number {
  const totalWeight = categories.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 0;
  const weighted = categories.reduce((s, c) => s + c.score * c.weight, 0);
  return (weighted / totalWeight) * 10; // 0-100
}

function detectType(filePath: string, frontmatter: Record<string, unknown> | null): FileType {
  const base = path.basename(filePath).toUpperCase();
  if (base === 'SKILL.MD') return 'skill';
  if (base === 'CLAUDE.MD' || base === 'AGENT.MD' || base === 'AGENTS.MD') return 'agent';
  if (filePath.includes(`${path.sep}skills${path.sep}`)) return 'skill';
  if (filePath.includes(`${path.sep}rules${path.sep}`) || filePath.includes(`${path.sep}instructions${path.sep}`)) return 'agent';
  // Frontmatter with name/description signals a skill
  if (frontmatter && 'name' in frontmatter && 'description' in frontmatter) return 'skill';
  return 'unknown';
}

function rescoreCategory(cat: CategoryResult): void {
  const deductions = cat.findings.reduce((sum, f) => {
    if (f.severity === 'error') return sum + 3;
    if (f.severity === 'warn') return sum + 1.5;
    return sum + 0.5;
  }, 0);
  cat.score = Math.max(0, 10 - deductions);
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

// Skills ship companion scripts that execute with the user's permissions —
// scan them with the same security patterns and fold findings into Security.
function attachCompanionFindings(result: LintResult, skillDir: string, config: Config): void {
  const suppress = new Set(config.suppress ?? []);
  const overrides = config.severity ?? {};
  const security = result.categories.find(c => c.id === 'security');
  if (!security) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillDir, { withFileTypes: true });
  } catch {
    return;
  }

  const scan = (filePath: string, relName: string) => {
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { return; }
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    for (const f of scanScriptContent(relName, content)) {
      if (suppress.has(f.ruleId)) continue;
      if (overrides[f.ruleId]) f.severity = overrides[f.ruleId];
      security.findings.push(f);
    }
  };

  for (const e of entries) {
    const full = path.join(skillDir, e.name);
    if (e.isFile() && SCRIPT_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      scan(full, e.name);
    } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      // one level deep covers the conventional scripts/ subdirectory
      let sub: fs.Dirent[] = [];
      try { sub = fs.readdirSync(full, { withFileTypes: true }); } catch { /* skip */ }
      for (const s of sub) {
        if (s.isFile() && SCRIPT_EXTENSIONS.has(path.extname(s.name).toLowerCase())) {
          scan(path.join(full, s.name), path.join(e.name, s.name));
        }
      }
    }
  }

  rescoreCategory(security);
  const totalWeight = result.categories.reduce((s, c) => s + c.weight, 0);
  result.score = (result.categories.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight) * 10;
  result.grade = toGrade(result.score);
}

export function lintFile(filePath: string, config: Config = {}, forcedType?: FileType): LintResult {
  const parsed = parseFile(filePath);
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

  const score = computeScore(categories);

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

// Lint a SKILL.md and scan its sibling companion scripts
export function lintSkillWithCompanions(skillPath: string, config: Config = {}): LintResult[] {
  const result = lintFile(skillPath, config, 'skill');
  attachCompanionFindings(result, path.dirname(skillPath), config);
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

  const results = discovered.map(d => {
    const result = lintFile(d.path, config, d.type);
    if (d.type === 'skill') attachCompanionFindings(result, path.dirname(d.path), config);
    return result;
  });
  const parsedFiles = discovered.map(d => parseFile(d.path));

  const totalTokens = results.reduce((s, r) => s + r.tokens.total, 0);
  const agentTokens = results
    .filter(r => r.type === 'agent')
    .reduce((s, r) => s + r.tokens.total, 0);

  const brokenRefs = checkBrokenRefs(parsedFiles);
  const skillParsed = parsedFiles.filter((_, i) => discovered[i].type === 'skill');
  const routingConflicts = detectRoutingConflicts(skillParsed);

  const allFindings = results.flatMap(r => r.categories.flatMap(c => c.findings));
  const totalErrors = allFindings.filter(f => f.severity === 'error').length;
  const totalWarnings = allFindings.filter(f => f.severity === 'warn').length;
  const criticalSecurityIssues = allFindings.filter(
    f => f.ruleId.startsWith('security/') && f.severity === 'error'
  ).length;

  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  const brokenRefPenalty = Math.min(brokenRefs.length * 5, 20);
  const routingPenalty = Math.min(routingConflicts.length * 5, 15);
  const workspaceScore = Math.max(0, avgScore - brokenRefPenalty - routingPenalty);

  return {
    root,
    files: results,
    totalTokens,
    agentTokens,
    tokenBudgetWarning: agentTokens > 8000,
    brokenRefs,
    routingConflicts,
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
