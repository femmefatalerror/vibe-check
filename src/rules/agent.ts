import type { Finding, ParsedFile, CategoryResult } from '../types';
import { scanSecurity } from './security';
import { scoreCategory } from '../score';
import { findDuplicateLines } from '../tokens';
import { harnessFrontmatterRules } from './harness';

// ── Category 1: Identity & Purpose (20%) ─────────────────────────────────────

function purposeRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];

  const h1 = parsed.headings.find(h => h.level === 1);
  if (!h1) {
    findings.push({
      ruleId: 'agent/purpose/no-title',
      severity: 'warn',
      message: 'No H1 title — agent files should open with a clear title',
      line: parsed.bodyLineOffset + 1,
      suggestion: 'Add: # My Agent Name',
    });
  }

  const openingContext = parsed.bodyLines.slice(0, 15).join('\n');
  const hasRole = /\b(you are|your role|your goal|your task|you act as|act as a|serve as|responsible for)\b/i.test(openingContext);
  if (!hasRole && parsed.bodyLines.length > 20) {
    findings.push({
      ruleId: 'agent/purpose/no-role-statement',
      severity: 'warn',
      message: 'No role or purpose statement in the opening section',
      suggestion: 'Start with: "You are..." or "Your role is..." so Claude knows its context immediately',
    });
  }

  return findings;
}

// ── Category 2: Instructions (20%) ───────────────────────────────────────────

function instructionRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];
  const bodyLower = parsed.body.toLowerCase();

  const FILLER = [
    'always remember to', 'it is important to', 'please note that',
    'make sure to always', 'as you can see', 'needless to say',
    'first and foremost', 'last but not least', 'in order to',
    'it should be noted that', 'feel free to',
  ];

  const seenFiller = new Set<string>();
  FILLER.forEach(phrase => {
    if (bodyLower.includes(phrase) && !seenFiller.has(phrase)) {
      seenFiller.add(phrase);
      const lineIdx = parsed.bodyLines.findIndex(l => l.toLowerCase().includes(phrase));
      findings.push({
        ruleId: 'agent/instructions/filler-phrase',
        severity: 'info',
        message: `Filler phrase "${phrase}" wastes context tokens (always in context for agent files)`,
        line: lineIdx >= 0 ? parsed.bodyLineOffset + lineIdx + 1 : undefined,
        suggestion: 'State the instruction directly without preamble',
      });
    }
  });

  // Time-sensitive dates
  const timeSensitiveRe = /(?:before|after|as of)\s+\w*\s*202[0-9]/gi;
  parsed.bodyLines.forEach((line, i) => {
    if (timeSensitiveRe.test(line)) {
      timeSensitiveRe.lastIndex = 0;
      findings.push({
        ruleId: 'agent/instructions/time-sensitive',
        severity: 'warn',
        message: 'Time-sensitive date reference will become stale',
        line: parsed.bodyLineOffset + i + 1,
        suggestion: 'Use version-relative or event-relative language instead of specific dates',
      });
    }
    timeSensitiveRe.lastIndex = 0;
  });

  // Duplicated prose lines — doubly expensive here since agent files are always loaded
  for (const d of findDuplicateLines(parsed.bodyLines)) {
    findings.push({
      ruleId: 'agent/instructions/duplicate-content',
      severity: 'info',
      message: `Line duplicates line ${parsed.bodyLineOffset + d.firstLine} — repeated content wastes always-loaded tokens`,
      line: parsed.bodyLineOffset + d.repeatLine,
      suggestion: 'State each instruction once; repetition does not increase compliance',
    });
  }

  // Tool documentation
  const mentionsTool = /\b(tool|function|capability|command)\b/i.test(parsed.body);
  const hasToolSection = /^##\s+(?:tools?|capabilities|functions?|commands?|available tools?)\s*$/im.test(parsed.body);
  if (mentionsTool && !hasToolSection && parsed.bodyLines.length > 60) {
    findings.push({
      ruleId: 'agent/instructions/no-tool-section',
      severity: 'info',
      message: 'Tools are referenced but no "## Tools" section found',
      suggestion: 'Add a "## Tools" section listing available tools with usage examples',
    });
  }

  return findings;
}

// ── Category 3: Boundaries & Safety (20%) ────────────────────────────────────

function boundaryRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];
  const body = parsed.body;

  const explicitConstraints = (body.match(/\b(NEVER|DO NOT|MUST NOT|CANNOT|DO NOT EVER)\b/g) ?? []).length;

  if (explicitConstraints < 2 && parsed.bodyLines.length > 50) {
    findings.push({
      ruleId: 'agent/boundaries/insufficient-constraints',
      severity: 'warn',
      message: `Only ${explicitConstraints} explicit constraint(s) (NEVER/DO NOT) — recommend at least 2`,
      suggestion: 'Add clear guard rails: "NEVER share user PII", "DO NOT execute commands without confirmation"',
    });
  }

  const hasStopping = /\b(stop (?:after|when|if)|max(?:imum)? (?:iteration|step|attempt|retry)|iteration[s]? limit|exit condition|abort if|give up after)\b/i.test(body);
  if (!hasStopping && parsed.bodyLines.length > 100) {
    findings.push({
      ruleId: 'agent/boundaries/no-stopping-condition',
      severity: 'warn',
      message: 'No stopping condition or iteration limit — autonomous agents need explicit exit criteria',
      suggestion: 'Add: "Stop after [N] unsuccessful attempts" or "Do not retry more than [N] times"',
    });
  }

  return findings;
}

// ── Category 4: Token Efficiency (15%) ───────────────────────────────────────

function tokenEfficiencyRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];
  const tokens = Math.ceil(parsed.raw.length / 4);

  if (tokens > 3000) {
    findings.push({
      ruleId: 'agent/tokens/very-large',
      severity: 'warn',
      message: `Agent file is ~${tokens} tokens — always loaded into context; consider splitting`,
      suggestion: 'Move procedures and references to skill files; keep agent file to identity, constraints, and high-level guidance',
    });
  } else if (tokens > 1500) {
    findings.push({
      ruleId: 'agent/tokens/large',
      severity: 'info',
      message: `Agent file is ~${tokens} tokens — review whether all content is essential`,
    });
  }

  if (tokens < 50 && parsed.bodyLines.length > 3) {
    findings.push({
      ruleId: 'agent/tokens/too-sparse',
      severity: 'info',
      message: 'Agent file has very little content — may not provide sufficient guidance',
      suggestion: 'Add at minimum: role definition, core constraints, and primary task guidance',
    });
  }

  return findings;
}

// ── Category 5: Security (15%) ───────────────────────────────────────────────
// delegated to shared scanner

// ── Category 6: Structure (10%) ──────────────────────────────────────────────

function structureRules(parsed: ParsedFile): Finding[] {
  const findings: Finding[] = [];

  const h2s = parsed.headings.filter(h => h.level === 2);
  if (h2s.length === 0 && parsed.bodyLines.length > 40) {
    findings.push({
      ruleId: 'agent/structure/no-sections',
      severity: 'info',
      message: 'No H2 sections — use headings to organize agent instructions for scannability',
      suggestion: 'Common sections: ## Role, ## Constraints, ## Instructions, ## Tools, ## Examples',
    });
  }

  return findings;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function lintAgent(parsed: ParsedFile, suppress: Set<string>): CategoryResult[] {
  const filter = (findings: Finding[]) => findings.filter(f => !suppress.has(f.ruleId));

  const defs: Array<{ id: string; name: string; weight: number; findings: Finding[] }> = [
    { id: 'purpose',    name: 'Identity & Purpose',  weight: 0.20, findings: filter([...harnessFrontmatterRules(parsed), ...purposeRules(parsed)]) },
    { id: 'instructions', name: 'Instructions',      weight: 0.20, findings: filter(instructionRules(parsed)) },
    { id: 'boundaries', name: 'Boundaries & Safety', weight: 0.20, findings: filter(boundaryRules(parsed)) },
    { id: 'tokens',     name: 'Token Efficiency',    weight: 0.15, findings: filter(tokenEfficiencyRules(parsed)) },
    { id: 'security',   name: 'Security',            weight: 0.15, findings: filter(scanSecurity(parsed, 'agent')) },
    { id: 'structure',  name: 'Structure',           weight: 0.10, findings: filter(structureRules(parsed)) },
  ];

  return defs.map(d => ({ ...d, score: scoreCategory(d.findings) }));
}
