# Token optimization

Why it matters: agent files (CLAUDE.md, rules) are loaded into **every**
conversation — their token count is a permanent tax. A skill's SKILL.md is
loaded whenever the skill triggers; its referenced files are loaded only on
demand. So the lever is always the same: keep the always-loaded and
trigger-loaded layers thin, push bulk into on-demand references.

The linter's JSON output includes per-file token estimates and, for oversized
skills, a `dominant section` hint naming the heading that takes up most of the
body — start there.

## Recipe: shrink an oversized SKILL.md (`body-too-long`, `dominant-section`)

1. Identify the dominant section from the finding (or the largest `##` section).
2. Move its content to a reference file next to SKILL.md, named after the
   heading (e.g. `advanced-usage.md`).
3. Replace it in SKILL.md with a one-line pointer: what is in the file and when
   to read it — the *when* is what makes progressive disclosure work.
4. Repeat until the body holds only: what the skill does, the core workflow,
   and pointers. Verify every moved file is linked from SKILL.md, or the
   linter will flag it as unreferenced.

## Recipe: shrink an agent file (`agent/tokens/large`, `very-large`)

Agent files cannot use progressive disclosure — everything in them is always
loaded. Cut instead of relocate:

1. Delete anything Claude already does by default (be helpful, write tests,
   general coding style truisms).
2. Delete rules duplicating what a linter/formatter in the repo already
   enforces; the tool is the source of truth.
3. Collapse prose to imperatives: one rule, one line. Tables and examples are
   usually the biggest wins — keep one example, cut the rest.
4. Project knowledge that is only sometimes needed belongs in a skill or a
   referenced doc, not in CLAUDE.md.

## Quick wins in any file

- Delete filler phrases and restated headings.
- Deduplicate content repeated across sections or files (`duplicate-content`
  findings list the locations).
- Replace long explanations of a command with the command itself.

## What not to do

- Do not delete trigger information from descriptions to save tokens — routing
  breaks and the skill stops firing.
- Do not compress wording so hard it becomes ambiguous; an instruction that
  gets misread costs more than the tokens it saved.
- Do not split one coherent workflow across many tiny reference files; each
  hop is a read the model may skip.
