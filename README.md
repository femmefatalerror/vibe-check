# vibe-check ✨

> You vibe-coded your agents. Time for a vibe check.

A linter and security scanner for Claude skills, agents, and AI workspaces. Checks SKILL.md files, agent instruction files (CLAUDE.md, AGENTS.md, rules), harness config files (MCP servers, hooks, permissions — Claude Code, OpenCode, Copilot), and entire agent workspaces against Anthropic's documented best practices — including prompt-injection payloads, hidden-unicode smuggling, leaked secrets, and token bloat.

```
$ vibe-check .

  Score   58.3 / 100    Grade  F
  ✗ hardcoded AWS key
  ✗ hidden instruction in HTML comment

  ❌ Failed the vibe check.
```

**📖 Full documentation: [femmefatalerror.github.io/vibe-check](https://femmefatalerror.github.io/vibe-check/)** — every command, rule reference, scoring, configuration, and CI setup.

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

Just point it at something — `vibe-check <path>` figures out what it's looking at:

```bash
vibe-check skills/my-skill/    # skill directory → skill lint (+ companion scripts)
vibe-check CLAUDE.md           # agent file → agent lint
vibe-check .mcp.json           # harness config → MCP/hooks/permissions scan
vibe-check .                   # plain directory → full workspace diagnosis
vibe-check https://github.com/owner/repo/tree/main/skills/my-skill
```

Or be explicit:

```bash
vibe-check check path/to/SKILL.md            # lint a skill
vibe-check agent CLAUDE.md                   # lint an agent file
vibe-check diagnose ~/my-project             # workspace diagnosis
vibe-check batch ".claude/skills/**/SKILL.md"
```

Useful flags: `--json`, `--markdown`, `--sarif` (GitHub code scanning), `--min-score <n>` (CI quality gate), `--suppress <rules>`.

See the [docs](https://femmefatalerror.github.io/vibe-check/) for the full rule reference, scoring details, configuration, and CI recipes.

## Claude skill: lint → fix → verify

vibe-check ships a Claude Code skill that runs the linter, applies fixes for
the findings (with per-rule recipes for routing, structure, token cost, and a
hands-off triage flow for security findings), and re-runs to show the
before/after score:

```bash
vibe-check install-skill                    # → ~/.claude/skills/vibe-check (all projects)
vibe-check install-skill --project          # → ./.claude/skills (this project only)
vibe-check install-skill --target opencode  # → ~/.config/opencode/skills
vibe-check install-skill --target copilot   # → ~/.copilot/skills
vibe-check install-skill --target agents    # → ~/.agents/skills (read by Copilot,
                                            #   Cursor, OpenCode, Codex, Gemini, Windsurf)
```

Then ask your agent to "vibe check my skills". The skill passes its own
linter at 100/100 — enforced in CI.

## License

MIT
