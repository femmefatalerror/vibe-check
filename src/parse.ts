import * as yaml from 'js-yaml';
import * as fs from 'fs';
import type { ParsedFile } from './types';

export function parseFile(filePath: string): ParsedFile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseContent(filePath, raw);
}

export function parseContent(filePath: string, raw: string): ParsedFile {
  const allLines = raw.split('\n');

  let frontmatter: Record<string, unknown> | null = null;
  let frontmatterError: string | null = null;
  let bodyLineOffset = 0;

  // Frontmatter delimiters must be `---` alone on a line; matching on substrings
  // miscounts when the frontmatter contains blank lines or `---`-prefixed content
  if (/^---\s*$/.test(allLines[0] ?? '')) {
    const closeIdx = allLines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
    if (closeIdx !== -1) {
      const fmText = allLines.slice(1, closeIdx).join('\n');
      try {
        const loaded = yaml.load(fmText) ?? null;
        // yaml.load happily returns scalars and arrays; downstream code does
        // `'name' in frontmatter`, so anything but a mapping must be rejected here
        if (loaded !== null && (typeof loaded !== 'object' || Array.isArray(loaded))) {
          frontmatterError = `frontmatter must be a YAML mapping of key: value pairs, got ${Array.isArray(loaded) ? 'a list' : `a ${typeof loaded}`}`;
        } else {
          frontmatter = loaded as Record<string, unknown> | null;
        }
      } catch (e) {
        frontmatterError = String(e);
      }
      bodyLineOffset = closeIdx + 1;
    }
  }

  const bodyLines = allLines.slice(bodyLineOffset);
  const body = bodyLines.join('\n');

  const headings: ParsedFile['headings'] = [];
  const links: ParsedFile['links'] = [];
  const disables: ParsedFile['disables'] = [];

  allLines.forEach((line, i) => {
    const lineNum = i + 1;

    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) headings.push({ level: hm[1].length, text: hm[2].trim(), line: lineNum });

    const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(line)) !== null) {
      links.push({ text: lm[1], href: lm[2], line: lineNum });
    }

    // <!-- lint-disable rule-id[, rule-id] --> (file-wide)
    // <!-- lint-disable-next-line rule-id --> (single line)
    const disableRe = /<!--\s*(?:skill-linter-|lint-)disable(-next-line)?\s+([a-z0-9/_,\s-]+?)\s*-->/gi;
    let dm: RegExpExecArray | null;
    while ((dm = disableRe.exec(line)) !== null) {
      const nextLineOnly = Boolean(dm[1]);
      for (const rule of dm[2].split(/[,\s]+/).filter(Boolean)) {
        disables.push({ ruleId: rule, line: nextLineOnly ? lineNum + 1 : undefined });
      }
    }
  });

  const codeBlocks: ParsedFile['codeBlocks'] = [];
  let inBlock = false;
  let blockLang = '';
  let blockContent: string[] = [];
  let blockLine = 0;

  allLines.forEach((line, i) => {
    const fence = line.match(/^```([a-zA-Z0-9-]*)/);
    if (fence && !inBlock) {
      inBlock = true;
      blockLang = fence[1];
      blockContent = [];
      blockLine = i + 1;
    } else if (line.startsWith('```') && inBlock) {
      codeBlocks.push({ lang: blockLang, content: blockContent.join('\n'), line: blockLine });
      inBlock = false;
      blockContent = [];
    } else if (inBlock) {
      blockContent.push(line);
    }
  });

  return { path: filePath, raw, frontmatter, frontmatterError, body, bodyLines, bodyLineOffset, headings, codeBlocks, links, disables };
}
