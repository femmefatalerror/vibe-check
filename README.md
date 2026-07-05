# vibe-check ✨

> You vibe-coded your agents. Time for a vibe check.

A linter and security scanner for Claude skills, agents, and AI workspaces. Checks SKILL.md files, agent instruction files (CLAUDE.md, AGENTS.md, rules), and entire agent workspaces against Anthropic's documented best practices — including prompt-injection payloads, hidden-unicode smuggling, leaked secrets, and token bloat.

```
$ vibe-check .

  Score   58.3 / 100    Grade  F
  ✗ hardcoded AWS key
  ✗ hidden instruction in HTML comment

  ❌ Failed the vibe check.
```

Inspired by [skillscore](https://github.com/joeynyc/skillscore) and [agentlinter](https://github.com/seojoonkim/agentlinter). Extends both with agent file support, workspace diagnosis, injection scanning, GitHub URL analysis, SARIF output, and configurable rule suppression.

## Installation

```bash
npm install -g @femmefatalerror/vibe-check
```

Or from source:

```bash
git clone https://github.com/femmefatalerror/vibe-check.git
cd vibe-check
npm install
npm run build
npm install -g .
```

Either way, the command is `vibe-check`. Requires Node ≥ 18.

## Usage

### Just point it at something

`vibe-check <path>` figures out what it's looking at:

```bash
vibe-check skills/my-skill/    # skill directory → skill lint (+ companion scripts)
vibe-check CLAUDE.md           # agent file → agent lint
vibe-check .                   # plain directory → full workspace diagnosis
vibe-check https://github.com/owner/repo/tree/main/skills/my-skill
```

Or be explicit with the subcommands below.

### Lint a skill

```bash
vibe-check check path/to/SKILL.md
vibe-check check path/to/skill-dir/       # finds SKILL.md inside
```

### Lint an agent file

```bash
vibe-check agent CLAUDE.md
vibe-check agent .claude/rules/my-rules.md
```

### Diagnose a workspace

Discovers all skills and agent files under a directory, checks cross-file issues (broken references, token budget), and aggregates scores.

```bash
vibe-check diagnose                # current directory
vibe-check diagnose ~/my-project
vibe-check diagnose --verbose      # also print per-file findings
```

### Batch lint

```bash
vibe-check batch ".claude/skills/**/SKILL.md"
vibe-check batch "**/*.md" --type agent
```

### Analyze from GitHub

Supports `tree/` URLs (directory), `blob/` URLs (specific file), or bare repo URLs.

```bash
# Skills
vibe-check check https://github.com/owner/repo/tree/main/skills/my-skill
vibe-check check https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md

# Agent files
vibe-check agent https://github.com/owner/repo/blob/main/CLAUDE.md
vibe-check agent https://github.com/owner/repo/tree/main   # finds CLAUDE.md / AGENTS.md
```

For private repos or to avoid rate limits:

```bash
export GITHUB_TOKEN=ghp_...
```

### Output formats

```bash
vibe-check check my-skill/   --json
vibe-check check my-skill/   --markdown
vibe-check check my-skill/   --sarif    --output results.sarif   # GitHub code scanning
vibe-check diagnose          --json     --output report.json
vibe-check diagnose          --markdown --output report.md
```

### CI quality gate

```bash
vibe-check check my-skill/ --min-score 80    # exit 1 if score < 80
vibe-check diagnose --min-score 85           # gate on workspace score
```

SARIF output plugs into GitHub code scanning so findings appear as PR annotations:

```yaml
- run: vibe-check batch ".claude/skills/**/SKILL.md" --sarif -o results.sarif
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: results.sarif }
```

## Example output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  my-skill/SKILL.md
  type: skill
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Score   79.8 / 100    Grade  C+

  Identity & Metadata      ███████░░░   7.0/10
  Routing & Discovery      ███████░░░   7.0/10
  Structure                ██████████  10.0/10
  Content Quality          ███████░░░   6.5/10
  Robustness               ██████████  10.0/10
  Security                 ███████░░░   7.0/10
  Portability              ██████████  10.0/10

  Tokens (est.)  ~154  grade A
  ⚠ 3 filler phrase(s) — wasted tokens

  Findings

  ✗ [ERROR] skill/meta/name-format :2
      name "Claude Helper Tools" must contain only lowercase letters, numbers, and hyphens
      → Try: claude-helper-tools

  ✗ [ERROR] security/secrets/hardcoded-api-key :21
      Possible hardcoded secret: Hardcoded API key
      → Use a placeholder like <YOUR_API_KEY> in docs; never commit real credentials

  ⚠ [WARN]  skill/routing/no-trigger
      Description lacks a trigger condition — Claude uses this to decide when to invoke the skill
      → Append: "Use when working with X or when the user mentions Y."
```

## What it checks

### Skills (`check`) — 7 categories

| Category | Weight | What it checks |
|---|---|---|
| **Identity & Metadata** | 20% | YAML frontmatter presence, `name` format (lowercase/hyphens/max 64 chars), reserved words (`anthropic`, `claude`), `description` length and XML tag rules |
| **Routing & Discovery** | 15% | Third-person voice, trigger condition ("Use when…"), description length and specificity |
| **Structure** | 15% | Body under 500 lines, H2 sections, forward-slash paths, reference depth (one level from SKILL.md) |
| **Content Quality** | 15% | Time-sensitive dates, filler phrases, unqualified MCP tool names, too many alternatives without a default |
| **Robustness** | 10% | Error handling in code examples, magic numbers without comments, dependency documentation |
| **Security** | 15% | Hardcoded secrets (11 vendor patterns), dangerous shell commands, sensitive path access, exfiltration patterns, prompt injection payloads |
| **Portability** | 10% | Hardcoded absolute home paths |

When checking a skill directory (or a `SKILL.md` file), **companion scripts** (`scripts/*.sh`, `*.py`, `*.js`, …) are scanned with the same security patterns — they execute with the user's permissions when the skill runs. Findings are attributed to the script file in the report.

### Agent files (`agent`) — 6 categories

| Category | Weight | What it checks |
|---|---|---|
| **Identity & Purpose** | 20% | H1 title, role/purpose statement near the top |
| **Instructions** | 20% | Filler phrases (wasted always-in-context tokens), time-sensitive dates, tool documentation |
| **Boundaries & Safety** | 20% | NEVER/DO NOT constraints (≥ 2), stopping conditions or iteration limits |
| **Token Efficiency** | 15% | File size (~tokens always loaded into context), sparse content |
| **Security** | 15% | Same secret/command/path scanning as skills, plus prompt injection defense check |
| **Structure** | 10% | H2 sections for scannability |

### Workspace (`diagnose`) — cross-file checks

- **Broken references** — every relative `[link](path)` in every file checked for existence
- **Routing conflicts** — skills with duplicate names or near-identical descriptions compete for the same triggers; Claude's choice between them becomes arbitrary
- **Token budget** — total agent file tokens (always loaded); warns when agent context exceeds ~8 000 tokens
- **Security rollup** — critical findings surfaced at workspace level
- **Score penalty** — broken refs and routing conflicts deducted from workspace score

## Scoring

Each category scores 0–10 based on finding severity:

| Severity | Deduction |
|---|---|
| `error` | −3 pts |
| `warn` | −1.5 pts |
| `info` | −0.5 pts |

The weighted average across categories gives a 0–100 score. Grades: A+ (≥ 97) → A → A- → B+ → B → B- → C+ → C → C- → D+ → D → D- → F (< 60).

Exit code is `1` when any errors are found, `0` otherwise — usable in CI.

## Token estimation

Token counts are estimated as `ceil(bytes / 4)`, a standard BPE approximation for English and code. Grades:

| Grade | Tokens |
|---|---|
| A | ≤ 250 |
| B | ≤ 800 |
| C | ≤ 2 500 |
| D | > 2 500 |

Agent files are always loaded into context; skills are loaded on demand. The workspace report shows both totals separately.

## Configuration

Create `.vibe-check.json` in your project root (also accepted: `.skill-linter.json`, `.agentlinter.json`, `.claude/linter.json`):

```json
{
  "suppress": [
    "skill/content/no-code-examples",
    "agent/boundaries/no-stopping-condition"
  ],
  "severity": {
    "skill/content/filler-phrase": "warn",
    "agent/instructions/time-sensitive": "error"
  }
}
```

Or pass rules inline:

```bash
vibe-check check my-skill/ --suppress "skill/robustness/no-error-handling,skill/content/magic-number"
```

### Inline suppression

Suppress a rule directly in the file, like eslint:

```markdown
<!-- lint-disable-next-line security/secrets/hardcoded-api-key -->
api_key = "sk-example-for-docs-only"

<!-- lint-disable skill/content/filler-phrase, skill/robustness/magic-number -->
```

`lint-disable-next-line` applies to the following line; `lint-disable` applies to the whole file. Multiple rule IDs can be comma-separated.

## Rule reference

All rule IDs follow the pattern `<type>/<category>/<name>`.

### Skill rules

| Rule | Severity | Description |
|---|---|---|
| `skill/meta/no-frontmatter` | error | Missing YAML frontmatter block |
| `skill/meta/invalid-yaml` | error | Frontmatter fails YAML parse |
| `skill/meta/missing-name` | error | `name` field absent |
| `skill/meta/name-format` | error | `name` contains uppercase or non-hyphen characters |
| `skill/meta/name-too-long` | error | `name` exceeds 64 characters |
| `skill/meta/name-xml-tags` | error | `name` contains XML tags |
| `skill/meta/name-reserved-word` | error | `name` contains "anthropic" or "claude" |
| `skill/meta/name-vague` | warn | `name` is too generic (helper, utils, tools…) |
| `skill/meta/missing-description` | error | `description` field absent or empty |
| `skill/meta/description-too-long` | error | `description` exceeds 1 024 characters |
| `skill/meta/description-xml-tags` | error | `description` contains XML tags |
| `skill/routing/first-person` | warn | Description uses "I can / I will" — must be third-person |
| `skill/routing/second-person` | warn | Description uses "you can / you should" |
| `skill/routing/no-trigger` | warn | Description has no "Use when…" trigger condition |
| `skill/routing/description-too-short` | warn | Description under 20 characters |
| `skill/routing/vague-description` | warn | Description contains generic phrases like "does stuff" |
| `skill/structure/body-too-long` | warn | Body exceeds 500 lines |
| `skill/structure/no-sections` | info | No H2 headings found |
| `skill/structure/windows-paths` | warn | Backslash path detected |
| `skill/structure/deep-reference` | info | Linked file is more than one directory deep |
| `skill/structure/dominant-section` | info | One section holds ≥ 40% of body tokens — move to a reference file (progressive disclosure) |
| `skill/content/time-sensitive` | warn | Date reference that will become stale |
| `skill/content/filler-phrase` | info | Filler phrase wasting context tokens |
| `skill/content/duplicate-content` | info | Prose line duplicated verbatim — wasted tokens |
| `skill/content/mcp-unqualified-tool` | info | MCP tool reference missing `ServerName:` prefix |
| `skill/content/too-many-options` | info | ≥ 3 alternatives offered without a default |
| `skill/content/no-code-examples` | warn | Code-related skill with no fenced code blocks |
| `skill/robustness/no-error-handling` | info | Multiple code blocks with no error handling pattern |
| `skill/robustness/magic-number` | info | Undocumented numeric constant in code |
| `skill/robustness/no-dependency-docs` | info | Imports packages but no setup/requirements section |
| `skill/portability/hardcoded-home-path` | warn | Absolute `/home/username/` path in body |

### Agent rules

| Rule | Severity | Description |
|---|---|---|
| `agent/purpose/no-title` | warn | No H1 title |
| `agent/purpose/no-role-statement` | warn | No "You are…" or "Your role is…" near the top |
| `agent/instructions/filler-phrase` | info | Filler phrase wasting always-loaded context |
| `agent/instructions/duplicate-content` | info | Prose line duplicated verbatim — wasted always-loaded tokens |
| `agent/instructions/time-sensitive` | warn | Stale date reference |
| `agent/instructions/no-tool-section` | info | Tools mentioned but no "## Tools" section |
| `agent/boundaries/insufficient-constraints` | warn | Fewer than 2 NEVER/DO NOT constraints |
| `agent/boundaries/no-stopping-condition` | warn | No iteration limit or stopping condition |
| `agent/tokens/very-large` | warn | File exceeds ~3 000 tokens (always in context) |
| `agent/tokens/large` | info | File exceeds ~1 500 tokens |
| `agent/tokens/too-sparse` | info | File under 50 tokens |
| `agent/structure/no-sections` | info | No H2 headings |

### Security rules (shared)

| Rule | Severity | Description |
|---|---|---|
| `security/secrets/openai-key` | error | OpenAI API key pattern |
| `security/secrets/anthropic-key` | error | Anthropic API key pattern |
| `security/secrets/google-key` | error | Google API key pattern |
| `security/secrets/github-pat` | error | GitHub personal access token |
| `security/secrets/github-actions` | error | GitHub Actions token |
| `security/secrets/github-oauth` | error | GitHub OAuth token |
| `security/secrets/aws-access-key` | error | AWS access key ID |
| `security/secrets/private-key` | error | PEM private key block |
| `security/secrets/jwt-token` | error | JWT token |
| `security/secrets/slack-token` | error | Slack token |
| `security/secrets/hardcoded-password` | error | `password = "..."` pattern |
| `security/secrets/hardcoded-api-key` | error | `api_key = "..."` pattern |
| `security/commands/rm-rf-root` | error | Recursive deletion of `/`, `~`, or `*` |
| `security/commands/curl-pipe-shell` | error | `curl … | bash` remote execution |
| `security/commands/wget-pipe-shell` | error | `wget … | bash` remote execution |
| `security/commands/fork-bomb` | error | Fork bomb pattern |
| `security/commands/mkfs` | error | Filesystem format command |
| `security/commands/disk-wipe` | error | `dd` disk wipe |
| `security/commands/chmod-777-system` | error | World-writable system path |
| `security/commands/priv-escalation` | error | `sudo su` / `sudo bash` |
| `security/commands/eval-remote` | error | `eval $(curl …)` |
| `security/paths/ssh-keys` | warn | Access to `~/.ssh/` |
| `security/paths/etc-shadow` | warn | Access to `/etc/shadow` |
| `security/paths/etc-passwd` | warn | Access to `/etc/passwd` |
| `security/paths/aws-credentials` | warn | Access to `~/.aws/credentials` |
| `security/paths/gnupg` | warn | Access to `~/.gnupg/` |
| `security/paths/gcloud-creds` | warn | Access to `~/.config/gcloud/` |
| `security/paths/netrc` | warn | Access to `~/.netrc` |
| `security/exfiltration/curl-post-external` | warn | POST to external server |
| `security/exfiltration/file-content-pipe` | warn | File content piped out |
| `security/injection/no-defense` | warn | Agent file with no prompt injection guidance |
| `security/injection/invisible-unicode` | error | Zero-width, bidi-control, or Unicode tag characters — invisible to reviewers, visible to the model (ASCII smuggling) |
| `security/injection/override-attempt` | error | "Ignore previous instructions" style payload (defensive mentions are not flagged) |
| `security/injection/concealment` | warn | Directive to hide behavior from the user |
| `security/injection/hidden-html-comment` | warn | HTML comment with instruction-like content (stripped from rendered markdown, but the model reads it) |
| `security/injection/base64-blob` | warn | Long base64 blob in prose — may conceal a payload from review |

Secret, dangerous-command, sensitive-path, and exfiltration rules also apply to **companion scripts** shipped with a skill.

## Development

```bash
npm run build        # compile TypeScript → dist/
npm test             # run smoke tests (23 assertions)
```

After code changes, reinstall:

```bash
npm run build && npm install -g . --prefix ~/.local
```

## What's not here yet

- **Custom rules** — user-defined rule functions via config (planned for v2)
- **Auto-fix** — automated fixes for safe issues
- **Cross-file contradiction detection** — conflicting instructions between agent files
