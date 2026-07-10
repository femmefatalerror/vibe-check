import * as path from 'path';
import type { CategoryResult, Finding } from '../types';
import {
  DANGEROUS_COMMANDS, EXFILTRATION_PATTERNS, PLACEHOLDER_RE,
  SECRET_PATTERNS, SENSITIVE_PATHS,
} from './security';
import type { Pattern } from './security';

// Harness config files carry executable surface the markdown rules never see:
// MCP server launch commands, hook commands that run on agent events, and
// permission grants that disable approval prompts. All of it ships with the
// repo and runs on the machine of whoever clones it.

type ConfigKind = 'claude-settings' | 'mcp-servers' | 'opencode';

// Workspace-relative paths probed during discovery (per supported harness)
export const CONFIG_FILE_CANDIDATES = [
  '.mcp.json',                    // Claude Code project MCP servers
  path.join('.claude', 'settings.json'),
  path.join('.claude', 'settings.local.json'),
  'opencode.json',                // OpenCode project config (MCP + permissions)
  'opencode.jsonc',
  path.join('.vscode', 'mcp.json'),          // Copilot / VS Code MCP servers
  path.join('.copilot', 'mcp-config.json'),  // Copilot CLI MCP servers
];

export function isConfigFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  const parent = path.basename(path.dirname(filePath)).toLowerCase();
  if (base === '.mcp.json') return true;
  if (base === 'opencode.json' || base === 'opencode.jsonc') return true;
  if (parent === '.claude' && (base === 'settings.json' || base === 'settings.local.json')) return true;
  if (parent === '.vscode' && base === 'mcp.json') return true;
  if (parent === '.copilot' && base === 'mcp-config.json') return true;
  return false;
}

function detectKind(filePath: string): ConfigKind {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'settings.json' || base === 'settings.local.json') return 'claude-settings';
  if (base === 'opencode.json' || base === 'opencode.jsonc') return 'opencode';
  return 'mcp-servers';
}

// Blank out comments so JSONC (opencode.jsonc, .vscode/mcp.json) parses as
// JSON. Replacements preserve offsets, so reported line numbers stay honest.
function stripJsonc(text: string): string {
  let out = '';
  let inStr = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { inLine = c !== '\n'; out += inLine ? ' ' : c; continue; }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; out += '  '; i++; }
      else out += c === '\n' ? c : ' ';
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; }
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; out += '  '; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; out += '  '; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, ' $1'); // trailing commas
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// 1-based line of the first occurrence of `needle` — best effort, for jumping
// to the finding in an editor
function lineOf(raw: string, needle: string): number | undefined {
  const idx = raw.indexOf(needle);
  return idx === -1 ? undefined : raw.slice(0, idx).split('\n').length;
}

interface Ctx {
  raw: string;
  findings: Finding[];
}

function scanCommandString(ctx: Ctx, command: string, where: string, suggestion: string): void {
  const push = (p: Pattern, severity: Finding['severity'], prefix: string) => {
    ctx.findings.push({
      ruleId: p.ruleId,
      severity,
      message: `${prefix} in ${where}: ${p.description}`,
      line: lineOf(ctx.raw, command.slice(0, 60)),
      suggestion,
    });
  };
  for (const p of DANGEROUS_COMMANDS) if (p.pattern.test(command)) push(p, 'error', 'Dangerous command');
  for (const p of SECRET_PATTERNS) {
    const m = command.match(p.pattern);
    if (m && !PLACEHOLDER_RE.test(m[0])) push(p, 'error', 'Hardcoded secret');
  }
  for (const p of SENSITIVE_PATHS) if (p.pattern.test(command)) push(p, 'warn', 'Sensitive path access');
  for (const p of EXFILTRATION_PATTERNS) if (p.pattern.test(command)) push(p, 'warn', 'Possible exfiltration');
}

const CREDENTIAL_KEY_RE = /token|secret|passw|api[-_]?key|auth|credential/i;

// Values that reference the environment instead of embedding the credential:
// ${VAR} / ${env:VAR} / ${input:id} expansion, or an obvious placeholder
function isIndirectValue(value: string): boolean {
  return value.includes('${') || PLACEHOLDER_RE.test(value);
}

function scanEnvMap(ctx: Ctx, env: Record<string, unknown>, where: string): void {
  for (const [key, v] of Object.entries(env)) {
    if (typeof v !== 'string' || isIndirectValue(v)) continue;

    let matched = false;
    for (const p of SECRET_PATTERNS) {
      const m = v.match(p.pattern);
      if (m && !PLACEHOLDER_RE.test(m[0])) {
        matched = true;
        ctx.findings.push({
          ruleId: p.ruleId,
          severity: 'error',
          message: `Hardcoded secret in ${where} ("${key}"): ${p.description}`,
          line: lineOf(ctx.raw, `"${key}"`),
          suggestion: 'Reference the credential via environment expansion (e.g. ${' + key + '}) instead of committing it',
        });
      }
    }

    if (!matched && CREDENTIAL_KEY_RE.test(key) && v.length >= 8) {
      ctx.findings.push({
        ruleId: 'security/config/credential-value',
        severity: 'warn',
        message: `"${key}" in ${where} holds a literal value — a committed config is a public place for a credential`,
        line: lineOf(ctx.raw, `"${key}"`),
        suggestion: 'Use environment expansion (${VAR}) or the harness\'s secret input mechanism instead of the raw value',
      });
    }
  }
}

// Package runners that resolve a package at launch time — an unpinned package
// means every start pulls whatever "latest" is (supply-chain drift)
const RUNNER_COMMANDS = new Set(['npx', 'uvx', 'bunx', 'pipx']);

function checkUnpinnedRunner(ctx: Ctx, parts: string[], serverName: string): void {
  if (parts.length === 0 || !RUNNER_COMMANDS.has(path.basename(parts[0]))) return;
  const pkg = parts.slice(1).find(a => a !== '' && !a.startsWith('-'));
  if (!pkg) return;
  // `@scope/name@1.2.3` — a version pin is an @ past the first character
  if (pkg.lastIndexOf('@') > 0) return;
  ctx.findings.push({
    ruleId: 'security/mcp/unpinned-package',
    severity: 'info',
    message: `MCP server "${serverName}" runs ${pkg} via ${path.basename(parts[0])} without a version pin — every launch resolves to latest`,
    line: lineOf(ctx.raw, `"${serverName}"`),
    suggestion: `Pin it: ${pkg}@<version>`,
  });
}

const LOCALHOST_URL_RE = /^http:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

function scanMcpServer(ctx: Ctx, name: string, entry: Record<string, unknown>): void {
  const where = `MCP server "${name}"`;

  // command may be a string ("command" + "args") or an array (OpenCode)
  const parts: string[] = [];
  if (typeof entry['command'] === 'string') parts.push(entry['command']);
  else if (Array.isArray(entry['command'])) parts.push(...entry['command'].filter((a): a is string => typeof a === 'string'));
  if (Array.isArray(entry['args'])) parts.push(...entry['args'].filter((a): a is string => typeof a === 'string'));

  if (parts.length > 0) {
    scanCommandString(ctx, parts.join(' '), where,
      'MCP server commands run on the machine of everyone who uses this workspace — audit before committing');
    checkUnpinnedRunner(ctx, parts, name);
  }

  const url = entry['url'] ?? entry['serverUrl'];
  if (typeof url === 'string' && url.startsWith('http://') && !LOCALHOST_URL_RE.test(url)) {
    ctx.findings.push({
      ruleId: 'security/mcp/insecure-url',
      severity: 'error',
      message: `${where} uses plain http (${url}) — tool traffic and auth headers cross the network unencrypted`,
      line: lineOf(ctx.raw, url),
      suggestion: 'Use https, or bind the server to localhost',
    });
  }

  for (const key of ['env', 'environment', 'headers'] as const) {
    if (isRecord(entry[key])) scanEnvMap(ctx, entry[key] as Record<string, unknown>, where);
  }

  if (parts.length === 0 && typeof url !== 'string') {
    ctx.findings.push({
      ruleId: 'config/structure/empty-server',
      severity: 'warn',
      message: `${where} declares neither a command nor a url — it can never start`,
      line: lineOf(ctx.raw, `"${name}"`),
      suggestion: 'Add a command (stdio server) or url (remote server), or remove the entry',
    });
  }
}

function scanMcpServers(ctx: Ctx, obj: Record<string, unknown>): void {
  // .mcp.json / mcp-config.json use "mcpServers", .vscode/mcp.json uses
  // "servers", opencode.json uses "mcp" — accept any that are present
  for (const key of ['mcpServers', 'servers', 'mcp']) {
    const servers = obj[key];
    if (!isRecord(servers)) continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (isRecord(entry)) scanMcpServer(ctx, name, entry);
    }
  }
}

// Collect every "command" string anywhere under the hooks tree — the exact
// nesting (event → matcher groups → hook entries) doesn't matter for scanning
function collectCommands(node: unknown, out: string[]): void {
  if (Array.isArray(node)) { for (const n of node) collectCommands(n, out); return; }
  if (!isRecord(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'command' && typeof v === 'string') out.push(v);
    else collectCommands(v, out);
  }
}

const BROAD_BASH_ALLOW_RE = /^Bash(\(\*(:\*)?\))?$/;

function scanClaudeSettings(ctx: Ctx, obj: Record<string, unknown>): void {
  if (isRecord(obj['hooks'])) {
    const commands: string[] = [];
    collectCommands(obj['hooks'], commands);
    for (const cmd of commands) {
      scanCommandString(ctx, cmd, 'hook command',
        'Hooks run automatically on agent events — audit every command before committing');
    }
    if (commands.length > 0) {
      ctx.findings.push({
        ruleId: 'security/hooks/auto-exec',
        severity: 'info',
        message: `Settings define ${commands.length} hook command(s) that run automatically on agent events`,
        line: lineOf(ctx.raw, '"hooks"'),
        suggestion: 'Fine if intentional — anyone using this workspace executes these; keep them reviewed',
      });
    }
  }

  const permissions = obj['permissions'];
  if (isRecord(permissions)) {
    if (permissions['defaultMode'] === 'bypassPermissions') {
      ctx.findings.push({
        ruleId: 'security/permissions/bypass-mode',
        severity: 'error',
        message: 'defaultMode "bypassPermissions" disables every approval prompt for everyone using this workspace',
        line: lineOf(ctx.raw, 'bypassPermissions'),
        suggestion: 'Remove it from shared settings; use targeted permissions.allow entries instead',
      });
    }

    const allow = permissions['allow'];
    if (Array.isArray(allow)) {
      for (const entry of allow) {
        if (typeof entry !== 'string') continue;
        if (BROAD_BASH_ALLOW_RE.test(entry)) {
          ctx.findings.push({
            ruleId: 'security/permissions/broad-allow',
            severity: 'warn',
            message: `permissions.allow "${entry}" auto-approves every shell command`,
            line: lineOf(ctx.raw, `"${entry}"`),
            suggestion: 'Allow specific commands instead, e.g. "Bash(npm test:*)"',
          });
        } else if (entry.startsWith('Bash(')) {
          const inner = entry.slice(5, -1);
          for (const p of DANGEROUS_COMMANDS) {
            if (p.pattern.test(inner)) {
              ctx.findings.push({
                ruleId: 'security/permissions/dangerous-allow',
                severity: 'warn',
                message: `permissions.allow "${entry}" auto-approves a dangerous command: ${p.description}`,
                line: lineOf(ctx.raw, `"${entry}"`),
                suggestion: 'Remove the allow rule — this command should always require explicit approval',
              });
            }
          }
        }
      }
    }
  }

  if (obj['enableAllProjectMcpServers'] === true) {
    ctx.findings.push({
      ruleId: 'security/settings/auto-approve-mcp',
      severity: 'warn',
      message: 'enableAllProjectMcpServers auto-approves every MCP server in .mcp.json — including ones added later',
      line: lineOf(ctx.raw, 'enableAllProjectMcpServers'),
      suggestion: 'Approve servers individually with enabledMcpjsonServers',
    });
  }

  if (typeof obj['apiKeyHelper'] === 'string') {
    scanCommandString(ctx, obj['apiKeyHelper'], 'apiKeyHelper command',
      'The apiKeyHelper runs automatically to mint credentials — audit it carefully');
  }

  if (isRecord(obj['env'])) scanEnvMap(ctx, obj['env'] as Record<string, unknown>, 'settings env');
}

function scanOpencodePermissions(ctx: Ctx, obj: Record<string, unknown>): void {
  const permission = obj['permission'];
  if (!isRecord(permission)) return;
  const bash = permission['bash'];
  const blanket =
    bash === 'allow' ||
    (isRecord(bash) && (bash['*'] === 'allow' || bash['**'] === 'allow'));
  if (blanket) {
    ctx.findings.push({
      ruleId: 'security/permissions/broad-allow',
      severity: 'warn',
      message: 'permission.bash "allow" auto-approves every shell command',
      line: lineOf(ctx.raw, '"bash"'),
      suggestion: 'Use per-pattern rules, e.g. { "git *": "allow" }, and keep the default at "ask"',
    });
  }
}

// Lint a harness config file. Returns the category results that the linter
// wraps into a LintResult — security findings here trigger the same score cap
// as security findings in markdown.
export function lintConfigContent(filePath: string, raw: string): CategoryResult[] {
  const ctx: Ctx = { raw, findings: [] };
  const structure: Finding[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(stripJsonc(raw));
    } catch (e) {
      structure.push({
        ruleId: 'config/structure/invalid-json',
        severity: 'error',
        message: `Not valid JSON (or JSONC): ${e instanceof Error ? e.message : String(e)}`,
        suggestion: 'The harness will ignore or reject this file — and it cannot be security-scanned until it parses',
      });
      parsed = undefined;
    }
  }

  if (isRecord(parsed)) {
    const kind = detectKind(filePath);
    scanMcpServers(ctx, parsed);
    if (kind === 'claude-settings') scanClaudeSettings(ctx, parsed);
    if (kind === 'opencode') scanOpencodePermissions(ctx, parsed);
  }

  return [
    { id: 'security', name: 'Security', weight: 0.75, score: 0, findings: ctx.findings },
    { id: 'structure', name: 'Structure', weight: 0.25, score: 0, findings: structure },
  ];
}
