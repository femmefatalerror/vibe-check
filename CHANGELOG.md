# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-07-10

### Added
- Harness config files are security-scanned as a new `config` file type — Claude Code (`.mcp.json`, `.claude/settings.json` and `settings.local.json`), OpenCode (`opencode.json` / `opencode.jsonc`), and Copilot (`.vscode/mcp.json`, `.copilot/mcp-config.json`). They are discovered in workspace scans, lintable directly with `vibe-check check <file>`, and JSONC (comments, trailing commas) parses
- MCP server checks: launch commands run through the dangerous-command/secret/exfiltration patterns, hardcoded credentials in `env`/`environment`/`headers` (error for recognized token formats, warning for literal values under credential-named keys — `${VAR}` expansion is the fix and stays clean), remote servers over plain `http://` (`security/mcp/insecure-url`), unpinned `npx`/`uvx`/`bunx` packages (`security/mcp/unpinned-package`, info), and servers with neither command nor url
- Claude settings checks: hook commands are scanned like companion scripts (hooks run automatically on agent events; their presence is surfaced as `security/hooks/auto-exec` info), `defaultMode: "bypassPermissions"` is an error, blanket `Bash(*)` allow rules and allow rules that auto-approve dangerous commands are warnings, plus `enableAllProjectMcpServers` and the `apiKeyHelper` command
- OpenCode permission checks: a blanket `"bash": "allow"` is flagged like a `Bash(*)` allow rule
- A security error in a config file caps its score at 59 (Grade F) like any other file; config JSON does not count against the workspace context-token budget
- Cross-skill invocation transparency: a new `skill/routing/invokes-skill` info finding lists the skills a `SKILL.md` invokes by slash-command name (e.g. `` `/grilling` ``), so the dependency is visible even when the skill is linted on its own — it fires regardless of `disable-model-invocation`. System paths (`/tmp`), Claude Code built-ins (`/compact`), file paths, and fenced code are excluded
- Workspace diagnosis resolves those invocations against discovered skills and reports **unresolved skill invocations** — a skill invoking a `/name` that no skill in the workspace provides (dangling reference), with a light score penalty

### Changed
- Any `security/*` error now caps the score at 59 (Grade F), for the file itself and for findings surfaced from companion files or config scans. Previously the weighted average let a skill with e.g. a live credential still score an A while the verdict said it failed

### Fixed
- Frontmatter that parses to a scalar or list (e.g. `---` around a plain sentence) is reported as `skill/meta/invalid-yaml` instead of crashing the linter — previously one such file aborted an entire `diagnose`/`batch` run with a `TypeError`
- Workspace discovery no longer misclassifies companion markdown in subdirectories below a `SKILL.md` (`references/`, `examples/`, …) as standalone flat-layout skills; the check now looks at ancestor directories, not just siblings
- Large `--json`/`--sarif` reports piped to a slow consumer (e.g. `| jq`) are no longer truncated: sync commands exit naturally via `process.exitCode`, and commands that fetch from GitHub flush stdout before exiting
- An invalid severity value in a config file (anything other than `error`, `warn`, `info`) no longer poisons the score to `NaN`; it is dropped with a warning, and the scorer treats unknown severities as errors as a last resort
- `security/commands/rm-rf-root` now flags bare `rm -rf /` (root with no trailing path), not just `rm -rf /<path>`

## [0.5.0] - 2026-07-07

### Added
- Bundled agent skill (`vibe-check install-skill`, installs globally; `--project` for a repo-local install): runs the linter, applies per-rule fix recipes (routing, structure, content, token optimization), triages security findings without auto-fixing them, and re-runs to verify the score improved; the skill passes its own linter at 100/100, enforced in CI
- `install-skill --target <harness>` installs the skill for other harnesses: `opencode` (`~/.config/opencode/skills`), `copilot` (`~/.copilot/skills`), or `agents` (the cross-client `.agents/skills` dir read by Copilot, Cursor, OpenCode, Codex, Gemini, and Windsurf); default remains `claude`
- APM (Microsoft Agent Package Manager) repos are supported in workspace scanning: the `.apm/` source tree is discovered (`skills/`, `agents/`, `instructions/`), `*.agent.md` files are recognized as agents, and `apm_modules/` dependencies are skipped
- Deployed APM copies under `.claude/skills/`, `.agents/skills/`, and `.kiro/skills/` are skipped when the `.apm/` source tree is present (the source is linted instead); consumer repos without `.apm/` get their installed `.agents/`/`.kiro` skills scanned

- OpenCode and Copilot harness files are linted: `.opencode/` (agent definitions in `agent/`, skills), `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `.github/agents/*.agent.md`, and `.github/skills/` are discovered in workspace scans; `copilot-instructions.md` and `*.instructions.md` are detected as agent files when linted directly
- Claude Code subagents in `.claude/agents/*.md` are discovered as agent files
- Harness-specific frontmatter validation for agent files, keyed off the file's path/suffix: Claude Code subagents (`name` + `description` required, name format), OpenCode agents (`description` required, `mode` enum, `temperature` range, deprecated `tools` field), Copilot custom agents (`description` required, `target` enum), and Copilot `*.instructions.md` (`applyTo` glob expected); new rules under `agent/meta/*`

### Changed
- Routing & Discovery checks (trigger condition, voice, description vagueness) are skipped for skills with `disable-model-invocation: true`, since Claude never routes to them by description

## [0.4.3] - 2026-07-05

### Added
- Companion markdown referenced from `SKILL.md` (directly or transitively) is now security-scanned like the skill itself, since Claude reads it into context; findings are attributed to the companion file
- New `security/companion/unreferenced-file` warning: markdown or scripts shipped in a skill directory but never referenced from `SKILL.md` (conventional docs like `README.md` are exempt)

### Fixed
- Workspace discovery matches `skills/`, `rules/`, and `instructions/` directories relative to the workspace root, so a repo checked out at e.g. `~/dev/skills` no longer treats every markdown file as a skill
- Repo docs (`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, ...) and companion references next to a `SKILL.md` inside a skills tree are no longer linted as skills

## [0.4.2] - 2026-07-05

### Changed
- package.json `homepage` now points at the documentation site (https://femmefatalerror.github.io/vibe-check/) instead of the GitHub README

## [0.4.1] - 2026-07-05

### Fixed
- Long pure-hex strings (sha256/sha512 checksums, git object IDs) are no longer flagged as suspicious base64 blobs
- Removed a dead `e.g.` alternative from the defensive-context regex (it could never match)

### Changed
- Workspace diagnosis parses each file once instead of twice (internal refactor, same results)
- CLI output-format dispatch consolidated into shared helpers (no behavior change)

## [0.4.0] - 2026-07-05

### Added
- `AGENTS.md` (and `agents.md`) recognized as agent files in type detection, directory linting, and workspace discovery
- GitHub tree URLs now fetch one level of subdirectories, so companion scripts (`scripts/*.sh` etc.) are security-scanned like local ones
- New `security/injection/override-defensive` rule: override phrases with defensive framing are downgraded (info in agent files, warn in skills) instead of silently exempted
- Batch glob patterns support `?`, literal regex metacharacters, and a trailing `**`

### Fixed
- Temp directories from GitHub fetches are now cleaned up on success (previously leaked one per lint)
- Blank lines inside frontmatter no longer shift body-rule line numbers or leak the closing `---` into the body
- Non-numeric `--min-score` values now error (exit 2) instead of silently passing the gate
- Workspaces with no lintable files now error (exit 2) instead of reporting Score 0 / Grade F with exit 0
- Bare GitHub repo URLs use the repository's default branch instead of assuming `main`
- Placeholder markers (`placeholder`, `example.com`, ...) only exempt a secret finding when they appear inside the matched text itself, and never exempt dangerous-command, sensitive-path, or exfiltration findings
- Suspicious HTML comments with defensive wording are reported at info severity instead of skipped

### Changed
- Published as `@femmefatalerror/vibe-check` (npm blocks the unscoped name as too similar to the existing `vibecheck` package); the CLI command is still `vibe-check`
- CLI `--version` and the GitHub User-Agent now read from package.json (single source of truth)

## [0.3.0] - 2026-07-04

Initial release: linter and security scanner for Claude skills, agents, and AI
workspaces — skill/agent lint rules, workspace diagnosis, injection scanning,
GitHub URL analysis, SARIF output, and configurable rule suppression.

[0.7.0]: https://github.com/femmefatalerror/vibe-check/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/femmefatalerror/vibe-check/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/femmefatalerror/vibe-check/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/femmefatalerror/vibe-check/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/femmefatalerror/vibe-check/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/femmefatalerror/vibe-check/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/femmefatalerror/vibe-check/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/femmefatalerror/vibe-check/releases/tag/v0.3.0
