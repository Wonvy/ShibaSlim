import { stat } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';

export const EXTENSIONS = ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'];
export const EXT_RE = new RegExp(`\\.(${EXTENSIONS.join('|')})$`, 'i');
export const DEFAULT_SUFFIX = '.slim';
/** Added to files that were only attributed, not compressed. */
export const SIGNED_SUFFIX = '.signed';

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
      for (const rel of found.sort()) {
        const file = path.resolve(arg, rel);
        if (wanted(file)) items.set(file, { file, rel });
      }
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

export function outputPathFor(item: InputItem, plan: OutputPlan): string {
  if (plan.inPlace) return item.file;
  const { dir, name, ext } = path.parse(item.file);
  const base = plan.outDir ? path.join(plan.outDir, path.dirname(item.rel)) : dir;
  return path.join(base, name + plan.suffix + ext);
}

export function previewPathFor(output: string): string {
  const { dir, name } = path.parse(output);
  return path.join(dir, `${name}.preview.html`);
}
