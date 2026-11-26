import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpcPackage, SlimError, XML_HEADER } from './opc.js';
import { attr, decodeXml, escapeXml, parseXml } from './xml.js';

/*
 * Optional attribution: who made a presentation, written where people look for it
 * and signed so a copy can later be checked.
 *
 * - File properties: author and last saver in docProps/core.xml, company in
 *   docProps/app.xml. Explorer's Properties > Details, Finder and PowerPoint's
 *   File > Info read them from there.
 * - Selection pane: a hidden, empty shape named "© year author" on top of every
 *   slide. It is never shown or printed, and animations refer to shapes by id, so
 *   they are unaffected.
 * - Signature: presentation-level tags (the store PowerPoint keeps for add-ins and
 *   carries over when saving) hold the author, the time, an Ed25519 public key and
 *   a signature over every part of the package. Any later change, including saving
 *   again in PowerPoint, makes the signature stop matching.
 *
 * None of this stops anyone from removing it: it records, it does not protect.
 */

export interface Attribution {
  /** Written as the author and last saver in the file's properties, and named on every slide's hidden marker. */
  author: string;
  /** Written as the company in the file's properties. */
  company?: string;
  /**
   * The Ed25519 private key to sign with: a key, the path of a PEM file, or false not to sign.
   * By default it is this computer's key (see defaultKeyPath), created on first use.
   */
  signingKey?: KeyObject | string | false;
}

export interface ResolvedAttribution {
  author: string;
  /** '' when not given. */
  company: string;
  key: KeyObject | null;
}

export interface AttributionResult {
  author: string;
  company?: string;
  /** When it was signed (UTC, ISO 8601); absent when unsigned. */
  signedAt?: string;
  /** Short fingerprint of the signing key; absent when unsigned. */
  fingerprint?: string;
}

/**
 * valid: unchanged since it was signed; modified: changed afterwards (or the signature was forged);
 * invalid: the signature data itself is damaged or of an unknown kind; unsigned: no ShibaSlim signature.
 */
export type SignatureStatus = 'valid' | 'modified' | 'invalid' | 'unsigned';

export interface SignatureCheck {
  status: SignatureStatus;
  author?: string;
  company?: string;
  signedAt?: string;
  fingerprint?: string;
}

export const MAX_NAME_LENGTH = 200;

const SCHEME = 'ed25519-sha256-v1';
const TAG = {
  scheme: 'SHIBASLIM_SCHEME',
  author: 'SHIBASLIM_AUTHOR',
  company: 'SHIBASLIM_COMPANY',
  signedAt: 'SHIBASLIM_SIGNED_AT',
  publicKey: 'SHIBASLIM_PUBLIC_KEY',
  signature: 'SHIBASLIM_SIGNATURE',
} as const;
const OWN_TAG = /^SHIBASLIM_/i;
/** The marker's alt-text title, so a later run can find and replace it. */
const MARKER_TITLE = 'ShibaSlim';

/** Transitional namespace first, then Strict OOXML. */
const NS = {
  p: ['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'],
  a: ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'],
  r: ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'],
  tagsRel: [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/tags',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/tags',
  ],
  app: ['http://schemas.openxmlformats.org/officeDocument/2006/extended-properties', 'http://purl.oclc.org/ooxml/officeDocument/extendedProperties'],
} as const;
const DC = 'http://purl.org/dc/elements/1.1/';
const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
const CORE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
const APP_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties';
const TYPES = {
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  tags: 'application/vnd.openxmlformats-officedocument.presentationml.tags+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
};
const EMPTY_CORE =
  `${XML_HEADER}<cp:coreProperties xmlns:cp="${CP}" xmlns:dc="${DC}" xmlns:dcterms="http://purl.org/dc/terms/" ` +
  'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>';
const EMPTY_APP = `${XML_HEADER}<Properties xmlns="${NS.app[0]}" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>`;

// <p:custDataLst> is only ever a direct child of <p:presentation>; <p:tags> may appear in it once.
const CUST_DATA_RE = /<((?:[\w.-]+:)?)custDataLst(?=[\s/>])[^>]*?(?:\/>|>([\s\S]*?)<\/\1custDataLst\s*>)/;
const TAGS_REF_RE = /<(?:[\w.-]+:)?tags(?=[\s/>])[^>]*?\s(?:[\w.-]+:)?id\s*=\s*["']([^"']*)["'][^>]*?(?:\/>|>\s*<\/(?:[\w.-]+:)?tags\s*>)/;

// ---------- keys ----------

/** Where this computer's signing key lives; SHIBASLIM_KEY_FILE points somewhere else. */
export function defaultKeyPath(): string {
  const override = process.env.SHIBASLIM_KEY_FILE;
  if (override) return path.resolve(override);
  const home = os.homedir();
  const dir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ShibaSlim')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'ShibaSlim')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'shibaslim');
  return path.join(dir, 'signing-key.pem');
}

const keyCache = new Map<string, Promise<KeyObject>>();

/** The signing key in `file`, created there the first time it is needed. */
export function loadOrCreateKey(file = defaultKeyPath()): Promise<KeyObject> {
  let pending = keyCache.get(file);
  if (!pending) {
    pending = (async () => (await readKey(file)) ?? (await createKey(file)))();
    keyCache.set(file, pending);
    pending.catch(() => keyCache.delete(file));
  }
  return pending;
}

/** Reads a private key file named explicitly; unlike this computer's key, it is never created. */
export async function loadKey(file: string): Promise<KeyObject> {
  const key = await readKey(path.resolve(file));
  if (!key) throw new SlimError('error.signKeyMissing', { path: file });
  return key;
}

/** The fingerprint of the key in `file` (private or public PEM), or null if there is no such file. */
export async function keyFileFingerprint(file = defaultKeyPath()): Promise<string | null> {
  let pem: Buffer;
  try {
    pem = await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw keyFileError(file, err);
  }
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType === 'ed25519') return fingerprint(key);
  } catch {
    // reported below
  }
  throw new SlimError('error.signKeyType', { path: file });
}

/** Short, readable fingerprint of a key: the start of the SHA-256 of its public half. */
export function fingerprint(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/(.{4})(?!$)/g, '$1 ');
}

async function readKey(file: string): Promise<KeyObject | null> {
  let pem: Buffer;
  try {
    pem = await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw keyFileError(file, err);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new SlimError('error.signKeyType', { path: file });
  }
  return checkKey(key, file);
}

async function createKey(file: string): Promise<KeyObject> {
  const { privateKey } = generateKeyPairSync('ed25519');
  try {
    await mkdir(path.dirname(file), { recursive: true });
    // Readable by this user only. 'wx' fails if another process got there first; its key is used instead.
    await writeFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    return privateKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await readKey(file);
      if (existing) return existing;
    }
    throw keyFileError(file, err);
  }
}

function checkKey(key: KeyObject, label: string): KeyObject {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new SlimError('error.signKeyType', { path: label });
  return key;
}

function keyFileError(file: string, err: unknown): SlimError {
  return new SlimError('error.signKeyFile', { path: file, detail: err instanceof Error ? err.message : String(err) });
}

// ---------- applying ----------

/** Checks the names and loads the key once, so a batch neither reads nor creates it for every file. */
export async function resolveAttribution(input: Attribution): Promise<ResolvedAttribution> {
  const author = cleanName(input.author);
  const company = cleanName(input.company);
  if (!author) throw new SlimError('error.authorMissing');
  if (author.length > MAX_NAME_LENGTH || company.length > MAX_NAME_LENGTH) {
    throw new SlimError('error.nameTooLong', { max: MAX_NAME_LENGTH });
  }
  const given = input.signingKey;
  const key =
    given === false
      ? null
      : given === undefined
        ? await loadOrCreateKey()
        : typeof given === 'string'
          ? await loadKey(given)
          : checkKey(given, 'KeyObject');
  return { author, company, key };
}

/**
 * Writes the attribution into the file properties and every slide's selection pane, then signs
 * the package if there is a key. The signature covers every part, so this must be the last change.
 */
export async function applyAttribution(pkg: OpcPackage, attribution: ResolvedAttribution, now = new Date()): Promise<AttributionResult> {
  const { author, company, key } = attribution;
  await setCoreProperties(pkg, author);
  if (company) await setCompany(pkg, company);
  await markSlides(pkg, `© ${now.getFullYear()} ${company ? `${author} · ${company}` : author}`);
  const result: AttributionResult = { author, ...(company ? { company } : {}) };
  if (!key) {
    // A signature from an earlier run would only name the old author and fail to match.
    await removeSignature(pkg);
    return result;
  }
  return { ...result, ...(await signPackage(pkg, author, company, key, now)) };
}

async function setCoreProperties(pkg: OpcPackage, author: string): Promise<void> {
  const part = propertiesPart(pkg, (type) => type.endsWith('/metadata/core-properties'), CORE_REL, 'docProps/core.xml', TYPES.core, EMPTY_CORE);
  let xml = await readText(pkg, part);
  xml = setElement(xml, 'coreProperties', [DC], 'creator', author);
  xml = setElement(xml, 'coreProperties', [CP], 'lastModifiedBy', author);
  writeText(pkg, part, xml);
}

async function setCompany(pkg: OpcPackage, company: string): Promise<void> {
  const part = propertiesPart(pkg, (type) => /\/extended-?properties$/i.test(type), APP_REL, 'docProps/app.xml', TYPES.app, EMPTY_APP);
  writeText(pkg, part, setElement(await readText(pkg, part), 'Properties', [...NS.app], 'Company', company));
}

/** The properties part the package root points at, created empty if there is none. */
function propertiesPart(
  pkg: OpcPackage,
  isType: (type: string) => boolean,
  relType: string,
  name: string,
  contentType: string,
  empty: string,
): string {
  const root = pkg.relsOf('');
  const rel = root?.rels.find((r) => !r.external && isType(r.type));
  if (rel?.part) return rel.part;
  // A relationship to a missing part would leave two of a kind once the new one is added.
  if (rel && root) pkg.removeRel(root, rel);
  const part = pkg.uniqueName(name);
  pkg.write(part, Buffer.from(empty, 'utf8'));
  pkg.setContentType(part, contentType);
  pkg.addRel('', relType, part);
  return part;
}

/** Sets the text of the element `local` (any prefix), adding it at the end of the root element if missing. */
function setElement(xml: string, rootLocal: string, uris: string[], local: string, value: string): string {
  const text = escapeXml(value);
  const existing = new RegExp(`<((?:[\\w.-]+:)?)${local}((?:\\s[^>]*?)?)\\s*(?:/>|>[\\s\\S]*?</\\1${local}\\s*>)`).exec(xml);
  if (existing) {
    const name = existing[1] + local;
    return replaceAt(xml, existing.index, existing[0].length, `<${name}${existing[2]}>${text}</${name}>`);
  }
  const prefix = prefixFor(xml, uris);
  const element =
    prefix === null ? `<${local} xmlns="${uris[0]}">${text}</${local}>` : `<${qualify(prefix, local)}>${text}</${qualify(prefix, local)}>`;
  const close = lastMatch(xml, new RegExp(`</(?:[\\w.-]+:)?${rootLocal}\\s*>`, 'g'));
  if (close) return replaceAt(xml, close.index!, 0, element);
  const selfClosed = new RegExp(`<((?:[\\w.-]+:)?${rootLocal})((?:\\s[^>]*?)?)\\s*/>`).exec(xml);
  if (!selfClosed) throw new SlimError('error.corrupt', { detail: rootLocal });
  return replaceAt(xml, selfClosed.index, selfClosed[0].length, `<${selfClosed[1]}${selfClosed[2]}>${element}</${selfClosed[1]}>`);
}

async function markSlides(pkg: OpcPackage, name: string): Promise<void> {
  for (const part of pkg.names()) {
    if (pkg.contentType(part)?.toLowerCase() !== TYPES.slide) continue;
    const marked = markSlide(await readText(pkg, part), name);
    if (marked !== null) writeText(pkg, part, marked);
  }
}

/**
 * Puts a hidden, empty shape named `name` on top of the slide, where the selection pane lists it
 * first, replacing one left by an earlier run. Null if the slide has no shape tree.
 */
function markSlide(source: string, name: string): string | null {
  const tree = /<((?:[\w.-]+:)?)spTree(?=[\s>])/.exec(source);
  if (!tree) return null;
  const p = tree[1]!;
  const pe = escapeRe(p);
  // A <p:sp> never contains another one (groups are <p:grpSp>), so each match is exactly one shape.
  const xml = source.replace(new RegExp(`<${pe}sp(?=[\\s>])[\\s\\S]*?</${pe}sp\\s*>`, 'g'), (shape) => (isMarker(shape) ? '' : shape));
  const close = lastMatch(xml, new RegExp(`</${pe}spTree\\s*>`, 'g'));
  if (!close) return null;
  let at = close.index!;
  // The tree's own extension list must stay its last child.
  if (new RegExp(`</${pe}extLst\\s*>\\s*$`).test(xml.slice(0, at))) {
    const open = xml.lastIndexOf(`<${p}extLst`, at);
    if (open > tree.index) at = open;
  }

  let maxId = 0;
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?cNvPr(?=[\s/>])[^>]*?\sid\s*=\s*["'](\d+)["']/g)) maxId = Math.max(maxId, Number(m[1]));
  const aUri = NS.a[uriOf(xml, p) === NS.p[1] ? 1 : 0];
  const aPrefix = prefixFor(xml, [aUri]);
  const a = aPrefix ? `${aPrefix}:` : 'a:';
  const declare = aPrefix ? '' : ` xmlns:a="${aUri}"`;
  const shape =
    `<${p}sp${declare}><${p}nvSpPr><${p}cNvPr id="${maxId + 1}" name="${escapeXml(name)}" title="${MARKER_TITLE}" hidden="1"/>` +
    `<${p}cNvSpPr/><${p}nvPr/></${p}nvSpPr><${p}spPr><${a}xfrm><${a}off x="0" y="0"/><${a}ext cx="0" cy="0"/></${a}xfrm>` +
    `<${a}prstGeom prst="rect"><${a}avLst/></${a}prstGeom><${a}noFill/><${a}ln><${a}noFill/></${a}ln></${p}spPr></${p}sp>`;
  return replaceAt(xml, at, 0, shape);
}

function isMarker(shape: string): boolean {
  return new RegExp(`<(?:[\\w.-]+:)?cNvPr(?=[\\s/>])[^>]*?\\stitle\\s*=\\s*["']${MARKER_TITLE}["']`).test(shape);
}

// ---------- signing ----------

async function signPackage(
  pkg: OpcPackage,
  author: string,
  company: string,
  key: KeyObject,
  now: Date,
): Promise<{ signedAt: string; fingerprint: string }> {
  const pres = presentationPart(pkg);
  if (!pres) throw new SlimError('error.noPresentation');
  let xml = await readText(pkg, pres);
  const root = /<((?:[\w.-]+:)?)presentation(?=[\s>])/.exec(xml);
  if (!root) throw new SlimError('error.noPresentation');
  const p = root[1]!;
  const pUri = uriOf(xml, p) ?? NS.p[0];
  const flavor = pUri === NS.p[1] ? 1 : 0;

  // Reuse the presentation's tags if it has some (add-ins keep theirs there too), keeping everything but ours.
  let part: string | null = null;
  let others: [string, string][] = [];
  const ref = TAGS_REF_RE.exec(CUST_DATA_RE.exec(xml)?.[2] ?? '');
  if (ref) {
    part = pkg.relsOf(pres)?.rels.find((r) => r.id === ref[1])?.part ?? null;
    if (part) others = (await readTags(pkg, part)).filter(([name]) => !OWN_TAG.test(name));
    else xml = xml.replace(ref[0], ''); // points nowhere: replaced below
  }
  if (!part) {
    part = tagsPartName(pkg);
    const id = pkg.addRel(pres, NS.tagsRel[flavor], part);
    pkg.setContentType(part, TYPES.tags);
    const rUri = NS.r[flavor];
    const rPrefix = prefixFor(xml, [rUri]);
    const element = rPrefix ? `<${p}tags ${rPrefix}:id="${id}"/>` : `<${p}tags xmlns:r="${rUri}" r:id="${id}"/>`;
    xml = addTagsReference(xml, p, element);
    writeText(pkg, pres, xml);
  }

  const signedAt = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  const tags: [string, string][] = [
    ...others,
    [TAG.scheme, SCHEME],
    [TAG.author, author],
    ...(company ? [[TAG.company, company] as [string, string]] : []),
    [TAG.signedAt, signedAt],
    [TAG.publicKey, publicKey],
  ];
  // From here on every other part is final: pending relationships and content types are written out.
  pkg.flush();
  const signature = sign(null, await signedContent(pkg, part, tags), key).toString('base64');
  writeText(pkg, part, serializeTags(pUri, [...tags, [TAG.signature, signature]]));
  return { signedAt, fingerprint: fingerprint(key) };
}

/** Checks a package's ShibaSlim signature. */
export async function checkSignature(pkg: OpcPackage): Promise<SignatureCheck> {
  const pres = presentationPart(pkg);
  const part = pres ? tagsPartOf(pkg, pres, await readText(pkg, pres)) : null;
  if (!part) return { status: 'unsigned' };

  let tags: [string, string][];
  try {
    tags = await readTags(pkg, part);
  } catch {
    return { status: 'invalid' };
  }
  const value = (name: string) => tags.find(([n]) => n === name)?.[1];
  const signature = value(TAG.signature);
  if (signature === undefined) return { status: 'unsigned' };
  const company = value(TAG.company);
  const info = { author: value(TAG.author) ?? '', ...(company ? { company } : {}), signedAt: value(TAG.signedAt) ?? '' };

  try {
    const publicKey = createPublicKey({ key: Buffer.from(value(TAG.publicKey) ?? '', 'base64'), format: 'der', type: 'spki' });
    if (value(TAG.scheme) !== SCHEME || publicKey.asymmetricKeyType !== 'ed25519') return { status: 'invalid', ...info };
    const valid = verify(null, await signedContent(pkg, part, tags), publicKey, Buffer.from(signature, 'base64'));
    return { status: valid ? 'valid' : 'modified', ...info, fingerprint: fingerprint(publicKey) };
  } catch {
    return { status: 'invalid', ...info };
  }
}

/** Checks the ShibaSlim signature of a presentation held in memory. */
export async function checkSignatureOf(data: Buffer): Promise<SignatureCheck> {
  return checkSignature(await OpcPackage.load(data));
}

/**
 * What the signature covers: the SHA-256 of every part except the tags part that holds it, plus
 * every tag in that part except the signature itself (so add-ins' tags are covered as well).
 */
async function signedContent(pkg: OpcPackage, tagsPart: string, tags: [string, string][]): Promise<Buffer> {
  const covered = tags.filter(([name]) => name !== TAG.signature).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const lines = [SCHEME, JSON.stringify(covered)];
  for (const name of pkg.names().filter((n) => n !== tagsPart).sort()) {
    lines.push(`${createHash('sha256').update(await pkg.read(name)).digest('hex')} ${name}`);
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Drops ShibaSlim's tags from the presentation, leaving any others alone. */
async function removeSignature(pkg: OpcPackage): Promise<void> {
  const pres = presentationPart(pkg);
  if (!pres) return;
  const xml = await readText(pkg, pres);
  const part = tagsPartOf(pkg, pres, xml);
  if (!part) return;
  let tags: [string, string][];
  try {
    tags = await readTags(pkg, part);
  } catch {
    return; // not ours to repair
  }
  const others = tags.filter(([name]) => !OWN_TAG.test(name));
  if (others.length === tags.length) return;
  const root = /<((?:[\w.-]+:)?)presentation(?=[\s>])/.exec(xml);
  writeText(pkg, part, serializeTags((root && uriOf(xml, root[1]!)) ?? NS.p[0], others));
}

function presentationPart(pkg: OpcPackage): string | null {
  return pkg.relsOf('')?.rels.find((r) => r.part && /\/officeDocument$/.test(r.type))?.part ?? null;
}

/** The part holding the presentation's tags, which <p:custDataLst><p:tags r:id> in `xml` points at. */
function tagsPartOf(pkg: OpcPackage, pres: string, xml: string): string | null {
  const ref = TAGS_REF_RE.exec(CUST_DATA_RE.exec(xml)?.[2] ?? '');
  return (ref && pkg.relsOf(pres)?.rels.find((r) => r.id === ref[1])?.part) || null;
}

async function readTags(pkg: OpcPackage, part: string): Promise<[string, string][]> {
  const root = parseXml(decodeXml(await pkg.read(part)));
  return root.children.filter((c) => c.local === 'tag').map((c) => [attr(c, 'name') ?? '', attr(c, 'val') ?? '']);
}

function serializeTags(pUri: string, tags: [string, string][]): string {
  const items = tags.map(([name, val]) => `<p:tag name="${escapeXml(name)}" val="${escapeXml(val)}"/>`).join('');
  return `${XML_HEADER}<p:tagLst xmlns:p="${pUri}">${items}</p:tagLst>`;
}

function tagsPartName(pkg: OpcPackage): string {
  for (let n = 1; ; n++) {
    const name = `ppt/tags/tag${n}.xml`;
    if (pkg.uniqueName(name) === name) return name;
  }
}

/** Adds <p:tags> to the presentation's <p:custDataLst>, creating the list where the schema wants it. */
function addTagsReference(xml: string, p: string, element: string): string {
  const list = CUST_DATA_RE.exec(xml);
  if (list) {
    // <p:tags> comes after any <p:custData> entries.
    const name = `${list[1]}custDataLst`;
    return replaceAt(xml, list.index, list[0].length, `<${name}>${list[2] ?? ''}${element}</${name}>`);
  }
  const wrapped = `<${p}custDataLst>${element}</${p}custDataLst>`;
  const pe = escapeRe(p);
  // Schema order: … custShowLst, photoAlbum, custDataLst, kinsoku, defaultTextStyle, modifyVerifier, extLst.
  const next = new RegExp(`<${pe}(?:kinsoku|defaultTextStyle|modifyVerifier)(?=[\\s/>])`).exec(xml);
  if (next) return replaceAt(xml, next.index, 0, wrapped);
  const close = lastMatch(xml, new RegExp(`</${pe}presentation\\s*>`, 'g'));
  if (!close) throw new SlimError('error.noPresentation');
  let at = close.index!;
  if (new RegExp(`</${pe}extLst\\s*>\\s*$`).test(xml.slice(0, at))) {
    const open = xml.lastIndexOf(`<${p}extLst`, at);
    if (open >= 0) at = open;
  }
  return replaceAt(xml, at, 0, wrapped);
}

// ---------- text helpers ----------

/** One line of printable text: control characters and unpaired surrogates would make the XML invalid. */
function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f￾￿]/g, ' ')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readText(pkg: OpcPackage, part: string): Promise<string> {
  return decodeXml(await pkg.read(part));
}

function writeText(pkg: OpcPackage, part: string, text: string): void {
  // A UTF-16 part was decoded into a string and goes back as UTF-8, so its declaration has to say so.
  const declared = text.replace(/^(<\?xml[^?]*?encoding\s*=\s*["'])[^"']*/, '$1UTF-8');
  pkg.write(part, Buffer.from(declared, 'utf8'));
}

/** The prefix the document binds to one of `uris` ('' for the default namespace), or null. */
function prefixFor(xml: string, uris: readonly string[]): string | null {
  for (const m of xml.matchAll(/\sxmlns(?::([\w.-]+))?\s*=\s*(["'])(.*?)\2/g)) {
    if (uris.includes(m[3]!)) return m[1] ?? '';
  }
  return null;
}

/** The namespace bound to `prefix` (written with its colon, or '' for the default namespace). */
function uriOf(xml: string, prefix: string): string | undefined {
  const name = prefix ? `xmlns:${prefix.slice(0, -1)}` : 'xmlns';
  return new RegExp(`\\s${escapeRe(name)}\\s*=\\s*(["'])(.*?)\\1`).exec(xml)?.[2];
}

function qualify(prefix: string, local: string): string {
  return prefix ? `${prefix}:${local}` : local;
}

function lastMatch(text: string, re: RegExp): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(re)) last = m as RegExpExecArray;
  return last;
}

function replaceAt(text: string, index: number, length: number, insert: string): string {
  return text.slice(0, index) + insert + text.slice(index + length);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
