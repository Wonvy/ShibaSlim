import { SaxesParser } from 'saxes';

/** Minimal element tree. Text content is not needed anywhere, so it is dropped. */
export interface XNode {
  name: string;
  /** Name without namespace prefix. Matching on it keeps us tolerant of prefix and strict-OOXML namespace variations. */
  local: string;
  attrs: Record<string, string>;
  children: XNode[];
  parent: XNode | null;
}

export function decodeXml(data: Uint8Array): string {
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data);
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data);
  }
  return new TextDecoder('utf-8').decode(data);
}

function localName(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

export function parseXml(text: string): XNode {
  const parser = new SaxesParser();
  let root: XNode | null = null;
  let current: XNode | null = null;
  parser.on('error', (err) => {
    throw err;
  });
  parser.on('opentag', (tag) => {
    const node: XNode = {
      name: tag.name,
      local: localName(tag.name),
      attrs: tag.attributes as Record<string, string>,
      children: [],
      parent: current,
    };
    if (current) current.children.push(node);
    else root = node;
    current = node;
  });
  parser.on('closetag', () => {
    current = current ? current.parent : null;
  });
  parser.write(text).close();
  if (!root) throw new Error('XML 文档为空');
  return root;
}

/** Attribute lookup by local name (`embed` matches `r:embed`). */
export function attr(node: XNode, local: string): string | undefined {
  const direct = node.attrs[local];
  if (direct !== undefined) return direct;
  const suffix = ':' + local;
  for (const key in node.attrs) {
    if (key.endsWith(suffix)) return node.attrs[key];
  }
  return undefined;
}

export function child(node: XNode | undefined, local: string): XNode | undefined {
  return node?.children.find((c) => c.local === local);
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Like escapeAttr, but also keeps tabs and line breaks, which XML would otherwise turn into spaces in an attribute. */
export function escapeXml(value: string): string {
  return escapeAttr(value).replace(/[\t\n\r]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The text an escaped attribute value stands for: the five named entities and character references. */
export function unescapeXml(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (whole, hex: string, dec: string, name: string) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
