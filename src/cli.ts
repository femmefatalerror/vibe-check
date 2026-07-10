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
import { installSkill } from './install';
import { VERSION } from './version';
import type { Config, LintResult, FileType, WorkspaceDiagnosis } from './types';

function format(opts: { json?: boolean; markdown?: boolean; sarif?: boolean }): 'json' | 'markdown' | 'sarif' | 'terminal' {
  if (opts.sarif) return 'sarif';
  if (opts.json) return 'json';
  if (opts.markdown) return 'markdown';
  return 'terminal';
}

function failsMinScore(results: LintResult[], threshold?: number): boolean {
  if (threshold === undefined) return false;
  return results.some(r => r.score < threshold);
}

function parseMinScore(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const n = parseFloat(value);
  if (Number.isNaN(n)) throw new Error(`Invalid --min-score value: "${value}" (expected a number)`);
  return n;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

// process.exit() drops stdout still buffered in a pipe — large --json reports
// get truncated mid-stream. Queue the exit behind the last stdout write so the
// report flushes first. An explicit exit is only needed after GitHub fetches,
// where fetch's keep-alive sockets would otherwise hold the process open.
function flushAndExit(): void {
  process.stdout.write('', () => process.exit());
}

function emitResults(
  results: LintResult[],
  fmt: 'json' | 'markdown' | 'sarif' | 'terminal',
  opts: { output?: string },
  extra: { arrayJson?: boolean; batchSummary?: boolean } = {}
): void {
  if (fmt === 'json') {
    const single = results.length === 1 && !extra.arrayJson;
    write(single ? reportJson(results[0]) : JSON.stringify(results, null, 2), opts.output);
  } else if (fmt === 'markdown') {
    write(results.map(reportMarkdown).join('\n\n---\n\n'), opts.output);
  } else if (fmt === 'sarif') {
    write(reportSarif(results), opts.output);
  } else {
    results.forEach(reportTerminal);
    if (extra.batchSummary) reportBatchSummary(results);
  }
}

function emitWorkspace(
  diagnosis: WorkspaceDiagnosis,
  fmt: 'json' | 'markdown' | 'sarif' | 'terminal',
  opts: { output?: string; verbose?: boolean }
): void {
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
}

function workspaceExitCode(diagnosis: WorkspaceDiagnosis, minScore?: number): number {
  const belowThreshold = minScore !== undefined && diagnosis.workspaceScore < minScore;
  return diagnosis.criticalSecurityIssues > 0 || diagnosis.totalErrors > 0 || belowThreshold ? 1 : 0;
}

function hasErrors(results: LintResult[]): boolean {
  return results.some(r => r.categories.some(c => c.findings.some(f => f.severity === 'error')));
}

function resolveGlob(pattern: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  function matchWild(name: string, pat: string): boolean {
    // escape regex metacharacters, then translate the glob wildcards * and ?
    const re = new RegExp(
      '^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$'
    );
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
          walk(full, parts);                     // keep ** in play
          if (tail.length > 0) walk(full, tail); // also try without **
        } else if (tail.length === 0 || (tail.length === 1 && matchWild(e.name, tail[0]))) {
          // a trailing ** matches every file; otherwise the last segment must match
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
      const minScore = parseMinScore(opts.minScore);

      if (isGithubUrl(target)) {
        process.stderr.write(`Fetching ${target} ...\n`);
        let results: LintResult[];
        try {
          const fetched = await fetchGithubSkill(target);
          tmpDir = fetched.tmpDir;
          results = lintSkillWithCompanions(fetched.skillPath, cfg);
        } catch (skillErr) {
          try {
            const fetched = await fetchGithubAgent(target);
            tmpDir = fetched.tmpDir;
            results = [lintFile(fetched.agentPath, cfg, 'agent')];
          } catch (agentErr) {
            throw new Error(
              `Could not fetch a skill or agent file from ${target}\n` +
              `  as skill: ${errMsg(skillErr)}\n` +
              `  as agent: ${errMsg(agentErr)}`
            );
          }
        }
        results.forEach(r => { r.file = target; });
        emitResults(results, fmt, opts);
        process.exitCode = hasErrors(results) || failsMinScore(results, minScore) ? 1 : 0;
        return;
      }

      const stat = fs.statSync(target);

      if (stat.isDirectory() && !fs.existsSync(path.join(target, 'SKILL.md'))) {
        // No SKILL.md at the top level — treat as a workspace
        const diagnosis = diagnoseWorkspace(path.resolve(target), cfg);
        emitWorkspace(diagnosis, fmt, opts);
        process.exitCode = workspaceExitCode(diagnosis, minScore);
        return;
      }

      const results = stat.isDirectory()
        ? lintDir(target, cfg)
        : path.basename(target).toUpperCase() === 'SKILL.MD'
          ? lintSkillWithCompanions(target, cfg)
          : [lintFile(target, cfg)];

      emitResults(results, fmt, opts);
      process.exitCode = hasErrors(results) || failsMinScore(results, minScore) ? 1 : 0;
    } catch (e) {
      process.stderr.write(`Error: ${errMsg(e)}\n`);
      process.exitCode = 2;
    } finally {
      // clean up before exiting — process.exit() inside the try would skip this block
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      flushAndExit();
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
      const minScore = parseMinScore(opts.minScore);
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

      emitResults(results, fmt, opts);

      process.exitCode = hasErrors(results) || failsMinScore(results, minScore) ? 1 : 0;
    } catch (e) {
      process.stderr.write(`Error: ${errMsg(e)}\n`);
      process.exitCode = 2;
    } finally {
      // clean up before exiting — process.exit() inside the try would skip this block
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      flushAndExit();
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
      const minScore = parseMinScore(opts.minScore);
      let localTarget = target;

      if (isGithubUrl(target)) {
        process.stderr.write(`Fetching ${target} ...\n`);
        const fetched = await fetchGithubAgent(target);
        tmpDir = fetched.tmpDir;
        localTarget = fetched.agentPath;
      }

      const result = lintFile(localTarget, cfg, 'agent');
      if (tmpDir) result.file = target; // show GitHub URL, not temp path

      emitResults([result], fmt, opts);

      process.exitCode = hasErrors([result]) || failsMinScore([result], minScore) ? 1 : 0;
    } catch (e) {
      process.stderr.write(`Error: ${errMsg(e)}\n`);
      process.exitCode = 2;
    } finally {
      // clean up before exiting — process.exit() inside the try would skip this block
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      flushAndExit();
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
      const minScore = parseMinScore(opts.minScore);
      const diagnosis = diagnoseWorkspace(root, cfg);
      emitWorkspace(diagnosis, fmt, opts);
      process.exitCode = workspaceExitCode(diagnosis, minScore);
    } catch (e) {
      process.stderr.write(`Error: ${errMsg(e)}\n`);
      process.exitCode = 2;
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
      const minScore = parseMinScore(opts.minScore);
      const files = resolveGlob(pattern);
      if (files.length === 0) {
        process.stderr.write(`No files found matching: ${pattern}\n`);
        process.exitCode = 2;
        return;
      }

      const results = files.map(f => lintFile(f, cfg, opts.type as FileType | undefined));

      emitResults(results, fmt, opts, { arrayJson: true, batchSummary: true });

      process.exitCode = hasErrors(results) || failsMinScore(results, minScore) ? 1 : 0;
    } catch (e) {
      process.stderr.write(`Error: ${errMsg(e)}\n`);
      process.exitCode = 2;
    }
  });

// ── install-skill: copy the bundled Claude skill into .claude/skills ─────────
program
  .command('install-skill')
  .description('Install the vibe-check agent skill (lint → fix → verify workflow) for a coding harness')
  .option('-t, --target <harness>', 'claude | opencode | copilot | agents (cross-client dir read by Copilot, Cursor, OpenCode, Codex, Gemini, Windsurf)', 'claude')
  .option('-p, --project', "Install into the current project instead of the user-level skills dir")
  .option('-f, --force', 'Overwrite an existing installation')
  .action((opts) => {
    try {
      const { dest, files } = installSkill({ target: opts.target, project: opts.project, force: opts.force });
      process.stdout.write(`Installed vibe-check skill to ${dest}\n`);
      for (const f of files) process.stdout.write(`  ${f}\n`);
      process.stdout.write(`\nAsk your agent to "vibe check my skills" to use it.\n`);
    } catch (e) {
      process.stderr.write(`Error: ${errMsg(e)}\n`);
      process.exitCode = 2;
    }
  });

// `vibe-check <path>` without a subcommand routes to the auto command
const KNOWN_COMMANDS = new Set(['auto', 'check', 'agent', 'diagnose', 'batch', 'install-skill', 'help']);
const firstArg = process.argv[2];
if (firstArg && !firstArg.startsWith('-') && !KNOWN_COMMANDS.has(firstArg)) {
  process.argv.splice(2, 0, 'auto');
}

program.parse();
