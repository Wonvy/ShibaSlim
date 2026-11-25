import JSZip from 'jszip';
import { posix } from 'node:path';
import { attr, decodeXml, escapeAttr, parseXml } from './xml.js';

/** An error whose message is meant to be shown to the user as-is. */
export class SlimError extends Error {}

const CONTENT_TYPES = '[Content_Types].xml';
const RELS_RE = /^(?:(.*)\/)?_rels\/([^/]*)\.rels$/i;
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
/** Entry types worth re-deflating at the highest level even when their content is unchanged. */
const RECOMPRESS_EXT = new Set(['xml', 'rels', 'vml', 'emf', 'wmf', 'svg']);

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
  /** Zip entry the target resolves to; null for external or dangling targets. */
  part: string | null;
}

export interface RelsFile {
  path: string;
  /** Directory of the source part ('' for the package root). */
  baseDir: string;
  /** The part these relationships belong to ('' for the package root). */
  source: string;
  rels: Relationship[];
  dirty: boolean;
}

export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * An Open Packaging Conventions container (pptx/docx/xlsx are all this): a zip
 * whose parts reference each other only through `.rels` files, with part media
 * types declared in `[Content_Types].xml`. Renaming or removing a part therefore
 * means keeping those two in sync, which is what this class is for.
 */
export class OpcPackage {
  readonly relsFiles: RelsFile[] = [];
  /** Part names are case-insensitive in OPC; this maps lower-case name to the real entry name. */
  private index = new Map<string, string>();
  private touched = new Set<string>();
  private defaults: { ext: string; type: string }[] = [];
  private overrides: { part: string; type: string }[] = [];
  private typesDirty = false;

  private constructor(private readonly zip: JSZip) {}

  static async load(data: Buffer): Promise<OpcPackage> {
    if (data.length >= 4 && data.readUInt32BE(0) === 0xd0cf11e0) {
      throw new SlimError('文件已加密，或是旧版 .ppt 格式，无法处理');
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(data);
    } catch {
      throw new SlimError('不是有效的 pptx 文件（无法作为 zip 打开）');
    }
    const pkg = new OpcPackage(zip);
    for (const name of pkg.names()) pkg.index.set(name.toLowerCase(), name);
    if (!pkg.has(CONTENT_TYPES)) throw new SlimError('不是有效的 pptx 文件（缺少 [Content_Types].xml）');
    try {
      await pkg.loadContentTypes();
      await pkg.loadRels();
    } catch (err) {
      if (err instanceof SlimError) throw err;
      throw new SlimError(`文件结构损坏：${err instanceof Error ? err.message : String(err)}`);
    }
    return pkg;
  }

  names(): string[] {
    return Object.keys(this.zip.files).filter((name) => !this.zip.files[name]!.dir);
  }

  has(name: string): boolean {
    return this.index.get(name.toLowerCase()) === name;
  }

  async read(name: string): Promise<Buffer> {
    const entry = this.zip.file(name);
    if (!entry) throw new SlimError(`包内缺少部件 ${name}`);
    return entry.async('nodebuffer');
  }

  write(name: string, data: Buffer): void {
    const date = this.zip.files[name]?.date;
    // Replacing an existing key keeps its position, so [Content_Types].xml stays the first entry.
    this.zip.file(name, data, { createFolders: false, binary: true, ...(date ? { date } : {}) });
    this.index.set(name.toLowerCase(), name);
    this.touched.add(name);
  }

  remove(name: string): void {
    this.zip.remove(name);
    this.index.delete(name.toLowerCase());
    this.touched.delete(name);
    const partName = '/' + name.toLowerCase();
    const before = this.overrides.length;
    this.overrides = this.overrides.filter((o) => o.part.toLowerCase() !== partName);
    if (this.overrides.length !== before) this.typesDirty = true;
  }

  /** Replaces a part with new content under a new name, fixing every relationship and the content type. */
  rename(oldName: string, newName: string, data: Buffer, contentType: string): void {
    this.remove(oldName);
    this.write(newName, data);
    this.setContentType(newName, contentType);
    this.retarget(oldName, newName);
  }

  /** Points every relationship that targets `from` at `to` instead. */
  retarget(from: string, to: string): void {
    for (const file of this.relsFiles) {
      for (const rel of file.rels) {
        if (rel.part !== from) continue;
        const wasEncoded = rel.target !== safeDecode(rel.target);
        const target = rel.target.startsWith('/')
          ? '/' + to
          : posix.relative('/' + file.baseDir, '/' + to);
        rel.target = wasEncoded ? encodeURI(target) : target;
        rel.part = to;
        file.dirty = true;
      }
    }
  }

  removeRel(file: RelsFile, rel: Relationship): void {
    file.rels = file.rels.filter((r) => r !== rel);
    file.dirty = true;
  }

  referencedParts(): Set<string> {
    const parts = new Set<string>();
    for (const file of this.relsFiles) {
      for (const rel of file.rels) if (rel.part) parts.add(rel.part);
    }
    return parts;
  }

  /** Internal relationships whose target does not exist in the package. */
  danglingCount(): number {
    let count = 0;
    for (const file of this.relsFiles) {
      for (const rel of file.rels) if (!rel.external && !rel.part) count++;
    }
    return count;
  }

  /** Returns `desired`, or a numbered variant of it if that name is already taken. */
  uniqueName(desired: string): string {
    if (!this.index.has(desired.toLowerCase())) return desired;
    const dot = desired.lastIndexOf('.');
    const stem = desired.slice(0, dot);
    const ext = desired.slice(dot);
    for (let i = 1; ; i++) {
      const candidate = `${stem}_${i}${ext}`;
      if (!this.index.has(candidate.toLowerCase())) return candidate;
    }
  }

  /**
   * Uncompressed size and CRC straight from the zip directory, so identical
   * entries can be spotted without inflating them (matters for large videos).
   * Only available for entries that have not been rewritten.
   */
  entryInfo(name: string): { size: number; crc32: number } | null {
    const raw = (this.zip.files[name] as unknown as { _data?: { uncompressedSize?: unknown; crc32?: unknown } } | undefined)?._data;
    if (raw && typeof raw.uncompressedSize === 'number' && typeof raw.crc32 === 'number') {
      return { size: raw.uncompressedSize, crc32: raw.crc32 };
    }
    return null;
  }

  contentType(name: string): string | undefined {
    const partName = '/' + name.toLowerCase();
    const override = this.overrides.find((o) => o.part.toLowerCase() === partName);
    if (override) return override.type;
    const ext = extOf(name);
    return this.defaults.find((d) => d.ext === ext)?.type;
  }

  /** The extension the package already uses for `contentType`, or `fallback` if it declares none. */
  preferredExt(contentType: string, fallback: string): string {
    const matching = this.defaults.filter((d) => d.type.toLowerCase() === contentType).map((d) => d.ext);
    if (matching.length === 0 || matching.includes(fallback)) return fallback;
    return matching[0]!;
  }

  setContentType(name: string, contentType: string): void {
    if (this.contentType(name)?.toLowerCase() === contentType) return;
    const ext = extOf(name);
    if (!this.defaults.some((d) => d.ext === ext)) this.defaults.push({ ext, type: contentType });
    else this.overrides.push({ part: '/' + name, type: contentType });
    this.typesDirty = true;
  }

  async save(): Promise<Buffer> {
    for (const file of this.relsFiles) {
      if (!file.dirty) continue;
      this.write(file.path, Buffer.from(serializeRels(file), 'utf8'));
      file.dirty = false;
    }
    if (this.typesDirty) {
      this.write(CONTENT_TYPES, Buffer.from(this.serializeContentTypes(), 'utf8'));
      this.typesDirty = false;
    }
    // JSZip passes untouched deflated entries through byte-for-byte, so the
    // ones worth squeezing harder have to be handed back as raw data.
    for (const name of this.names()) {
      if (this.touched.has(name) || !RECOMPRESS_EXT.has(extOf(name))) continue;
      this.write(name, await this.read(name));
    }
    return this.zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
  }

  private lookup(name: string): string | null {
    return this.index.get(name.toLowerCase()) ?? null;
  }

  private resolve(baseDir: string, target: string): string | null {
    const raw = target.split('#')[0] ?? '';
    if (!raw) return null;
    const joined = raw.startsWith('/') ? raw.slice(1) : posix.join(baseDir, raw);
    const normalized = posix.normalize(joined);
    return this.lookup(normalized) ?? this.lookup(safeDecode(normalized));
  }

  private async loadContentTypes(): Promise<void> {
    const root = parseXml(decodeXml(await this.read(CONTENT_TYPES)));
    for (const node of root.children) {
      const type = attr(node, 'ContentType');
      if (!type) continue;
      if (node.local === 'Default') {
        const ext = attr(node, 'Extension');
        if (ext) this.defaults.push({ ext: ext.toLowerCase(), type });
      } else if (node.local === 'Override') {
        const part = attr(node, 'PartName');
        if (part) this.overrides.push({ part, type });
      }
    }
  }

  private serializeContentTypes(): string {
    const defaults = this.defaults
      .map((d) => `<Default Extension="${escapeAttr(d.ext)}" ContentType="${escapeAttr(d.type)}"/>`)
      .join('');
    const overrides = this.overrides
      .map((o) => `<Override PartName="${escapeAttr(o.part)}" ContentType="${escapeAttr(o.type)}"/>`)
      .join('');
    return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}${overrides}</Types>`;
  }

  private async loadRels(): Promise<void> {
    for (const path of this.names()) {
      const match = RELS_RE.exec(path);
      if (!match) continue;
      const baseDir = match[1] ?? '';
      const sourceName = match[2] ?? '';
      const source = sourceName ? (baseDir ? `${baseDir}/${sourceName}` : sourceName) : '';
      const root = parseXml(decodeXml(await this.read(path)));
      const rels: Relationship[] = [];
      for (const node of root.children) {
        if (node.local !== 'Relationship') continue;
        const target = attr(node, 'Target') ?? '';
        const external = (attr(node, 'TargetMode') ?? '').toLowerCase() === 'external';
        rels.push({
          id: attr(node, 'Id') ?? '',
          type: attr(node, 'Type') ?? '',
          target,
          external,
          part: external ? null : this.resolve(baseDir, target),
        });
      }
      this.relsFiles.push({ path, baseDir, source, rels, dirty: false });
    }
  }
}

function serializeRels(file: RelsFile): string {
  const items = file.rels
    .map(
      (r) =>
        `<Relationship Id="${escapeAttr(r.id)}" Type="${escapeAttr(r.type)}" Target="${escapeAttr(r.target)}"` +
        (r.external ? ' TargetMode="External"' : '') +
        '/>',
    )
    .join('');
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
}
