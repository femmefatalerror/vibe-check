import * as path from 'path';
import type { Finding, ParsedFile } from '../types';

// Which harness convention an agent file follows, derived from its path.
// Determines which frontmatter schema applies.
export type AgentFlavor =
  | 'claude-subagent'      // .claude/agents/*.md
  | 'opencode-agent'       // .opencode/agent(s)/*.md, ~/.config/opencode/agent(s)/*.md
  | 'copilot-agent'        // *.agent.md (Copilot custom agents, APM agents)
  | 'copilot-instructions' // *.instructions.md (path-scoped Copilot instructions)
  | 'generic';             // CLAUDE.md, AGENTS.md, rules — no schema to enforce

export function detectAgentFlavor(filePath: string): AgentFlavor {
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.instructions.md')) return 'copilot-instructions';
  if (base.endsWith('.agent.md')) return 'copilot-agent';

  const segs = filePath.split(path.sep);
  const inAgentDir = segs.includes('agent') || segs.includes('agents');
  if (inAgentDir && segs.includes('.claude')) return 'claude-subagent';
  if (segs.includes('.opencode') || (inAgentDir && segs.includes('opencode'))) return 'opencode-agent';
  return 'generic';
}

const OPENCODE_MODES = new Set(['primary', 'subagent', 'all']);
const COPILOT_TARGETS = new Set(['vscode', 'github-copilot']);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Frontmatter findings anchor to line 2 (inside the frontmatter block),
// matching the skill meta rules; a missing block anchors to line 1.
export function harnessFrontmatterRules(parsed: ParsedFile): Finding[] {
  const flavor = detectAgentFlavor(parsed.path);
  if (flavor === 'generic') return [];

  const findings: Finding[] = [];
  const fm = parsed.frontmatter;
  const line = fm ? 2 : 1;

  const requireDescription = (what: string) => {
    if (!fm || typeof fm['description'] !== 'string' || !String(fm['description']).trim()) {
      findings.push({
        ruleId: 'agent/meta/missing-description',
        severity: 'error',
        message: `${what} needs a description in its frontmatter — without one it cannot be selected`,
        line,
        suggestion: 'Add: description: <what this agent does and when to use it>',
      });
    }
  };

  switch (flavor) {
    case 'claude-subagent': {
      requireDescription('A Claude Code subagent');
      const name = fm?.['name'];
      if (!fm || typeof name !== 'string' || !String(name).trim()) {
        findings.push({
          ruleId: 'agent/meta/missing-name',
          severity: 'error',
          message: 'A Claude Code subagent needs a name in its frontmatter',
          line,
          suggestion: 'Add: name: my-agent (lowercase letters, digits, hyphens)',
        });
      } else if (!NAME_RE.test(String(name))) {
        findings.push({
          ruleId: 'agent/meta/name-format',
          severity: 'warn',
          message: `Subagent name "${name}" should be lowercase letters, digits, and single hyphens`,
          line,
          suggestion: 'Rename like: code-reviewer',
        });
      }
      break;
    }

    case 'opencode-agent': {
      requireDescription('An OpenCode agent');
      const mode = fm?.['mode'];
      if (mode !== undefined && !OPENCODE_MODES.has(String(mode))) {
        findings.push({
          ruleId: 'agent/meta/invalid-mode',
          severity: 'error',
          message: `OpenCode agent mode "${mode}" is not valid — expected primary, subagent, or all`,
          line,
          suggestion: 'Set mode: subagent (invoked by other agents) or mode: primary (user-facing)',
        });
      }
      const temp = fm?.['temperature'];
      if (temp !== undefined && (typeof temp !== 'number' || temp < 0 || temp > 2)) {
        findings.push({
          ruleId: 'agent/meta/invalid-temperature',
          severity: 'warn',
          message: `temperature ${JSON.stringify(temp)} is not a number between 0 and 2`,
          line,
        });
      }
      if (fm && 'tools' in fm) {
        findings.push({
          ruleId: 'agent/meta/deprecated-tools',
          severity: 'info',
          message: 'The tools field is deprecated in OpenCode agents',
          line,
          suggestion: 'Use the permission field for fine-grained tool control',
        });
      }
      break;
    }

    case 'copilot-agent': {
      requireDescription('A Copilot custom agent');
      const target = fm?.['target'];
      if (target !== undefined && !COPILOT_TARGETS.has(String(target))) {
        findings.push({
          ruleId: 'agent/meta/invalid-target',
          severity: 'error',
          message: `Copilot agent target "${target}" is not valid — expected vscode or github-copilot`,
          line,
          suggestion: 'Remove target to make the agent available in both environments',
        });
      }
      break;
    }

    case 'copilot-instructions': {
      const applyTo = fm?.['applyTo'];
      if (!fm || applyTo === undefined) {
        findings.push({
          ruleId: 'agent/meta/missing-apply-to',
          severity: 'warn',
          message: 'Copilot *.instructions.md files scope themselves with an applyTo glob — without it the instructions may never attach',
          line,
          suggestion: 'Add frontmatter like: applyTo: "**/*.ts" (comma-separate multiple globs)',
        });
      } else if (typeof applyTo !== 'string' || !applyTo.trim()) {
        findings.push({
          ruleId: 'agent/meta/invalid-apply-to',
          severity: 'warn',
          message: 'applyTo must be a non-empty glob string',
          line,
          suggestion: 'Example: applyTo: "src/**/*.py, tests/**/*.py"',
        });
      }
      break;
    }
  }

  return findings;
}
