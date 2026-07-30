// tsc only emits .js. The web widget ships a static HTML shell alongside it.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'ui', 'web', 'page.html');
const to = join(root, 'dist', 'ui', 'web', 'page.html');

if (existsSync(from)) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  console.log('copied page.html -> dist/ui/web/page.html');
}
