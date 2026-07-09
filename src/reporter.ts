import pc from 'picocolors';
import * as path from 'path';
import type { LintResult, WorkspaceDiagnosis, Severity } from './types';

// ── Shared helpers ────────────────────────────────────────────────────────────

function bar(score: number, max = 10, width = 10): string {
  const filled = Math.round((score / max) * width);
  return pc.green('█'.repeat(filled)) + pc.dim('░'.repeat(width - filled));
}

function gradeColor(score: number): (s: string) => string {
  if (score >= 90) return pc.green;
  if (score >= 70) return pc.yellow;
  return pc.red;
}

function severityIcon(s: Severity): string {
  if (s === 'error') return pc.red('✗');
  if (s === 'warn')  return pc.yellow('⚠');
  return pc.blue('ℹ');
}

function severityLabel(s: Severity): string {
  if (s === 'error') return pc.red('[ERROR]');
  if (s === 'warn')  return pc.yellow('[WARN] ');
  return pc.blue('[INFO] ');
}

function tokenGradeColor(g: string): (s: string) => string {
  if (g === 'A') return pc.green;
  if (g === 'B') return pc.cyan;
  if (g === 'C') return pc.yellow;
  return pc.red;
}

function vibeVerdict(score: number, errorCount: number): string {
  if (errorCount > 0 || score < 60) return pc.red(pc.bold('  ❌ Failed the vibe check.'));
  if (score < 80) return pc.yellow(pc.bold('  ⚠ The vibes are questionable.'));
  if (score < 95) return pc.green(pc.bold('  ✅ Passed the vibe check.'));
  return pc.green(pc.bold('  ✨ Immaculate vibes.'));
}

// ── Terminal: single file ─────────────────────────────────────────────────────

export function reportTerminal(result: LintResult): void {
  const { file, type, categories, score, grade, tokens } = result;
  const gc = gradeColor(score);

  console.log('');
  console.log(pc.bold(pc.cyan('━'.repeat(56))));
  console.log(pc.bold(`  ${file}`));
  console.log(pc.dim(`  type: ${type}`));
  console.log(pc.bold(pc.cyan('━'.repeat(56))));
  console.log('');
  console.log(`  Score  ${gc(pc.bold(score.toFixed(1).padStart(5)))} / 100    Grade  ${gc(pc.bold(grade))}`);
  console.log('');

  for (const cat of categories) {
    const catGC = gradeColor(cat.score * 10);
    const scoreStr = catGC(cat.score.toFixed(1).padStart(4));
    console.log(`  ${cat.name.padEnd(24)} ${bar(cat.score)}  ${scoreStr}/10`);
  }

  console.log('');
  const tgc = tokenGradeColor(tokens.grade);
  console.log(`  ${pc.dim('Tokens (est.)')}  ${tgc(`~${tokens.total}`)}  ${pc.dim(`grade ${tokens.grade}`)}`);

  if (tokens.dominant && tokens.perSection.length > 1) {
    const d = tokens.dominant;
    console.log(`  ${pc.dim('Largest section')}  ${d.heading} ${pc.dim(`(${d.pct}% of body)`)}`);
  }

  if (tokens.fillerCount > 0) {
    console.log(`  ${pc.yellow(`⚠ ${tokens.fillerCount} filler phrase(s) — wasted tokens`)}`);
  }

  const allFindings = categories.flatMap(c =>
    c.findings.map(f => ({ ...f, categoryName: c.name }))
  );

  if (allFindings.length === 0) {
    console.log('');
    console.log(`  ${pc.green('✓ No issues found')}`);
  } else {
    console.log('');
    console.log(pc.bold('  Findings'));
    console.log('');

    const sorted = [
      ...allFindings.filter(f => f.severity === 'error'),
      ...allFindings.filter(f => f.severity === 'warn'),
      ...allFindings.filter(f => f.severity === 'info'),
    ];

    for (const f of sorted) {
      const loc = pc.dim(`${f.file ? ` ${f.file}` : ''}${f.line ? ` :${f.line}` : ''}`);
      console.log(`  ${severityIcon(f.severity)} ${severityLabel(f.severity)} ${pc.dim(f.ruleId)}${loc}`);
      console.log(`      ${f.message}`);
      if (f.suggestion) {
        const lines = f.suggestion.split('\n');
        console.log(`      ${pc.dim('→')} ${pc.cyan(lines[0])}`);
        lines.slice(1).forEach(l => console.log(`        ${pc.cyan(l)}`));
      }
      console.log('');
    }
  }

  if (result.suppressed > 0) {
    console.log(pc.dim(`  (${result.suppressed} rule(s) suppressed by config)`));
    console.log('');
  }

  console.log(vibeVerdict(score, allFindings.filter(f => f.severity === 'error').length));
  console.log('');
}

// ── Terminal: workspace ───────────────────────────────────────────────────────

export function reportWorkspaceTerminal(diag: WorkspaceDiagnosis): void {
  const gc = gradeColor(diag.workspaceScore);

  console.log('');
  console.log(pc.bold(pc.magenta('━'.repeat(62))));
  console.log(pc.bold(pc.magenta(`  Workspace Diagnosis`)));
  console.log(pc.dim(`  ${diag.root}`));
  console.log(pc.bold(pc.magenta('━'.repeat(62))));
  console.log('');
  console.log(`  Score  ${gc(pc.bold(diag.workspaceScore.toFixed(1).padStart(5)))} / 100    Grade  ${gc(pc.bold(diag.workspaceGrade))}`);
  console.log('');

  const skillCount = diag.files.filter(f => f.type === 'skill').length;
  const agentCount = diag.files.filter(f => f.type === 'agent').length;

  console.log(`  ${pc.bold('Files')}       ${diag.files.length}  (${skillCount} skills, ${agentCount} agents)`);

  const tokenStr = `~${diag.totalTokens} total  (agents ~${diag.agentTokens} always loaded)`;
  const tokenDisplay = diag.tokenBudgetWarning
    ? tokenStr + pc.red(' ⚠ budget exceeded')
    : tokenStr;
  console.log(`  ${pc.bold('Tokens')}      ${tokenDisplay}`);

  const errStr = diag.totalErrors > 0 ? pc.red(String(diag.totalErrors)) : pc.green('0');
  const warnStr = diag.totalWarnings > 0 ? pc.yellow(String(diag.totalWarnings)) : pc.green('0');
  console.log(`  ${pc.bold('Errors')}      ${errStr}`);
  console.log(`  ${pc.bold('Warnings')}    ${warnStr}`);

  if (diag.criticalSecurityIssues > 0) {
    console.log('');
    console.log(`  ${pc.red(pc.bold(`⚠ ${diag.criticalSecurityIssues} critical security issue(s) found`))}`);
  }

  if (diag.brokenRefs.length > 0) {
    console.log('');
    console.log(pc.bold(pc.red('  Broken References')));
    for (const r of diag.brokenRefs) {
      console.log(`  ${pc.red('✗')} ${pc.dim(path.relative(diag.root, r.source))}:${r.line} → "${r.ref}"`);
    }
  }

  if (diag.routingConflicts.length > 0) {
    console.log('');
    console.log(pc.bold(pc.yellow('  Routing Conflicts')));
    for (const c of diag.routingConflicts) {
      console.log(`  ${pc.yellow('⚠')} ${pc.dim(path.relative(diag.root, c.skillA))} ↔ ${pc.dim(path.relative(diag.root, c.skillB))}`);
      console.log(`      ${c.reason}`);
    }
  }

  if (diag.unresolvedInvocations.length > 0) {
    console.log('');
    console.log(pc.bold(pc.yellow('  Unresolved Skill Invocations')));
    for (const u of diag.unresolvedInvocations) {
      console.log(`  ${pc.yellow('⚠')} ${pc.dim(path.relative(diag.root, u.source))}:${u.line} → ${pc.bold('/' + u.name)} (no such skill in workspace)`);
    }
  }

  console.log('');
  console.log(pc.bold('  Files'));
  console.log(pc.dim('  ' + 'Grade Score Type   Issues  Path'));
  console.log(pc.dim('  ' + '─'.repeat(58)));

  for (const f of diag.files) {
    const fgc = gradeColor(f.score);
    const findings = f.categories.flatMap(c => c.findings);
    const errors = findings.filter(x => x.severity === 'error').length;
    const warns  = findings.filter(x => x.severity === 'warn').length;
    const issueStr = [
      errors ? pc.red(`${errors}E`) : '',
      warns  ? pc.yellow(`${warns}W`) : '',
    ].filter(Boolean).join(' ') || pc.green('OK');

    const rel = path.relative(diag.root, f.file);
    console.log(
      `  ${fgc(f.grade.padEnd(3))} ${fgc(f.score.toFixed(0).padStart(4))}  ${pc.dim(f.type.padEnd(6))} ${issueStr.padEnd(10)}  ${rel}`
    );
  }

  console.log('');
  const crossFileIssues = diag.routingConflicts.length + diag.brokenRefs.length + diag.unresolvedInvocations.length;
  // cross-file issues cap the verdict below "immaculate"
  const verdictScore = crossFileIssues > 0 ? Math.min(diag.workspaceScore, 94) : diag.workspaceScore;
  console.log(vibeVerdict(verdictScore, diag.totalErrors));
  console.log('');
}

// ── JSON ─────────────────────────────────────────────────────────────────────

export function reportJson(result: LintResult): string {
  return JSON.stringify(result, null, 2);
}

export function reportWorkspaceJson(diag: WorkspaceDiagnosis): string {
  return JSON.stringify(diag, null, 2);
}

// ── Markdown ──────────────────────────────────────────────────────────────────

export function reportMarkdown(result: LintResult): string {
  const { file, type, categories, score, grade, tokens } = result;
  const allFindings = categories.flatMap(c => c.findings);

  const lines: string[] = [
    `# Lint Report: \`${file}\``,
    '',
    `| | |`,
    `|---|---|`,
    `| **Type** | ${type} |`,
    `| **Score** | ${score.toFixed(1)} / 100 |`,
    `| **Grade** | ${grade} |`,
    `| **Token estimate** | ~${tokens.total} (Grade ${tokens.grade}) |`,
    '',
    '## Category Scores',
    '',
    '| Category | Score | Weight |',
    '|----------|-------|--------|',
    ...categories.map(c => `| ${c.name} | ${c.score.toFixed(1)} / 10 | ${Math.round(c.weight * 100)}% |`),
    '',
    '## Findings',
    '',
  ];

  if (allFindings.length === 0) {
    lines.push('✅ No issues found.');
  } else {
    const grouped = {
      error: allFindings.filter(f => f.severity === 'error'),
      warn:  allFindings.filter(f => f.severity === 'warn'),
      info:  allFindings.filter(f => f.severity === 'info'),
    };

    const emojis = { error: '❌', warn: '⚠️', info: 'ℹ️' } as const;
    for (const [sev, group] of Object.entries(grouped) as [Severity, typeof allFindings][]) {
      if (group.length === 0) continue;
      lines.push(`### ${sev.charAt(0).toUpperCase() + sev.slice(1)}s`, '');
      for (const f of group) {
        lines.push(`**${emojis[sev]} \`${f.ruleId}\`**${f.file ? ` — \`${f.file}\`` : ''}${f.line ? ` — line ${f.line}` : ''}`);
        lines.push('');
        lines.push(f.message);
        if (f.suggestion) lines.push('', `> 💡 ${f.suggestion.replace(/\n/g, '\n> ')}`);
        lines.push('');
      }
    }
  }

  if (tokens.fillerCount > 0) {
    lines.push(`> ⚠️ ${tokens.fillerCount} filler phrase(s) detected — wasted context tokens`);
    lines.push('');
  }

  return lines.join('\n');
}

export function reportWorkspaceMarkdown(diag: WorkspaceDiagnosis): string {
  const lines: string[] = [
    `# Workspace Diagnosis`,
    '',
    `**Root:** \`${diag.root}\`  **Score:** ${diag.workspaceScore.toFixed(1)} / 100  **Grade:** ${diag.workspaceGrade}`,
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Files | ${diag.files.length} (${diag.files.filter(f => f.type === 'skill').length} skills, ${diag.files.filter(f => f.type === 'agent').length} agents) |`,
    `| Total tokens | ~${diag.totalTokens} |`,
    `| Agent tokens (always loaded) | ~${diag.agentTokens}${diag.tokenBudgetWarning ? ' ⚠️ **over budget**' : ''} |`,
    `| Errors | ${diag.totalErrors} |`,
    `| Warnings | ${diag.totalWarnings} |`,
    `| Critical security issues | ${diag.criticalSecurityIssues} |`,
    '',
  ];

  if (diag.brokenRefs.length > 0) {
    lines.push('## Broken References', '');
    for (const r of diag.brokenRefs) {
      lines.push(`- \`${r.source}\` line ${r.line} → broken link \`${r.ref}\``);
    }
    lines.push('');
  }

  if (diag.routingConflicts.length > 0) {
    lines.push('## Routing Conflicts', '');
    for (const c of diag.routingConflicts) {
      lines.push(`- \`${c.skillA}\` ↔ \`${c.skillB}\` — ${c.reason}`);
    }
    lines.push('');
  }

  if (diag.unresolvedInvocations.length > 0) {
    lines.push('## Unresolved Skill Invocations', '');
    for (const u of diag.unresolvedInvocations) {
      lines.push(`- \`${u.source}\` line ${u.line} invokes \`/${u.name}\` — no such skill in workspace`);
    }
    lines.push('');
  }

  lines.push('## File Results', '');
  lines.push('| Grade | Score | Type | Errors | Warnings | File |');
  lines.push('|-------|-------|------|--------|----------|------|');

  for (const f of diag.files) {
    const findings = f.categories.flatMap(c => c.findings);
    const errors = findings.filter(x => x.severity === 'error').length;
    const warns  = findings.filter(x => x.severity === 'warn').length;
    lines.push(`| ${f.grade} | ${f.score.toFixed(0)} | ${f.type} | ${errors} | ${warns} | \`${f.file}\` |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ── SARIF 2.1.0 (GitHub code scanning) ───────────────────────────────────────

export function reportSarif(results: LintResult[]): string {
  const levelMap = { error: 'error', warn: 'warning', info: 'note' } as const;
  const ruleIds = new Map<string, { id: string; shortDescription: { text: string } }>();
  const sarifResults: object[] = [];

  for (const r of results) {
    for (const cat of r.categories) {
      for (const f of cat.findings) {
        if (!ruleIds.has(f.ruleId)) {
          ruleIds.set(f.ruleId, { id: f.ruleId, shortDescription: { text: f.message } });
        }
        const uri = (f.file ?? r.file).replace(/\\/g, '/').replace(/^\.\//, '');
        sarifResults.push({
          ruleId: f.ruleId,
          level: levelMap[f.severity],
          message: { text: f.suggestion ? `${f.message} — ${f.suggestion}` : f.message },
          locations: [{
            physicalLocation: {
              artifactLocation: { uri },
              region: { startLine: f.line ?? 1 },
            },
          }],
        });
      }
    }
  }

  return JSON.stringify({
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'vibe-check',
          informationUri: 'https://github.com/femmefatalerror/vibe-check',
          rules: [...ruleIds.values()],
        },
      },
      results: sarifResults,
    }],
  }, null, 2);
}

// ── Batch summary (terminal only) ────────────────────────────────────────────

export function reportBatchSummary(results: LintResult[]): void {
  if (results.length === 0) return;

  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  const totalErrors   = results.flatMap(r => r.categories.flatMap(c => c.findings)).filter(f => f.severity === 'error').length;
  const totalWarnings = results.flatMap(r => r.categories.flatMap(c => c.findings)).filter(f => f.severity === 'warn').length;
  const gc = gradeColor(avgScore);

  console.log(pc.bold(pc.cyan('━'.repeat(56))));
  console.log(pc.bold('  Batch Summary'));
  console.log(`  Files checked  ${results.length}`);
  console.log(`  Average score  ${gc(avgScore.toFixed(1))} / 100`);
  console.log(`  Total errors   ${totalErrors > 0 ? pc.red(String(totalErrors)) : pc.green('0')}`);
  console.log(`  Total warnings ${totalWarnings > 0 ? pc.yellow(String(totalWarnings)) : pc.green('0')}`);
  console.log(pc.bold(pc.cyan('━'.repeat(56))));
  console.log('');
}
