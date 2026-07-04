#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { lintFile, lintDir, lintSkillWithCompanions, diagnoseWorkspace, loadConfig } from './linter';
import {
  reportTerminal, reportWorkspaceTerminal,
  reportJson, reportWorkspaceJson,
  reportMarkdown, reportWorkspaceMarkdown,
  reportBatchSummary, reportSarif,
} from './reporter';
import { isGithubUrl, fetchGithubSkill, fetchGithubAgent } from './github';
import type { Config, LintResult, FileType } from './types';

const VERSION = '0.3.0';

function format(opts: { json?: boolean; markdown?: boolean; sarif?: boolean }): 'json' | 'markdown' | 'sarif' | 'terminal' {
  if (opts.sarif) return 'sarif';
  if (opts.json) return 'json';
  if (opts.markdown) return 'markdown';
  return 'terminal';
}

function failsMinScore(results: LintResult[], minScore?: string): boolean {
  if (minScore === undefined) return false;
  const threshold = parseFloat(minScore);
  return results.some(r => r.score < threshold);
}

function config(opts: { config?: string; suppress?: string }): Config {
  const base = loadConfig(opts.config);
  if (opts.suppress) {
    base.suppress = [...(base.suppress ?? []), ...opts.suppress.split(',').map(s => s.trim())];
  }
  return base;
}

function write(content: string, file?: string): void {
  if (file) {
    fs.writeFileSync(file, content, 'utf-8');
    process.stderr.write(`Output written to ${file}\n`);
  } else {
    process.stdout.write(content + '\n');
  }
}

function emitResults(
  results: LintResult[],
  fmt: 'json' | 'markdown' | 'sarif' | 'terminal',
  opts: { output?: string }
): void {
  if (fmt === 'json') {
    write(results.length === 1 ? reportJson(results[0]) : JSON.stringify(results, null, 2), opts.output);
  } else if (fmt === 'markdown') {
    write(results.map(reportMarkdown).join('\n\n---\n\n'), opts.output);
  } else if (fmt === 'sarif') {
    write(reportSarif(results), opts.output);
  } else {
    results.forEach(reportTerminal);
  }
}

function hasErrors(results: LintResult[]): boolean {
  return results.some(r => r.categories.some(c => c.findings.some(f => f.severity === 'error')));
}

function resolveGlob(pattern: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  function matchWild(name: string, pat: string): boolean {
    const re = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '$');
    return re.test(name);
  }

  function walk(dir: string, parts: string[]): void {
    if (!fs.existsSync(dir)) return;
    const [head, ...tail] = parts;
    if (!head) return;

    if (head === '**') {
      // Recurse into all subdirs, try matching rest at each level
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, parts);       // keep ** in play
          walk(full, tail);        // also try without **
        } else if (tail.length > 0 && matchWild(e.name, tail[0]) && tail.length === 1) {
          if (!seen.has(full)) { seen.add(full); results.push(full); }
        }
      }
      return;
    }

    if (head.includes('*')) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!matchWild(e.name, head)) continue;
        const full = path.join(dir, e.name);
        if (tail.length === 0 && e.isFile()) {
          if (!seen.has(full)) { seen.add(full); results.push(full); }
        } else if (e.isDirectory()) {
          walk(full, tail);
        }
      }
      return;
    }

    // Literal segment
    const full = path.join(dir, head);
    if (tail.length === 0) {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        if (!seen.has(full)) { seen.add(full); results.push(full); }
      }
    } else if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      walk(full, tail);
    }
  }

  const parts = pattern.split('/');
  walk('.', parts);
  return results;
}

const program = new Command();

program
  .name('vibe-check')
  .version(VERSION)
  .description('You vibe-coded your agents. Time for a vibe check.\nLinter and security scanner for Claude skills, agents, and AI workspaces.');

// ── default: vibe-check <path> — figure out what it is and check it ──────────
program
  .command('auto <path>', { hidden: true })
  .option('-j, --json', 'JSON output')
  .option('-m, --markdown', 'Markdown output')
  .option('-s, --sarif', 'SARIF output (GitHub code scanning)')
  .option('-o, --output <file>', 'Write output to file')
  .option('-c, --config <file>', 'Config file (.vibe-check.json)')
  .option('--suppress <rules>', 'Comma-separated rule IDs to suppress')
  .option('--min-score <n>', 'Exit 1 if any score is below this threshold (CI quality gate)')
  .option('-v, --verbose', 'Also print individual file reports (workspace mode)')
  .action(async (target: string, opts) => {
    const cfg = config(opts);
    const fmt = format(opts);
    let tmpDir: string | undefined;

    try {
      if (isGithubUrl(target)) {
        process.stderr.write(`Fetching ${target} ...\n`);
        let localTarget: string;
        try {
          const fetched = await fetchGithubSkill(target);
          tmpDir = fetched.tmpDir;
          localTarget = fetched.skillPath;
        } catch {
          const fetched = await fetchGithubAgent(target);
          tmpDir = fetched.tmpDir;
          localTarget = fetched.agentPath;
        }
        const results = lintDir(path.dirname(localTarget), cfg);
        results.forEach(r => { r.file = target; });
        emitResults(results, fmt, opts);
        process.exit(hasErrors(results) || failsMinScore(results, opts.minScore) ? 1 : 0);
      }

      const stat = fs.statSync(target);

      if (stat.isDirectory() && !fs.existsSync(path.join(target, 'SKILL.md'))) {
        // No SKILL.md at the top level — treat as a workspace
        const diagnosis = diagnoseWorkspace(path.resolve(target), cfg);
        if (fmt === 'json') {
          write(reportWorkspaceJson(diagnosis), opts.output);
        } else if (fmt === 'markdown') {
          write(reportWorkspaceMarkdown(diagnosis), opts.output);
        } else if (fmt === 'sarif') {
          write(reportSarif(diagnosis.files), opts.output);
        } else {
          reportWorkspaceTerminal(diagnosis);
          if (opts.verbose) diagnosis.files.forEach(reportTerminal);
        }
        const belowThreshold = opts.minScore !== undefined && diagnosis.workspaceScore < parseFloat(opts.minScore);
        process.exit(diagnosis.criticalSecurityIssues > 0 || diagnosis.totalErrors > 0 || belowThreshold ? 1 : 0);
      }

      const results = stat.isDirectory()
        ? lintDir(target, cfg)
        : path.basename(target).toUpperCase() === 'SKILL.MD'
          ? lintSkillWithCompanions(target, cfg)
          : [lintFile(target, cfg)];

      emitResults(results, fmt, opts);
      process.exit(hasErrors(results) || failsMinScore(results, opts.minScore) ? 1 : 0);
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

// ── check: lint a skill file, directory, or GitHub URL ────────────────────────
program
  .command('check <path>')
  .description('Lint a SKILL.md file, directory, or GitHub URL (github.com/owner/repo/tree/branch/path)')
  .option('-j, --json', 'JSON output')
  .option('-m, --markdown', 'Markdown output')
  .option('-s, --sarif', 'SARIF output (GitHub code scanning)')
  .option('-o, --output <file>', 'Write output to file')
  .option('-c, --config <file>', 'Config file (.skill-linter.json)')
  .option('--suppress <rules>', 'Comma-separated rule IDs to suppress')
  .option('--min-score <n>', 'Exit 1 if any score is below this threshold (CI quality gate)')
  .action(async (target: string, opts) => {
    const cfg = config(opts);
    const fmt = format(opts);

    let tmpDir: string | undefined;

    try {
      let localTarget = target;
      let displayTarget = target;

      if (isGithubUrl(target)) {
        process.stderr.write(`Fetching ${target} ...\n`);
        const fetched = await fetchGithubSkill(target);
        tmpDir = fetched.tmpDir;
        localTarget = fetched.skillPath;
        displayTarget = target; // keep the GitHub URL as the display name
      }

      const stat = fs.statSync(localTarget);
      // Route SKILL.md files through the skill path so companion scripts get scanned too
      const results = stat.isDirectory()
        ? lintDir(localTarget, cfg)
        : path.basename(localTarget).toUpperCase() === 'SKILL.MD'
          ? lintSkillWithCompanions(localTarget, cfg)
          : [lintFile(localTarget, cfg)];

      // Replace temp path with GitHub URL in output
      if (tmpDir) {
        for (const r of results) {
          r.file = displayTarget;
        }
      }

      if (fmt === 'json') {
        write(results.length === 1 ? reportJson(results[0]) : JSON.stringify(results, null, 2), opts.output);
      } else if (fmt === 'markdown') {
        write(results.map(reportMarkdown).join('\n\n---\n\n'), opts.output);
      } else if (fmt === 'sarif') {
        write(reportSarif(results), opts.output);
      } else {
        results.forEach(reportTerminal);
      }

      process.exit(hasErrors(results) || failsMinScore(results, opts.minScore) ? 1 : 0);
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

// ── agent: lint an agent/instruction file or GitHub URL ───────────────────────
program
  .command('agent <path>')
  .description('Lint an agent instruction file (CLAUDE.md, rules, etc.) or GitHub URL')
  .option('-j, --json', 'JSON output')
  .option('-m, --markdown', 'Markdown output')
  .option('-s, --sarif', 'SARIF output (GitHub code scanning)')
  .option('-o, --output <file>', 'Write output to file')
  .option('-c, --config <file>', 'Config file')
  .option('--suppress <rules>', 'Comma-separated rule IDs to suppress')
  .option('--min-score <n>', 'Exit 1 if the score is below this threshold (CI quality gate)')
  .action(async (target: string, opts) => {
    const cfg = config(opts);
    const fmt = format(opts);

    let tmpDir: string | undefined;

    try {
      let localTarget = target;

      if (isGithubUrl(target)) {
        process.stderr.write(`Fetching ${target} ...\n`);
        const fetched = await fetchGithubAgent(target);
        tmpDir = fetched.tmpDir;
        localTarget = fetched.agentPath;
      }

      const result = lintFile(localTarget, cfg, 'agent');
      if (tmpDir) result.file = target; // show GitHub URL, not temp path

      if (fmt === 'json') {
        write(reportJson(result), opts.output);
      } else if (fmt === 'markdown') {
        write(reportMarkdown(result), opts.output);
      } else if (fmt === 'sarif') {
        write(reportSarif([result]), opts.output);
      } else {
        reportTerminal(result);
      }

      process.exit(hasErrors([result]) || failsMinScore([result], opts.minScore) ? 1 : 0);
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

// ── diagnose: workspace-level scan ───────────────────────────────────────────
program
  .command('diagnose [dir]')
  .description('Diagnose an entire agent workspace (discovers skills, agent files, checks cross-file issues)')
  .option('-j, --json', 'JSON output')
  .option('-m, --markdown', 'Markdown output')
  .option('-s, --sarif', 'SARIF output (GitHub code scanning)')
  .option('-o, --output <file>', 'Write output to file')
  .option('-c, --config <file>', 'Config file')
  .option('--suppress <rules>', 'Comma-separated rule IDs to suppress')
  .option('--min-score <n>', 'Exit 1 if the workspace score is below this threshold')
  .option('-v, --verbose', 'Also print individual file reports')
  .action((dir: string | undefined, opts) => {
    const root = dir ? path.resolve(dir) : process.cwd();
    const cfg = config(opts);
    const fmt = format(opts);

    try {
      const diagnosis = diagnoseWorkspace(root, cfg);

      if (fmt === 'json') {
        write(reportWorkspaceJson(diagnosis), opts.output);
      } else if (fmt === 'markdown') {
        write(reportWorkspaceMarkdown(diagnosis), opts.output);
      } else if (fmt === 'sarif') {
        write(reportSarif(diagnosis.files), opts.output);
      } else {
        reportWorkspaceTerminal(diagnosis);
        if (opts.verbose) diagnosis.files.forEach(reportTerminal);
      }

      const belowThreshold = opts.minScore !== undefined && diagnosis.workspaceScore < parseFloat(opts.minScore);
      process.exit(diagnosis.criticalSecurityIssues > 0 || diagnosis.totalErrors > 0 || belowThreshold ? 1 : 0);
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    }
  });

// ── batch: lint multiple files by glob ───────────────────────────────────────
program
  .command('batch <pattern>')
  .description('Batch lint files matching a glob pattern (e.g. ".claude/skills/**/SKILL.md")')
  .option('-j, --json', 'JSON output (array)')
  .option('-m, --markdown', 'Markdown output')
  .option('-s, --sarif', 'SARIF output (GitHub code scanning)')
  .option('-o, --output <file>', 'Write output to file')
  .option('-c, --config <file>', 'Config file')
  .option('--suppress <rules>', 'Comma-separated rule IDs to suppress')
  .option('--min-score <n>', 'Exit 1 if any score is below this threshold (CI quality gate)')
  .option('--type <type>', 'Force file type: skill | agent')
  .action((pattern: string, opts) => {
    const cfg = config(opts);
    const fmt = format(opts);

    try {
      const files = resolveGlob(pattern);
      if (files.length === 0) {
        process.stderr.write(`No files found matching: ${pattern}\n`);
        process.exit(2);
      }

      const results = files.map(f => lintFile(f, cfg, opts.type as FileType | undefined));

      if (fmt === 'json') {
        write(JSON.stringify(results, null, 2), opts.output);
      } else if (fmt === 'markdown') {
        write(results.map(reportMarkdown).join('\n\n---\n\n'), opts.output);
      } else if (fmt === 'sarif') {
        write(reportSarif(results), opts.output);
      } else {
        results.forEach(reportTerminal);
        reportBatchSummary(results);
      }

      process.exit(hasErrors(results) || failsMinScore(results, opts.minScore) ? 1 : 0);
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    }
  });

// `vibe-check <path>` without a subcommand routes to the auto command
const KNOWN_COMMANDS = new Set(['auto', 'check', 'agent', 'diagnose', 'batch', 'help']);
const firstArg = process.argv[2];
if (firstArg && !firstArg.startsWith('-') && !KNOWN_COMMANDS.has(firstArg)) {
  process.argv.splice(2, 0, 'auto');
}

program.parse();
