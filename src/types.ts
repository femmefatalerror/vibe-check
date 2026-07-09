export type Severity = 'error' | 'warn' | 'info';
export type FileType = 'skill' | 'agent' | 'unknown';
export type Grade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D+' | 'D' | 'D-' | 'F';

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  line?: number;
  suggestion?: string;
  file?: string; // set when the finding is in a companion file, not the linted .md itself
}

export interface CategoryResult {
  id: string;
  name: string;
  weight: number;  // 0-1; weights within a lint type sum to 1
  score: number;   // 0-10
  findings: Finding[];
}

export interface TokenSection {
  heading: string;
  tokens: number;
  pct: number;
}

export interface TokenAnalysis {
  total: number;
  perSection: TokenSection[];
  dominant?: TokenSection;
  grade: 'A' | 'B' | 'C' | 'D';
  fillerCount: number;
}

export interface LintResult {
  file: string;
  type: FileType;
  categories: CategoryResult[];
  score: number;      // 0-100 weighted aggregate
  grade: Grade;
  tokens: TokenAnalysis;
  suppressed: number; // count of suppressed rule IDs in config
}

export interface Config {
  suppress?: string[];
  severity?: Record<string, Severity>;
}

export interface BrokenRef {
  source: string;
  ref: string;
  line: number;
}

export interface RoutingConflict {
  skillA: string;
  skillB: string;
  reason: string;
}

// A skill invoked by slash-command name, e.g. `/grilling`.
export interface SkillInvocation {
  name: string;
  line: number;
}

// A cross-skill invocation that resolves to no known skill in the workspace.
export interface UnresolvedInvocation {
  source: string;
  name: string;
  line: number;
}

export interface InlineDisable {
  ruleId: string;
  line?: number; // set for lint-disable-next-line (the line the disable applies to)
}

export interface WorkspaceDiagnosis {
  root: string;
  files: LintResult[];
  totalTokens: number;
  agentTokens: number;          // always-loaded context cost
  tokenBudgetWarning: boolean;  // agent tokens > 8000
  brokenRefs: BrokenRef[];
  routingConflicts: RoutingConflict[];
  unresolvedInvocations: UnresolvedInvocation[];
  workspaceScore: number;
  workspaceGrade: Grade;
  totalErrors: number;
  totalWarnings: number;
  criticalSecurityIssues: number;
}

export interface ParsedFile {
  path: string;
  raw: string;
  frontmatter: Record<string, unknown> | null;
  frontmatterError: string | null;
  body: string;
  bodyLines: string[];
  bodyLineOffset: number;  // 1-based line where body starts
  headings: Array<{ level: number; text: string; line: number }>;
  codeBlocks: Array<{ lang: string; content: string; line: number }>;
  links: Array<{ text: string; href: string; line: number }>;
  disables: InlineDisable[];
}
