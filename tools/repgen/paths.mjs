/*
 * Where repertoire files live: repertoires/ in the project folder, so runs, their caches
 * and cleaned PGNs don't pile up in the root. explorerdb's indexes (and the dumps they are
 * made from, if put there) have explorer/ instead. A name given with a directory is taken
 * as it is, relative to the current directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export var REPERTOIRES = path.join(ROOT, 'repertoires');
export var EXPLORER = path.join(ROOT, 'explorer');

function bare(name) { return path.basename(name) === name; }

// An output name (repgen's --out, pgnclean's --out): a bare name goes into repertoires/,
// or into `dir` when given.
export function outPath(name, dir) {
  return bare(name) ? path.join(dir || REPERTOIRES, name) : path.resolve(name);
}

// An input file: as given if it exists there, otherwise a bare name is looked up in
// repertoires/ (or `dir`).
export function inPath(name, dir) {
  return bare(name) && !fs.existsSync(name) ? path.join(dir || REPERTOIRES, name) : path.resolve(name);
}
