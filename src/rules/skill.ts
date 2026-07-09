import type { Finding, ParsedFile, CategoryResult } from '../types';
import { scanSecurity } from './security';
import { extractSkillInvocations } from './workspace';
import { scoreCategory } from '../score';
import { analyzeTokens, findDuplicateLines } from '../tokens';

const VAGUE_NAMES = new Set(['helper', 'utils', 'tools', 'misc', 'common', 'shared', 'data', 'files', 'docs', 'general', 'stuff']);
const RESERVED_WORDS = ['anthropic', 'claude'];
const NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

// ── Category 1: Identity & Metadata (20%) ────────────────────────────────────

function metadataRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];

  if (!parsed.frontmatter && !parsed.frontmatterError) {
    findings.push({
      ruleId: 'skill/meta/no-frontmatter',
      severity: 'error',
      message: 'Missing YAML frontmatter — SKILL.md must start with --- delimited frontmatter',
      line: 1,
      suggestion: '---\nname: your-skill-name\ndescription: What it does. Use when <trigger>.\n---',
    });
    return findings;
  }

  if (parsed.frontmatterError) {
    findings.push({
      ruleId: 'skill/meta/invalid-yaml',
      severity: 'error',
      message: `Frontmatter YAML parse error: ${parsed.frontmatterError}`,
      line: 1,
    });
    return findings;
  }

  const fm = parsed.frontmatter as Record<string, unknown>;

  // ── name ─────────────────────────────────────────────────────────────────
  if (!('name' in fm) || fm['name'] === null || fm['name'] === undefined) {
    findings.push({
      ruleId: 'skill/meta/missing-name',
      severity: 'error',
      message: 'Missing required frontmatter field: name',
      line: 2,
      suggestion: 'Add: name: your-skill-name (lowercase letters, numbers, hyphens; max 64 chars)',
    });
  } else {
    const name = String(fm['name']);

    if (!NAME_RE.test(name)) {
      findings.push({
        ruleId: 'skill/meta/name-format',
        severity: 'error',
        message: `name "${name}" must contain only lowercase letters, numbers, and hyphens`,
        line: 2,
        suggestion: `Try: ${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      });
    }

    if (name.length > 64) {
      findings.push({
        ruleId: 'skill/meta/name-too-long',
        severity: 'error',
        message: `name is ${name.length} characters; maximum is 64`,
        line: 2,
      });
    }

    if (/<[^>]+>/.test(name)) {
      findings.push({
        ruleId: 'skill/meta/name-xml-tags',
        severity: 'error',
        message: 'name contains XML tags, which are not allowed',
        line: 2,
      });
    }

    for (const word of RESERVED_WORDS) {
      if (name.includes(word)) {
        findings.push({
          ruleId: 'skill/meta/name-reserved-word',
          severity: 'error',
          message: `name contains reserved word "${word}"`,
          line: 2,
          suggestion: `Remove "${word}" from the skill name`,
        });
      }
    }

    if (VAGUE_NAMES.has(name)) {
      findings.push({
        ruleId: 'skill/meta/name-vague',
        severity: 'warn',
        message: `name "${name}" is too generic — Claude cannot determine when to use this skill`,
        suggestion: 'Use a descriptive gerund like "processing-pdfs" or "analyzing-spreadsheets"',
      });
    }
  }

  // ── description ──────────────────────────────────────────────────────────
  if (!('description' in fm) || fm['description'] === null || fm['description'] === undefined || String(fm['description']).trim() === '') {
    findings.push({
      ruleId: 'skill/meta/missing-description',
      severity: 'error',
      message: 'Missing required frontmatter field: description',
      line: 3,
      suggestion: 'Add: description: Processes X files. Use when the user mentions X or asks about Y.',
    });
  } else {
    const desc = String(fm['description']);

    if (desc.length > 1024) {
      findings.push({
        ruleId: 'skill/meta/description-too-long',
        severity: 'error',
        message: `description is ${desc.length} characters; maximum is 1024`,
        line: 3,
        suggestion: 'Trim to the essential what + trigger condition',
      });
    }

    if (/<[^>]+>/.test(desc)) {
      findings.push({
        ruleId: 'skill/meta/description-xml-tags',
        severity: 'error',
        message: 'description contains XML tags, which are not allowed',
        line: 3,
      });
    }
  }

  return findings;
}

// ── Category 2: Routing & Discovery (15%) ────────────────────────────────────

function routingRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];
  if (!parsed.frontmatter) return findings;

  // User-invoked only: Claude never routes to this skill by its description,
  // so trigger and discovery checks don't apply
  const dmi = parsed.frontmatter['disable-model-invocation'];
  if (dmi === true || String(dmi).toLowerCase() === 'true') return findings;

  const desc = String(parsed.frontmatter['description'] ?? '').trim();
  if (!desc) return findings; // already flagged

  const descLower = desc.toLowerCase();

  if (/\b(i can|i will|i'll|i am|i'm)\b/i.test(desc)) {
    findings.push({
      ruleId: 'skill/routing/first-person',
      severity: 'warn',
      message: 'Description uses first-person voice — must be third-person (injected into system prompt)',
      suggestion: 'Change "I can process PDFs" → "Processes PDF files"',
    });
  }

  if (/\b(you can|you should|you will)\b/i.test(desc)) {
    findings.push({
      ruleId: 'skill/routing/second-person',
      severity: 'warn',
      message: 'Description uses second-person voice — use third-person',
      suggestion: 'Change "You can use this to..." → "Processes... Use when..."',
    });
  }

  const hasTrigger =
    descLower.includes('use when') ||
    descLower.includes('when the user') ||
    descLower.includes('when working with') ||
    descLower.includes('when asked') ||
    descLower.includes('triggered when') ||
    descLower.includes('when a user') ||
    descLower.includes('when someone') ||
    descLower.includes('for use when');

  if (!hasTrigger) {
    findings.push({
      ruleId: 'skill/routing/no-trigger',
      severity: 'warn',
      message: 'Description lacks a trigger condition — Claude uses this to decide when to invoke the skill',
      suggestion: 'Append: "Use when working with X or when the user mentions Y."',
    });
  }

  if (desc.trim().length < 20) {
    findings.push({
      ruleId: 'skill/routing/description-too-short',
      severity: 'warn',
      message: 'Description is too short for reliable skill discovery',
      suggestion: 'Include: what operations this skill performs + when to invoke it',
    });
  }

  const vaguePatterns = ['helps with', 'does stuff', 'handles things', 'processes data', 'does things'];
  for (const p of vaguePatterns) {
    if (descLower.includes(p)) {
      findings.push({
        ruleId: 'skill/routing/vague-description',
        severity: 'warn',
        message: `Description contains vague phrase "${p}" — list specific operations instead`,
        suggestion: 'e.g. "Extracts text, fills forms, and merges PDF documents"',
      });
      break;
    }
  }

  return findings;
}

// Cross-skill invocations: surface the skills this one delegates to, so the
// dependency is visible even when the skill is linted on its own. Runs
// regardless of disable-model-invocation (orchestrator skills are user-invoked).
function dependencyRules(parsed: ParsedFile): Finding[] {
  const invocations = extractSkillInvocations(parsed);
  if (invocations.length === 0) return [];

  const names = invocations.map(i => `/${i.name}`);
  return [{
    ruleId: 'skill/routing/invokes-skill',
    severity: 'info',
    message: `Invokes ${names.length} other skill(s): ${names.join(', ')} — not analyzed together with this skill`,
    line: invocations[0].line,
    suggestion: 'Lint the invoked skills too, or run `vibe-check diagnose` on the workspace so the whole chain is checked',
  }];
}

// ── Category 3: Structure (15%) ──────────────────────────────────────────────

function structureRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];

  // Body line count
  if (parsed.bodyLines.length > 500) {
    findings.push({
      ruleId: 'skill/structure/body-too-long',
      severity: 'warn',
      message: `Body is ${parsed.bodyLines.length} lines; recommended maximum is 500`,
      suggestion: 'Move detailed reference into REFERENCE.md, EXAMPLES.md, etc. and link from SKILL.md',
    });
  }

  // At least one H2 section
  const h2s = parsed.headings.filter(h => h.level === 2);
  if (h2s.length === 0 && parsed.bodyLines.length > 30) {
    findings.push({
      ruleId: 'skill/structure/no-sections',
      severity: 'info',
      message: 'No H2 sections found — organize content into named sections',
      suggestion: 'Add: ## Quick start, ## Workflow, ## Examples',
    });
  }

  // Windows-style paths
  const winPathRe = /(?<![a-zA-Z])(?:[a-zA-Z]:\\|(?:scripts|reference|docs|src)\\)/;
  parsed.bodyLines.forEach((line, i) => {
    if (winPathRe.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('#')) {
      findings.push({
        ruleId: 'skill/structure/windows-paths',
        severity: 'warn',
        message: 'Windows-style backslash path — use forward slashes for cross-platform compatibility',
        line: parsed.bodyLineOffset + i + 1,
        suggestion: 'Replace \\ with /: scripts\\helper.py → scripts/helper.py',
      });
    }
  });

  // Deeply nested references (path depth > 1 directory)
  for (const link of parsed.links) {
    if (link.href.startsWith('http') || link.href.startsWith('#') || link.href.startsWith('mailto:')) continue;
    const cleanHref = link.href.split('#')[0];
    if (cleanHref.split('/').length - 1 > 1) {
      findings.push({
        ruleId: 'skill/structure/deep-reference',
        severity: 'info',
        message: `Reference "${link.href}" is more than one level deep — keep all refs one level from SKILL.md`,
        line: link.line,
        suggestion: 'Reorganize so all referenced files are direct children of the skill directory',
      });
    }
  }

  // Progressive disclosure: one section hogging the body should move to a reference file
  const tokenAnalysis = analyzeTokens(parsed.raw);
  if (tokenAnalysis.total > 800 && tokenAnalysis.perSection.length >= 3 &&
      tokenAnalysis.dominant && tokenAnalysis.dominant.pct >= 40 &&
      tokenAnalysis.dominant.heading !== '(preamble)') {
    findings.push({
      ruleId: 'skill/structure/dominant-section',
      severity: 'info',
      message: `Section "${tokenAnalysis.dominant.heading}" is ${tokenAnalysis.dominant.pct}% of the body (~${tokenAnalysis.dominant.tokens} tokens) — candidate for progressive disclosure`,
      suggestion: `Move it to a reference file (e.g. ${tokenAnalysis.dominant.heading.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}.md) and link it; Claude loads it only when needed`,
    });
  }

  return findings;
}

// ── Category 4: Content Quality (15%) ────────────────────────────────────────

function contentRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];
  const bodyLower = parsed.body.toLowerCase();

  // Time-sensitive dates
  const timeSensitiveRe = /(?:before|after|as of|deprecated in|updated in)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\w+\s+)?202[0-9]/gi;
  parsed.bodyLines.forEach((line, i) => {
    if (timeSensitiveRe.test(line)) {
      timeSensitiveRe.lastIndex = 0;
      findings.push({
        ruleId: 'skill/content/time-sensitive',
        severity: 'warn',
        message: 'Time-sensitive date reference will become stale',
        line: parsed.bodyLineOffset + i + 1,
        suggestion: 'Use version-relative language or move to an "## Legacy" / "## Old patterns" section',
      });
    }
    timeSensitiveRe.lastIndex = 0;
  });

  // Filler phrases
  const FILLER = [
    'always remember to', 'it is important to', 'please note that',
    'make sure to always', 'as you can see', 'needless to say',
    'first and foremost', 'it should be noted that',
  ];
  const seenFiller = new Set<string>();
  FILLER.forEach(phrase => {
    if (bodyLower.includes(phrase) && !seenFiller.has(phrase)) {
      seenFiller.add(phrase);
      const lineIdx = parsed.bodyLines.findIndex(l => l.toLowerCase().includes(phrase));
      findings.push({
        ruleId: 'skill/content/filler-phrase',
        severity: 'info',
        message: `Filler phrase "${phrase}" wastes context tokens`,
        line: lineIdx >= 0 ? parsed.bodyLineOffset + lineIdx + 1 : undefined,
        suggestion: 'State the instruction directly; Claude does not need the preamble',
      });
    }
  });

  // Unqualified MCP tool references
  const mcpToolRe = /(?:use the|call the|invoke the|run the)\s+([A-Za-z_][A-Za-z0-9_]*)\s+tool\b/gi;
  let m: RegExpExecArray | null;
  const skipTools = new Set(['bash', 'python', 'read', 'write', 'edit', 'grep', 'find']);
  while ((m = mcpToolRe.exec(parsed.body)) !== null) {
    const toolName = m[1];
    if (!toolName.includes(':') && !skipTools.has(toolName.toLowerCase())) {
      const lineNum = parsed.body.slice(0, m.index).split('\n').length + parsed.bodyLineOffset;
      findings.push({
        ruleId: 'skill/content/mcp-unqualified-tool',
        severity: 'info',
        message: `Unqualified MCP tool reference: "${toolName}" — should be "ServerName:${toolName}"`,
        line: lineNum,
        suggestion: 'Use fully qualified names: BigQuery:run_query, GitHub:create_issue, etc.',
      });
    }
  }

  // Too many alternatives without a default
  const alternativeCount = (parsed.body.match(/\b(alternatively|or you can|or use|you could also|another option is)\b/gi) ?? []).length;
  if (alternativeCount >= 3) {
    findings.push({
      ruleId: 'skill/content/too-many-options',
      severity: 'info',
      message: `${alternativeCount} alternative approaches offered — pick a default, mention fallback only`,
      suggestion: 'Choose one recommended library/approach; add a one-line note for the edge-case alternative',
    });
  }

  // Duplicated prose lines
  for (const d of findDuplicateLines(parsed.bodyLines)) {
    findings.push({
      ruleId: 'skill/content/duplicate-content',
      severity: 'info',
      message: `Line duplicates line ${parsed.bodyLineOffset + d.firstLine} — repeated content wastes tokens`,
      line: parsed.bodyLineOffset + d.repeatLine,
      suggestion: 'State each instruction once; repetition does not increase compliance',
    });
  }

  // Code-related skill with no code examples
  const desc = String(parsed.frontmatter?.['description'] ?? '').toLowerCase();
  const isCodeRelated = /python|javascript|typescript|bash|script|api|sql|json|yaml|cli|command/.test(desc);
  if (isCodeRelated && parsed.codeBlocks.length === 0) {
    findings.push({
      ruleId: 'skill/content/no-code-examples',
      severity: 'warn',
      message: 'Skill description mentions code/scripting but body has no code examples',
      suggestion: 'Add at least one fenced code block showing the primary usage pattern',
    });
  }

  return findings;
}

// ── Category 5: Robustness (10%) ─────────────────────────────────────────────

function robustnessRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];

  const executableBlocks = parsed.codeBlocks.filter(b =>
    ['python', 'py', 'javascript', 'js', 'typescript', 'ts', 'bash', 'sh', 'zsh'].includes(b.lang.toLowerCase())
  );

  if (executableBlocks.length >= 2) {
    const hasErrorHandling = executableBlocks.some(b => {
      const lower = b.content.toLowerCase();
      return /\btry\s*[:{]|\bexcept\b|\bcatch\b|\.catch\s*\(|\bon_error\b|\btrap\s+|set\s+-e\b/im.test(lower);
    });
    if (!hasErrorHandling) {
      findings.push({
        ruleId: 'skill/robustness/no-error-handling',
        severity: 'info',
        message: 'Multiple code blocks but no error handling patterns found',
        suggestion: 'Show at least one try/catch or error-handling pattern so Claude follows the same convention',
      });
    }
  }

  // Check for magic numbers in code blocks
  executableBlocks.forEach(block => {
    block.content.split('\n').forEach((line, i) => {
      // bare numeric constant assigned, no comment, and not an obvious index/flag
      if (/=\s*\d{2,}/.test(line) && !/#|\/\//.test(line) &&
          !/(?:version|port|size|length|count|max|min|limit|width|height|index|step|page)\s*=/i.test(line)) {
        findings.push({
          ruleId: 'skill/robustness/magic-number',
          severity: 'info',
          message: `Undocumented numeric constant (line ${block.line + i})`,
          line: block.line + i,
          suggestion: 'Add a comment explaining why this value was chosen (Ousterhout\'s law)',
        });
      }
    });
  });

  // Dependency usage without installation docs
  const hasImport = /^(?:import |from |require\(|pip install|npm install)/m.test(parsed.body);
  const hasDepsSection = /^##\s+(?:requirements?|dependencies|installation|setup|prerequisites)/im.test(parsed.body);
  if (hasImport && !hasDepsSection && executableBlocks.length > 0) {
    findings.push({
      ruleId: 'skill/robustness/no-dependency-docs',
      severity: 'info',
      message: 'Code imports packages but no dependencies/setup section found',
      suggestion: 'Add a "## Requirements" section listing required packages and installation commands',
    });
  }

  return findings;
}

// ── Category 6: Security (15%) — delegated to shared scanner ─────────────────
// ── Category 7: Portability (10%) ────────────────────────────────────────────

function portabilityRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];

  // Hardcoded absolute home paths
  const homePathRe = /\/home\/[a-zA-Z0-9_.-]+\//g;
  parsed.bodyLines.forEach((line, i) => {
    if (homePathRe.test(line) && !line.trim().startsWith('#') && !line.trim().startsWith('//')) {
      findings.push({
        ruleId: 'skill/portability/hardcoded-home-path',
        severity: 'warn',
        message: 'Hardcoded absolute home directory path — use ~ or $HOME instead',
        line: parsed.bodyLineOffset + i + 1,
        suggestion: 'Replace /home/username/... with ~/... or $HOME/...',
      });
    }
    homePathRe.lastIndex = 0;
  });

  return findings;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function lintSkill(parsed: ParsedFile, suppress: Set<string>): CategoryResult[] {
  const filter = (findings: Finding[]) => findings.filter(f => !suppress.has(f.ruleId));

  const defs: Array<{ id: string; name: string; weight: number; findings: Finding[] }> = [
    { id: 'metadata',    name: 'Identity & Metadata',  weight: 0.20, findings: filter(metadataRules(parsed)) },
    { id: 'routing',     name: 'Routing & Discovery',  weight: 0.15, findings: filter([...routingRules(parsed), ...dependencyRules(parsed)]) },
    { id: 'structure',   name: 'Structure',             weight: 0.15, findings: filter(structureRules(parsed)) },
    { id: 'content',     name: 'Content Quality',       weight: 0.15, findings: filter(contentRules(parsed)) },
    { id: 'robustness',  name: 'Robustness',            weight: 0.10, findings: filter(robustnessRules(parsed)) },
    { id: 'security',    name: 'Security',              weight: 0.15, findings: filter(scanSecurity(parsed, 'skill')) },
    { id: 'portability', name: 'Portability',           weight: 0.10, findings: filter(portabilityRules(parsed)) },
  ];

  return defs.map(d => ({ ...d, score: scoreCategory(d.findings) }));
}
