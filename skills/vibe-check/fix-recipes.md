# Fix recipes by rule group

Apply the recipe for the rule group of each finding. Every recipe ends the same
way: re-run the linter and confirm the finding is gone.

## skill/meta/* — frontmatter

- `no-frontmatter`, `invalid-yaml`: add or repair the YAML block at the very
  top of the file, delimited by `---` lines, with at least `name` and
  `description`. Check for stray tabs and unquoted colons in values.
- `missing-name`, `name-format`: set `name` to lowercase letters, digits, and
  single hyphens, matching the directory name, max 64 chars.
- `name-reserved-word`: remove "claude"/"anthropic" from the name — these are
  rejected by Anthropic's skill validation and read as first-party
  impersonation. Rename by what the skill does (`pdf-tools`, not
  `claude-pdf-helper`).
- `name-vague`: rename to the capability, not a generic word like `helper` or
  `utils`.
- `description-too-long`: cut to the trigger + capability; move detail into the
  body. `*-xml-tags`: remove angle-bracket markup from frontmatter values.

## skill/routing/* — will Claude ever pick this skill?

The description is the only thing Claude sees when deciding whether to load a
skill. It must say what the skill does **and when to use it**, in third person.

- `no-trigger`: append an explicit trigger clause: "Use when the user …",
  naming concrete situations, file types, or keywords.
- `description-too-short`, `vague-description`: replace generic phrasing
  ("helps with documents") with specifics ("extracts text and tables from PDF
  files"). Name the nouns a user would actually type.
- `first-person` / `second-person`: rewrite "I extract…" / "You can use this
  to…" as "Extracts…".
- Before rewriting, check the frontmatter: if `disable-model-invocation: true`,
  routing findings are stale linter output — upgrade the linter instead.

## skill/structure/* and skill/content/*

- `no-sections`: break the body into `##` sections in workflow order.
- `deep-reference`: referenced files should sit next to SKILL.md or one
  directory down; flatten deeper trees.
- `windows-paths`: replace backslash paths with forward slashes.
- `duplicate-content`: keep the better copy, delete the other, and link to it
  if both locations need it.
- `filler-phrase`: delete the phrase; it costs tokens and adds nothing.
- `time-sensitive`: replace relative dates and "currently/latest" claims with
  absolute versions or remove them.
- `too-many-options`: pick a default and state it; move the alternatives to a
  reference file.
- `no-code-examples`: add one runnable example per main operation — commands
  beat prose descriptions of commands.
- `mcp-unqualified-tool`: qualify MCP tool names with their server prefix so
  the reference survives other servers being installed.

## skill/robustness/* and skill/portability/*

- `no-error-handling`: state what to do when the main command fails (missing
  dependency, bad input, nonzero exit) — one short paragraph is enough.
- `no-dependency-docs`: add a Requirements line naming the runtime and
  packages the skill assumes.
- `magic-number`: explain or name the constant where it is used.
- `hardcoded-home-path`: replace absolute home paths with `~`, `$HOME`, or a
  path relative to the skill.

## agent/* — CLAUDE.md and rule files

- `purpose/no-role-statement`, `purpose/no-title`: open with a title and one
  sentence stating what the agent is for.
- `structure/no-sections`: group rules under `##` headings by topic.
- `boundaries/no-stopping-condition`: state when the agent should stop or ask
  instead of continuing.
- `boundaries/insufficient-constraints`: add the "never do X" rules the role
  implies (what not to touch, when to ask).
- `instructions/no-tool-section`: document which tools/commands the agent
  should prefer.
- `instructions/duplicate-content`, `filler-phrase`, `time-sensitive`: same
  fixes as the skill/content rules above.
- `tokens/too-sparse`: a near-empty agent file still costs its load overhead —
  either give it real content or delete it.
- `tokens/large`, `tokens/very-large`: see
  [token-optimization.md](token-optimization.md).
