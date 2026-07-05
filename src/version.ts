import * as fs from 'fs';
import * as path from 'path';

// Single source of truth is package.json; read at runtime rather than imported
// so tsc's rootDir/dist layout is unaffected. __dirname is src/ under ts-node
// and dist/ when built — package.json sits one level up in both cases.
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
) as { version: string };

export const VERSION: string = pkg.version;
