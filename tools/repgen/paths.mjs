/*
 * Where repertoire files live: repertoires/ in the project folder, so runs, their caches
 * and cleaned PGNs don't pile up in the root. A name given with a directory is taken as it
 * is, relative to the current directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export var REPERTOIRES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..',
  'repertoires');

function bare(name) { return path.basename(name) === name; }

// An output name (repgen's --out, pgnclean's --out): a bare name goes into repertoires/.
export function outPath(name) {
  return bare(name) ? path.join(REPERTOIRES, name) : path.resolve(name);
}

// An input file: as given if it exists there, otherwise a bare name is looked up in
// repertoires/.
export function inPath(name) {
  return bare(name) && !fs.existsSync(name) ? path.join(REPERTOIRES, name) : path.resolve(name);
}
