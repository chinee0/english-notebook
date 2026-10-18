import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8').trim();

const header = read('src/header.txt');
const core = read('src/core.js');
const ui = read('src/ui.js');

const out = `${header}\n\n${core}\n\n${ui}\n`;
const target = join(root, 'english-notebook.user.js');
writeFileSync(target, out, 'utf8');

const lines = out.split('\n').length;
console.log(`built ${target} (${lines} lines)`);
