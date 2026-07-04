import type { TokenAnalysis } from './types';

const FILLER_PHRASES = [
  'always remember to',
  'it is important to',
  'please note that',
  'it is worth noting',
  'make sure to always',
  'as you can see',
  'needless to say',
  'first and foremost',
  'last but not least',
  'in order to',
  'it should be noted that',
  'as mentioned above',
  'as mentioned earlier',
  'feel free to',
];

// ~4 chars/token (BPE approximation for English/code mix; good enough for planning)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface DuplicateLine {
  text: string;
  firstLine: number;  // 1-based within the given lines array
  repeatLine: number;
}

// Exact-duplicate prose lines waste context tokens on every load.
// Only substantial lines count; tables, fences, and headings repeat legitimately.
export function findDuplicateLines(lines: string[]): DuplicateLine[] {
  const seen = new Map<string, number>();
  const dupes: DuplicateLine[] = [];
  const reported = new Set<string>();
  let inCodeBlock = false;

  lines.forEach((line, i) => {
    if (/^```/.test(line.trim())) { inCodeBlock = !inCodeBlock; return; }
    if (inCodeBlock) return;

    const norm = line.trim().toLowerCase().replace(/\s+/g, ' ');
    if (norm.length < 40 || norm.startsWith('|') || norm.startsWith('#')) return;

    const first = seen.get(norm);
    if (first !== undefined && !reported.has(norm)) {
      reported.add(norm);
      dupes.push({ text: line.trim(), firstLine: first + 1, repeatLine: i + 1 });
    } else if (first === undefined) {
      seen.set(norm, i);
    }
  });

  return dupes;
}

export function analyzeTokens(content: string): TokenAnalysis {
  const total = estimateTokens(content);

  // Split into logical sections by H2 headings
  const parts = content.split(/(?=^##\s)/m);
  const perSection = parts
    .map(p => {
      const m = p.match(/^##\s+(.+)/m);
      const heading = m ? m[1].trim() : '(preamble)';
      const tokens = estimateTokens(p);
      return { heading, tokens, pct: 0 };
    })
    .filter(s => s.tokens > 5);

  const sectionTotal = perSection.reduce((s, x) => s + x.tokens, 0) || 1;
  perSection.forEach(s => { s.pct = Math.round((s.tokens / sectionTotal) * 100); });
  perSection.sort((a, b) => b.tokens - a.tokens);

  const dominant = perSection[0];

  const lower = content.toLowerCase();
  const fillerCount = FILLER_PHRASES.filter(p => lower.includes(p)).length;

  // Token grade thresholds:
  //   Skills: body should be <500 lines ≈ <3000 tokens; metadata is ~100 tokens always loaded
  //   Agents: always in context, ideally <1500 tokens
  // We use a single scale here; callers add context in display
  let grade: 'A' | 'B' | 'C' | 'D';
  if (total <= 250) grade = 'A';
  else if (total <= 800) grade = 'B';
  else if (total <= 2500) grade = 'C';
  else grade = 'D';

  return { total, perSection, dominant, grade, fillerCount };
}
