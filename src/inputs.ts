import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';

export const EXTENSIONS = ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'];
export const EXT_RE = new RegExp(`\\.(${EXTENSIONS.join('|')})$`, 'i');
export const DEFAULT_SUFFIX = '.slim';
/** Added to files that were only attributed, not compressed. */
export const SIGNED_SUFFIX = '.signed';
/** Added to files that were only given English names, neither compressed nor attributed. */
export const ENGLISH_SUFFIX = '.en';

export interface InputItem {
  file: string;
  /** Path relative to the directory the user pointed at; keeps sub-folders under an output directory. */
  rel: string;
}

export interface OutputPlan {
  inPlace?: boolean;
  outDir?: string;
  suffix: string;
}

export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Expands files, folders and glob patterns into presentation files.
 * When scanning, Office lock files, hidden files, earlier outputs (names ending
 * in `skipSuffix`) and anything inside `outDir` are left out.
 */
export async function collectInputs(
  args: string[],
  recursive: boolean,
  skipSuffix: string,
  outDir: string | undefined,
): Promise<{ items: InputItem[]; unmatched: string[] }> {
  const items = new Map<string, InputItem>();
  const unmatched: string[] = [];
  /** Real paths of the files found in folders, links resolved. */
  const seen = new Set<string>();

  const wanted = (file: string): boolean => {
    const { name } = path.parse(file);
    if (name.startsWith('~$') || name.startsWith('.')) return false;
    if (skipSuffix && name.endsWith(skipSuffix)) return false;
    if (outDir && isInside(outDir, file)) return false;
    return true;
  };

  for (const arg of args) {
    const info = await stat(arg).catch(() => null);
    if (info?.isFile()) {
      // A file named explicitly is taken as-is; if it is not a presentation, opening it says so.
      const file = path.resolve(arg);
      items.set(file, { file, rel: path.basename(file) });
      continue;
    }
    if (info?.isDirectory()) {
      const pattern = `${recursive ? '**/' : ''}*.{${EXTENSIONS.join(',')}}`;
      const found = await glob(pattern, { cwd: arg, caseSensitiveMatch: false, expandDirectories: false });
      // A link to a folder further up lists the same files again under longer paths, so each file is
      // taken once, by the shortest way to it; the folder's files are then listed in path order.
      const picked: InputItem[] = [];
      for (const rel of found.sort((a, b) => depth(a) - depth(b) || compare(a, b))) {
        const file = path.resolve(arg, rel);
        if (!wanted(file)) continue;
        const real = await realpath(file).catch(() => file);
        if (seen.has(real)) continue;
        seen.add(real);
        picked.push({ file, rel });
      }
      for (const item of picked.sort((a, b) => compare(a.rel, b.rel))) items.set(item.file, item);
      continue;
    }
    // Not an existing path: treat it as a glob, since Windows shells do not expand them.
    const pattern = process.platform === 'win32' ? arg.replace(/\\/g, '/') : arg;
    const found = await glob(pattern, { absolute: true, caseSensitiveMatch: false, expandDirectories: false });
    const matches = found.map((f) => path.resolve(f)).filter((f) => EXT_RE.test(f) && wanted(f));
    if (matches.length === 0) unmatched.push(arg);
    for (const file of matches.sort()) items.set(file, { file, rel: path.basename(file) });
  }
  return { items: [...items.values()], unmatched };
}

const depth = (rel: string): number => rel.split('/').length;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function outputPathFor(item: InputItem, plan: OutputPlan): string {
  if (plan.inPlace) return item.file;
  const { dir, name, ext } = path.parse(item.file);
  const base = plan.outDir ? path.join(plan.outDir, path.dirname(item.rel)) : dir;
  return path.join(base, name + plan.suffix + ext);
}

/**
 * The key two paths share when they name the same place: also when they differ only in case or in how
 * their accents are encoded, as on macOS and Windows.
 */
export function samePlaceKey(file: string): string {
  return path.resolve(file).normalize('NFC').toLowerCase();
}

/**
 * Gives each result of one run a place of its own. Files of the same name from different folders,
 * gathered in one output folder, would otherwise be written over each other: the first keeps its name
 * and the others get a number, 汇报.slim.pptx -> 汇报.slim (2).pptx (folders: 汇报-slides (2)), never one
 * another result already has.
 */
export function distinctPaths(paths: string[], kind: 'file' | 'dir' = 'file'): string[] {
  const taken = new Set<string>();
  const first = paths.map((p) => {
    const key = samePlaceKey(p);
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
  return paths.map((p, i) => {
    if (first[i]) return p;
    const { dir, name, ext } = kind === 'dir' ? { dir: path.dirname(p), name: path.basename(p), ext: '' } : path.parse(p);
    for (let n = 2; ; n++) {
      const candidate = path.join(dir, `${name} (${n})${ext}`);
      const key = samePlaceKey(candidate);
      if (!taken.has(key)) {
        taken.add(key);
        return candidate;
      }
    }
  });
}

/** Where each file of a run is written: distinct places (see distinctPaths), or in place each over itself. */
export function outputPathsFor(items: InputItem[], plan: OutputPlan): string[] {
  const outputs = items.map((item) => outputPathFor(item, plan));
  return plan.inPlace ? outputs : distinctPaths(outputs);
}

export function previewPathFor(output: string): string {
  const { dir, name } = path.parse(output);
  return path.join(dir, `${name}.preview.html`);
}
