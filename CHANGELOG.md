# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/femmefatalerror/vibe-check/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/femmefatalerror/vibe-check/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/femmefatalerror/vibe-check/releases/tag/v0.3.0
