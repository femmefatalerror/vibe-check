import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VERSION } from './version';

interface GithubRef {
  owner: string;
  repo: string;
  ref: string;
  dirPath: string;
  fileName?: string; // set when a blob URL names a specific file
}

interface GithubContentEntry {
  name: string;
  type: 'file' | 'dir';
  download_url: string | null;
  path: string;
}

export function isGithubUrl(input: string): boolean {
  return /^https?:\/\/github\.com\//i.test(input);
}

export function parseGithubUrl(url: string): GithubRef {
  // https://github.com/owner/repo/tree/branch[/path/to/dir]
  let m = url.match(/github\.com\/([^/]+)\/([^/?#]+)\/tree\/([^/]+)(?:\/(.*))?/);
  if (m) {
    return { owner: m[1], repo: m[2], ref: m[3], dirPath: m[4] ?? '' };
  }

  // https://github.com/owner/repo/blob/branch/path/to/FILE.md
  m = url.match(/github\.com\/([^/]+)\/([^/?#]+)\/blob\/([^/]+)\/(.*)/);
  if (m) {
    const filePath = m[4];
    return {
      owner: m[1],
      repo: m[2],
      ref: m[3],
      dirPath: path.dirname(filePath) === '.' ? '' : path.dirname(filePath),
      fileName: path.basename(filePath),
    };
  }

  // https://github.com/owner/repo  (bare repo — empty ref lets the API use the default branch)
  m = url.match(/github\.com\/([^/]+)\/([^/?#]+)\/?$/);
  if (m) {
    return { owner: m[1], repo: m[2], ref: '', dirPath: '' };
  }

  throw new Error(
    `Unrecognised GitHub URL: ${url}\n` +
    `Supported formats:\n` +
    `  github.com/owner/repo/tree/branch/path/to/dir\n` +
    `  github.com/owner/repo/blob/branch/path/to/file.md`
  );
}

async function apiFetch(url: string): Promise<string> {
  const headers: Record<string, string> = { 'User-Agent': `vibe-check/${VERSION}` };
  const token = process.env['GITHUB_TOKEN'];
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers });

  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error(
      'GitHub API rate limit reached.\n' +
      'Set GITHUB_TOKEN to increase the limit:\n' +
      '  export GITHUB_TOKEN=<your-personal-access-token>'
    );
  }

  if (!res.ok) {
    throw new Error(`GitHub request failed: HTTP ${res.status} ${res.statusText}\n  ${url}`);
  }

  return res.text();
}

async function listContents(ref: GithubRef): Promise<GithubContentEntry[]> {
  const apiPath = ref.dirPath ? `/${ref.dirPath}` : '';
  const refQuery = ref.ref ? `?ref=${ref.ref}` : '';
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents${apiPath}${refQuery}`;
  const json = await apiFetch(url);
  const data = JSON.parse(json);
  if (!Array.isArray(data)) {
    if ((data as GithubContentEntry).type === 'file') return [data as GithubContentEntry];
    throw new Error(`Expected a directory listing at ${ref.dirPath || '/'}, got type: ${(data as { type: string }).type}`);
  }
  return data as GithubContentEntry[];
}

const FETCH_EXTENSIONS = new Set(['.md', '.py', '.js', '.ts', '.sh', '.bash', '.zsh', '.json', '.yaml', '.yml']);

// Generic: fetch a directory and return the local path of the chosen primary file.
// candidates: ordered list of filenames to look for (first match wins).
async function fetchGithubContents(
  url: string,
  candidates: string[]
): Promise<{ tmpDir: string; primaryPath: string }> {
  const ref = parseGithubUrl(url);

  // Blob URLs name a specific file — honour it directly without a dir listing
  if (ref.fileName) {
    const rawUrl =
      `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.ref}/` +
      (ref.dirPath ? `${ref.dirPath}/` : '') +
      ref.fileName;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-linter-'));
    try {
      const content = await apiFetch(rawUrl);
      const localPath = path.join(tmpDir, ref.fileName);
      fs.writeFileSync(localPath, content, 'utf-8');
      return { tmpDir, primaryPath: localPath };
    } catch (e) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw e;
    }
  }

  // Tree URLs: list dir and find the best candidate
  const entries = await listContents(ref);
  const upperCandidates = candidates.map(c => c.toUpperCase());

  const primary = entries.find(
    e => e.type === 'file' && upperCandidates.includes(e.name.toUpperCase()) && e.download_url
  );

  if (!primary || !primary.download_url) {
    const found = entries.filter(e => e.type === 'file').map(e => e.name).join(', ');
    throw new Error(
      `None of [${candidates.join(', ')}] found in ${ref.dirPath || 'repo root'}.\n` +
      `Files present: ${found || '(none)'}`
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-linter-'));
  try {
    const download = async (dirEntries: GithubContentEntry[], destDir: string) => {
      await Promise.all(
        dirEntries
          .filter(e => e.type === 'file' && e.download_url && FETCH_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
          .map(async e => {
            const content = await apiFetch(e.download_url!);
            fs.writeFileSync(path.join(destDir, e.name), content, 'utf-8');
          })
      );
    };

    await download(entries, tmpDir);

    // one level of subdirectories — matches the local companion-script scan depth
    const subdirs = entries.filter(e => e.type === 'dir' && !e.name.startsWith('.') && e.name !== 'node_modules');
    await Promise.all(
      subdirs.map(async d => {
        const subEntries = await listContents({
          ...ref,
          dirPath: ref.dirPath ? `${ref.dirPath}/${d.name}` : d.name,
        });
        const dest = path.join(tmpDir, d.name);
        fs.mkdirSync(dest);
        await download(subEntries, dest);
      })
    );

    return { tmpDir, primaryPath: path.join(tmpDir, primary.name) };
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
}

export async function fetchGithubSkill(url: string): Promise<{ tmpDir: string; skillPath: string }> {
  const { tmpDir, primaryPath } = await fetchGithubContents(url, ['SKILL.md']);
  return { tmpDir, skillPath: primaryPath };
}

export async function fetchGithubAgent(url: string): Promise<{ tmpDir: string; agentPath: string }> {
  const { tmpDir, primaryPath } = await fetchGithubContents(url, [
    'CLAUDE.md', 'AGENT.md', 'AGENTS.md', 'agent.md', 'agents.md',
  ]);
  return { tmpDir, agentPath: primaryPath };
}
