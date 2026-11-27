import { presentationPart, readText, splitAttribution, writeText } from './attribution.js';
import type { OpcPackage } from './opc.js';
import { escapeXml, unescapeXml } from './xml.js';

/*
 * English names: gives everything PowerPoint lists by name the name English PowerPoint would have
 * given it, so a deck made with PowerPoint in Chinese (or another language) opens like one made in
 * English.
 *
 * - Shapes, which the selection pane lists, on slides, layouts, masters, notes pages and the notes
 *   and handout masters. A name PowerPoint gave ("矩形: 圆角 5") is translated and keeps its number
 *   ("Rectangle: Rounded Corners 5"); any other name becomes the default for the kind of shape, numbered
 *   like PowerPoint does, from the shape's id. No two shapes on one slide (or layout, or master) end
 *   up with the same name. Names starting with "!!", which Morph uses to pair shapes on purpose, stay.
 * - Layouts, themes (what the slide master is called) and sections, where they still have the name
 *   PowerPoint gave them ("1_标题幻灯片" → "1_Title Slide", "Office 主题" → "Office Theme"). Names
 *   someone chose are left alone: there is no default to go back to.
 *
 * Animations refer to shapes by id, not by name, so they are unaffected. An attribution after a name
 * (see attribution.ts) stays after the new name.
 */

export interface NamesResult {
  /** Shapes whose name changed. */
  shapes: number;
  /** Layouts whose name changed. */
  layouts: number;
  /** Themes (slide, notes and handout masters) whose name changed. */
  themes: number;
  /** Sections whose name changed. */
  sections: number;
}

type Context = 'slide' | 'layout' | 'master' | 'notes' | 'notesMaster' | 'handoutMaster';

const PML = 'application/vnd.openxmlformats-officedocument.presentationml.';
const CONTEXTS: Record<string, Context> = {
  [`${PML}slide+xml`]: 'slide',
  [`${PML}slidelayout+xml`]: 'layout',
  [`${PML}slidemaster+xml`]: 'master',
  [`${PML}notesslide+xml`]: 'notes',
  [`${PML}notesmaster+xml`]: 'notesMaster',
  [`${PML}handoutmaster+xml`]: 'handoutMaster',
};
const THEME_TYPE = 'application/vnd.openxmlformats-officedocument.theme+xml';

// ---------- what English PowerPoint calls things ----------

/** Preset geometries (ST_ShapeType) by the name PowerPoint 2016 and later give them. */
const PRESETS: Record<string, string> = {
  line: 'Straight Connector',
  lineInv: 'Straight Connector',
  triangle: 'Isosceles Triangle',
  rtTriangle: 'Right Triangle',
  rect: 'Rectangle',
  diamond: 'Diamond',
  parallelogram: 'Parallelogram',
  trapezoid: 'Trapezoid',
  nonIsoscelesTrapezoid: 'Trapezoid',
  pentagon: 'Regular Pentagon',
  hexagon: 'Hexagon',
  heptagon: 'Heptagon',
  octagon: 'Octagon',
  decagon: 'Decagon',
  dodecagon: 'Dodecagon',
  star4: 'Star: 4 Points',
  star5: 'Star: 5 Points',
  star6: 'Star: 6 Points',
  star7: 'Star: 7 Points',
  star8: 'Star: 8 Points',
  star10: 'Star: 10 Points',
  star12: 'Star: 12 Points',
  star16: 'Star: 16 Points',
  star24: 'Star: 24 Points',
  star32: 'Star: 32 Points',
  roundRect: 'Rectangle: Rounded Corners',
  round1Rect: 'Rectangle: Single Corner Rounded',
  round2SameRect: 'Rectangle: Top Corners Rounded',
  round2DiagRect: 'Rectangle: Diagonal Corners Rounded',
  snipRoundRect: 'Rectangle: Top Corners One Rounded and One Snipped',
  snip1Rect: 'Rectangle: Single Corner Snipped',
  snip2SameRect: 'Rectangle: Top Corners Snipped',
  snip2DiagRect: 'Rectangle: Diagonal Corners Snipped',
  plaque: 'Plaque',
  ellipse: 'Oval',
  teardrop: 'Teardrop',
  homePlate: 'Arrow: Pentagon',
  chevron: 'Arrow: Chevron',
  pieWedge: 'Pie Wedge',
  pie: 'Partial Circle',
  blockArc: 'Block Arc',
  donut: 'Circle: Hollow',
  noSmoking: '"Not Allowed" Symbol',
  rightArrow: 'Arrow: Right',
  leftArrow: 'Arrow: Left',
  upArrow: 'Arrow: Up',
  downArrow: 'Arrow: Down',
  stripedRightArrow: 'Arrow: Striped Right',
  notchedRightArrow: 'Arrow: Notched Right',
  bentUpArrow: 'Arrow: Bent-Up',
  leftRightArrow: 'Arrow: Left-Right',
  upDownArrow: 'Arrow: Up-Down',
  leftUpArrow: 'Arrow: Left-Up',
  leftRightUpArrow: 'Arrow: Left-Right-Up',
  quadArrow: 'Arrow: Quad',
  leftArrowCallout: 'Callout: Left Arrow',
  rightArrowCallout: 'Callout: Right Arrow',
  upArrowCallout: 'Callout: Up Arrow',
  downArrowCallout: 'Callout: Down Arrow',
  leftRightArrowCallout: 'Callout: Left-Right Arrow',
  upDownArrowCallout: 'Callout: Up-Down Arrow',
  quadArrowCallout: 'Callout: Quad Arrow',
  bentArrow: 'Arrow: Bent',
  uturnArrow: 'Arrow: U-Turn',
  circularArrow: 'Arrow: Circular',
  leftCircularArrow: 'Arrow: Circular',
  leftRightCircularArrow: 'Arrow: Circular',
  curvedRightArrow: 'Arrow: Curved Right',
  curvedLeftArrow: 'Arrow: Curved Left',
  curvedUpArrow: 'Arrow: Curved Up',
  curvedDownArrow: 'Arrow: Curved Down',
  swooshArrow: 'Arrow: Swoosh',
  cube: 'Cube',
  can: 'Cylinder',
  lightningBolt: 'Lightning Bolt',
  heart: 'Heart',
  sun: 'Sun',
  moon: 'Moon',
  smileyFace: 'Smiley Face',
  irregularSeal1: 'Explosion: 8 Points',
  irregularSeal2: 'Explosion: 14 Points',
  foldedCorner: 'Rectangle: Folded Corner',
  bevel: 'Rectangle: Beveled',
  frame: 'Frame',
  halfFrame: 'Half Frame',
  corner: 'L-Shape',
  diagStripe: 'Diagonal Stripe',
  chord: 'Chord',
  arc: 'Arc',
  leftBracket: 'Left Bracket',
  rightBracket: 'Right Bracket',
  leftBrace: 'Left Brace',
  rightBrace: 'Right Brace',
  bracketPair: 'Double Bracket',
  bracePair: 'Double Brace',
  straightConnector1: 'Straight Arrow Connector',
  bentConnector2: 'Connector: Elbow',
  bentConnector3: 'Connector: Elbow',
  bentConnector4: 'Connector: Elbow',
  bentConnector5: 'Connector: Elbow',
  curvedConnector2: 'Connector: Curved',
  curvedConnector3: 'Connector: Curved',
  curvedConnector4: 'Connector: Curved',
  curvedConnector5: 'Connector: Curved',
  callout1: 'Callout: Line with No Border',
  callout2: 'Callout: Bent Line with No Border',
  callout3: 'Callout: Double Bent Line with No Border',
  accentCallout1: 'Callout: Line with Accent Bar',
  accentCallout2: 'Callout: Bent Line with Accent Bar',
  accentCallout3: 'Callout: Double Bent Line with Accent Bar',
  borderCallout1: 'Callout: Line',
  borderCallout2: 'Callout: Bent Line',
  borderCallout3: 'Callout: Double Bent Line',
  accentBorderCallout1: 'Callout: Line with Border and Accent Bar',
  accentBorderCallout2: 'Callout: Bent Line with Border and Accent Bar',
  accentBorderCallout3: 'Callout: Double Bent Line with Border and Accent Bar',
  wedgeRectCallout: 'Speech Bubble: Rectangle',
  wedgeRoundRectCallout: 'Speech Bubble: Rectangle with Corners Rounded',
  wedgeEllipseCallout: 'Speech Bubble: Oval',
  cloudCallout: 'Thought Bubble: Cloud',
  cloud: 'Cloud',
  ribbon: 'Ribbon: Tilted Down',
  ribbon2: 'Ribbon: Tilted Up',
  ellipseRibbon: 'Ribbon: Curved and Tilted Down',
  ellipseRibbon2: 'Ribbon: Curved and Tilted Up',
  leftRightRibbon: 'Ribbon: Left-Right',
  verticalScroll: 'Scroll: Vertical',
  horizontalScroll: 'Scroll: Horizontal',
  wave: 'Wave',
  doubleWave: 'Double Wave',
  plus: 'Cross',
  flowChartProcess: 'Flowchart: Process',
  flowChartDecision: 'Flowchart: Decision',
  flowChartInputOutput: 'Flowchart: Data',
  flowChartPredefinedProcess: 'Flowchart: Predefined Process',
  flowChartInternalStorage: 'Flowchart: Internal Storage',
  flowChartDocument: 'Flowchart: Document',
  flowChartMultidocument: 'Flowchart: Multidocument',
  flowChartTerminator: 'Flowchart: Terminator',
  flowChartPreparation: 'Flowchart: Preparation',
  flowChartManualInput: 'Flowchart: Manual Input',
  flowChartManualOperation: 'Flowchart: Manual Operation',
  flowChartConnector: 'Flowchart: Connector',
  flowChartPunchedCard: 'Flowchart: Card',
  flowChartPunchedTape: 'Flowchart: Punched Tape',
  flowChartSummingJunction: 'Flowchart: Summing Junction',
  flowChartOr: 'Flowchart: Or',
  flowChartCollate: 'Flowchart: Collate',
  flowChartSort: 'Flowchart: Sort',
  flowChartExtract: 'Flowchart: Extract',
  flowChartMerge: 'Flowchart: Merge',
  flowChartOfflineStorage: 'Flowchart: Offline Storage',
  flowChartOnlineStorage: 'Flowchart: Stored Data',
  flowChartMagneticTape: 'Flowchart: Sequential Access Storage',
  flowChartMagneticDisk: 'Flowchart: Magnetic Disk',
  flowChartMagneticDrum: 'Flowchart: Direct Access Storage',
  flowChartDisplay: 'Flowchart: Display',
  flowChartDelay: 'Flowchart: Delay',
  flowChartAlternateProcess: 'Flowchart: Alternate Process',
  flowChartOffpageConnector: 'Flowchart: Off-page Connector',
  actionButtonBlank: 'Action Button: Blank',
  actionButtonHome: 'Action Button: Go Home',
  actionButtonHelp: 'Action Button: Help',
  actionButtonInformation: 'Action Button: Get Information',
  actionButtonForwardNext: 'Action Button: Go Forward or Next',
  actionButtonBackPrevious: 'Action Button: Go Back or Previous',
  actionButtonEnd: 'Action Button: Go to End',
  actionButtonBeginning: 'Action Button: Go to Beginning',
  actionButtonReturn: 'Action Button: Return',
  actionButtonDocument: 'Action Button: Document',
  actionButtonSound: 'Action Button: Sound',
  actionButtonMovie: 'Action Button: Video',
  gear6: 'Gear: 6 Teeth',
  gear9: 'Gear: 9 Teeth',
  funnel: 'Funnel',
  mathPlus: 'Plus Sign',
  mathMinus: 'Minus Sign',
  mathMultiply: 'Multiplication Sign',
  mathDivide: 'Division Sign',
  mathEqual: 'Equals',
  mathNotEqual: 'Not Equal',
  cornerTabs: 'Corner Tabs',
  squareTabs: 'Square Tabs',
  plaqueTabs: 'Plaque Tabs',
  chartX: 'Chart: X',
  chartStar: 'Chart: Star',
  chartPlus: 'Chart: Plus',
};

/** What Chinese PowerPoint calls preset geometries, where that is certain enough to translate. */
const CHINESE_PRESETS: Record<string, string> = {
  矩形: 'rect',
  '矩形: 圆角': 'roundRect',
  '矩形: 单圆角': 'round1Rect',
  '矩形: 圆顶角': 'round2SameRect',
  '矩形: 对角圆角': 'round2DiagRect',
  '矩形: 剪去单角': 'snip1Rect',
  '矩形: 剪去左右顶角': 'snip2SameRect',
  '矩形: 剪去对角': 'snip2DiagRect',
  '矩形: 折角': 'foldedCorner',
  '矩形: 棱台': 'bevel',
  缺角矩形: 'plaque',
  椭圆: 'ellipse',
  等腰三角形: 'triangle',
  直角三角形: 'rtTriangle',
  平行四边形: 'parallelogram',
  梯形: 'trapezoid',
  菱形: 'diamond',
  六边形: 'hexagon',
  七边形: 'heptagon',
  八边形: 'octagon',
  十边形: 'decagon',
  十二边形: 'dodecagon',
  不完整圆: 'pie',
  弦形: 'chord',
  泪滴形: 'teardrop',
  图文框: 'frame',
  半闭框: 'halfFrame',
  'L 形': 'corner',
  斜纹: 'diagStripe',
  十字形: 'plus',
  立方体: 'cube',
  '圆: 空心': 'donut',
  空心弧: 'blockArc',
  笑脸: 'smileyFace',
  心形: 'heart',
  闪电形: 'lightningBolt',
  太阳形: 'sun',
  新月形: 'moon',
  云形: 'cloud',
  弧形: 'arc',
  双括号: 'bracketPair',
  双大括号: 'bracePair',
  左中括号: 'leftBracket',
  右中括号: 'rightBracket',
  左大括号: 'leftBrace',
  右大括号: 'rightBrace',
  '箭头: 右': 'rightArrow',
  '箭头: 左': 'leftArrow',
  '箭头: 上': 'upArrow',
  '箭头: 下': 'downArrow',
  '箭头: 左右': 'leftRightArrow',
  '箭头: 上下': 'upDownArrow',
  '箭头: 五边形': 'homePlate',
  '箭头: V 形': 'chevron',
  加号: 'mathPlus',
  减号: 'mathMinus',
  乘号: 'mathMultiply',
  除号: 'mathDivide',
  等号: 'mathEqual',
  不等号: 'mathNotEqual',
  波形: 'wave',
  双波形: 'doubleWave',
};

/** Everything else Chinese PowerPoint names, current and older versions. */
const CHINESE_OTHERS: Record<string, string> = {
  文本框: 'TextBox',
  图片: 'Picture',
  图形: 'Graphic',
  组合: 'Group',
  图表: 'Chart',
  表格: 'Table',
  图示: 'Diagram',
  对象: 'Object',
  墨迹: 'Ink',
  '3D 模型': '3D Model',
  '任意多边形: 形状': 'Freeform: Shape',
  任意多边形: 'Freeform',
  直接连接符: 'Straight Connector',
  直接箭头连接符: 'Straight Arrow Connector',
  '连接符: 肘形': 'Connector: Elbow',
  '连接符: 曲线': 'Connector: Curved',
  肘形连接符: 'Elbow Connector',
  曲线连接符: 'Curved Connector',
  圆角矩形: 'Rounded Rectangle',
  标题: 'Title',
  副标题: 'Subtitle',
  竖排标题: 'Vertical Title',
  标题占位符: 'Title Placeholder',
  文本占位符: 'Text Placeholder',
  竖排文本占位符: 'Vertical Text Placeholder',
  竖排文字占位符: 'Vertical Text Placeholder',
  内容占位符: 'Content Placeholder',
  图片占位符: 'Picture Placeholder',
  图表占位符: 'Chart Placeholder',
  表格占位符: 'Table Placeholder',
  'SmartArt 占位符': 'SmartArt Placeholder',
  媒体占位符: 'Media Placeholder',
  剪贴画占位符: 'Clip Art Placeholder',
  日期占位符: 'Date Placeholder',
  页脚占位符: 'Footer Placeholder',
  页眉占位符: 'Header Placeholder',
  // Chinese PowerPoint really does cut the first character off this one.
  灯片编号占位符: 'Slide Number Placeholder',
  幻灯片编号占位符: 'Slide Number Placeholder',
  幻灯片图像占位符: 'Slide Image Placeholder',
  备注占位符: 'Notes Placeholder',
};

/** Names English PowerPoint gives that are not a preset's, including those of older versions. */
const ENGLISH_OTHERS = [
  'TextBox',
  'Text Box',
  'Picture',
  'Graphic',
  'Group',
  'Chart',
  'Table',
  'Diagram',
  'Object',
  'Ink',
  'Video',
  'Audio',
  '3D Model',
  'Slide Zoom',
  'Section Zoom',
  'Summary Zoom',
  'Freeform: Shape',
  'Freeform',
  'Straight Connector',
  'Straight Arrow Connector',
  'Connector: Elbow',
  'Connector: Curved',
  'Elbow Connector',
  'Curved Connector',
  'Rounded Rectangle',
  'Title',
  'Subtitle',
  'Vertical Title',
  'Title Placeholder',
  'Vertical Title Placeholder',
  'Text Placeholder',
  'Vertical Text Placeholder',
  'Content Placeholder',
  'Vertical Content Placeholder',
  'Picture Placeholder',
  'Chart Placeholder',
  'Table Placeholder',
  'SmartArt Placeholder',
  'Media Placeholder',
  'Clip Art Placeholder',
  'Online Image Placeholder',
  'Date Placeholder',
  'Footer Placeholder',
  'Header Placeholder',
  'Slide Number Placeholder',
  'Slide Image Placeholder',
  'Notes Placeholder',
];

/** A default name without its number, in any language PowerPoint wrote it in, to its English. */
const KNOWN = new Map<string, string>([
  ...Object.values(PRESETS).map((name): [string, string] => [name, name]),
  ...ENGLISH_OTHERS.map((name): [string, string] => [name, name]),
  ...Object.entries(CHINESE_PRESETS).map(([zh, prst]): [string, string] => [zh, PRESETS[prst]!]),
  ...Object.entries(CHINESE_OTHERS),
]);

/** Layouts by the names Chinese PowerPoint gives them; copies carry a "1_" in front. */
const LAYOUTS: Record<string, string> = {
  标题幻灯片: 'Title Slide',
  标题和内容: 'Title and Content',
  节标题: 'Section Header',
  两栏内容: 'Two Content',
  比较: 'Comparison',
  仅标题: 'Title Only',
  空白: 'Blank',
  内容与标题: 'Content with Caption',
  图片与标题: 'Picture with Caption',
  标题和竖排文字: 'Title and Vertical Text',
  竖排标题与文本: 'Vertical Title and Text',
  自定义版式: 'Custom Layout',
};

/** Theme names; Chinese PowerPoint ends "Office 主题" with zero-width spaces. */
const THEMES: Record<string, string> = {
  'Office 主题': 'Office Theme',
  自定义设计方案: 'Custom Design',
};

const SECTIONS: Record<string, string> = {
  默认节: 'Default Section',
  无标题节: 'Untitled Section',
};

// ---------- applying ----------

export async function useEnglishNames(pkg: OpcPackage): Promise<NamesResult> {
  const result: NamesResult = { shapes: 0, layouts: 0, themes: 0, sections: 0 };
  // Custom names renamed so far, so a shape copied to other slides under its own name gets the same
  // new name on each of them where it can, and Morph keeps pairing it.
  const custom = new Map<string, number>();
  const parts = pkg.names().sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const part of parts) {
    const type = pkg.contentType(part)?.toLowerCase() ?? '';
    const context = CONTEXTS[type];
    if (!context && type !== THEME_TYPE) continue;
    const source = await readText(pkg, part);
    const tree = parseTree(source);
    if (!tree) continue; // not well-formed enough to edit safely: left as it is
    const edits: Edit[] = [];
    if (context) {
      result.shapes += renameShapes(source, tree, context, custom, edits);
      if (context === 'layout') result.layouts += renameIn(source, tree.children.find((c) => c.local === 'cSld'), LAYOUTS, edits);
    } else if (tree.local === 'theme') {
      result.themes += renameIn(source, tree, THEMES, edits);
    }
    if (edits.length > 0) writeText(pkg, part, applyEdits(source, edits));
  }

  const pres = presentationPart(pkg);
  if (pres && pkg.has(pres)) {
    const source = await readText(pkg, pres);
    const tree = parseTree(source);
    if (tree) {
      const edits: Edit[] = [];
      for (const list of descendants(tree, 'sectionLst')) {
        for (const section of list.children) if (section.local === 'section') result.sections += renameIn(source, section, SECTIONS, edits);
      }
      if (edits.length > 0) writeText(pkg, pres, applyEdits(source, edits));
    }
  }
  return result;
}

/** Translates the name of `el` if it is one of `names`, with any "1_" copy prefix kept; 1 if it changed. */
function renameIn(source: string, el: El | undefined, names: Record<string, string>, edits: Edit[]): number {
  const name = el && attrOf(el, 'name');
  if (!el || name === undefined) return 0;
  const parts = /^(\d+_)?(.*?)[\s​]*$/s.exec(name)!;
  const english = names[parts[2]!];
  if (english === undefined) return 0;
  edits.push({ start: el.start, end: el.end, text: withName(source, el, (parts[1] ?? '') + english) });
  return 1;
}

interface Shape {
  el: El;
  cNvPr: El;
  name: string;
  /** The attribution after the name, kept after the new one. */
  suffix: string;
  id: number | null;
  /** Morph's "!!" names stay as they are. */
  fixed: boolean;
  label: string;
  /** The number the name should have; null to take one from the id. */
  number: number | null;
  /** The number is the one in the name already, which comes first when two shapes want the same name. */
  numbered: boolean;
  /** A custom name, under which the new number is remembered for its copies. */
  customKey: string | null;
  /** The shape this is another version of, in an mc:AlternateContent; it gets the same name. */
  twin: Shape | null;
  result?: string;
}

/** Renames the shapes in one slide, layout, master or notes part; returns how many changed. */
function renameShapes(source: string, tree: El, context: Context, custom: Map<string, number>, edits: Edit[]): number {
  const spTree = descendants(tree, 'spTree')[0];
  if (!spTree) return 0;
  const elements: El[] = [];
  collectShapes(spTree, elements);

  const shapes: Shape[] = [];
  const versions = new Map<El, Map<number, Shape>>();
  for (const el of elements) {
    const nv = el.children.find((c) => c.local.startsWith('nv'));
    const cNvPr = nv?.children.find((c) => c.local === 'cNvPr');
    if (!cNvPr) continue;
    const name = attrOf(cNvPr, 'name') ?? '';
    const [own, suffix] = splitAttribution(name);
    const idText = attrOf(cNvPr, 'id');
    const id = idText !== undefined && /^\d+$/.test(idText.trim()) ? Number(idText) : null;
    const shape: Shape = { el, cNvPr, name, suffix, id, fixed: own.startsWith('!!'), label: '', number: null, numbered: false, customKey: null, twin: null };

    // Every branch of an mc:AlternateContent holds the same shapes with the same ids.
    const alternates = alternatesOf(el, spTree);
    if (id !== null) {
      for (const { content, first } of alternates) {
        const twin = first ? undefined : versions.get(content)?.get(id);
        if (twin) {
          shape.twin = twin;
          break;
        }
      }
      if (!shape.twin) {
        for (const { content, first } of alternates) {
          if (!first) continue;
          let map = versions.get(content);
          if (!map) versions.set(content, (map = new Map()));
          if (!map.has(id)) map.set(id, shape);
        }
      }
    }

    if (!shape.fixed && !shape.twin) {
      const trimmed = own.trim();
      const numbered = /^(.*?)\s+(\d+)$/.exec(trimmed);
      const known = KNOWN.get(numbered ? numbered[1]! : trimmed);
      if (known) {
        shape.label = known;
        shape.number = numbered ? Number(numbered[2]) : null;
        shape.numbered = Boolean(numbered);
      } else {
        shape.label = labelFor(el, context);
        if (trimmed) {
          shape.customKey = `${shape.label}\n${trimmed}`;
          shape.number = custom.get(shape.customKey) ?? null;
        }
      }
    }
    shapes.push(shape);
  }

  // Names that stay, then names that keep the number they have, then custom names that take the
  // number they got on an earlier slide, then the number of the shape's id; whatever is left gets one
  // past every number on the slide. Within each, first come first served.
  const taken = new Set<string>(shapes.filter((s) => s.fixed).map((s) => splitAttribution(s.name)[0]));
  const open = shapes.filter((s) => !s.fixed && !s.twin);
  const fromId = (s: Shape) => (s.id !== null && s.id >= 2 ? s.id - 1 : null);
  let highest = 0;
  for (const s of open) highest = Math.max(highest, s.number ?? 0, fromId(s) ?? 0);
  const claim = (s: Shape, n: number | null) => {
    if (n === null || s.result !== undefined) return;
    const name = `${s.label} ${n}`;
    if (taken.has(name)) return;
    taken.add(name);
    s.result = name;
    if (s.customKey && !custom.has(s.customKey)) custom.set(s.customKey, n);
  };
  for (const s of open) if (s.numbered) claim(s, s.number);
  for (const s of open) claim(s, s.number);
  for (const s of open) claim(s, fromId(s));
  for (const s of open) while (s.result === undefined) claim(s, ++highest);

  let changed = 0;
  for (const s of shapes) {
    const own = s.fixed ? null : (s.twin ?? s).result;
    if (own === undefined || own === null) continue;
    const name = own + s.suffix;
    if (name === s.name) continue;
    edits.push({ start: s.cNvPr.start, end: s.cNvPr.end, text: withName(source, s.cNvPr, name) });
    if (!s.twin) changed++;
  }
  return changed;
}

const SHAPES = new Set(['sp', 'pic', 'grpSp', 'graphicFrame', 'cxnSp', 'contentPart']);

/**
 * The shapes in a shape tree, groups before what they hold. Only shapes the selection pane lists:
 * the pictures an embedded object carries inside it, for one, are not.
 */
function collectShapes(container: El, out: El[]): void {
  for (const child of container.children) {
    if (SHAPES.has(child.local)) {
      out.push(child);
      if (child.local === 'grpSp') collectShapes(child, out);
    } else if (child.local === 'AlternateContent') {
      for (const branch of child.children) if (branch.local === 'Choice' || branch.local === 'Fallback') collectShapes(branch, out);
    }
  }
}

/** The mc:AlternateContent elements a shape is in, innermost first, and whether it is in the first branch of each. */
function alternatesOf(el: El, top: El): { content: El; first: boolean }[] {
  const found: { content: El; first: boolean }[] = [];
  for (let node = el; node.parent && node !== top; node = node.parent) {
    if (node.parent.local === 'AlternateContent') found.push({ content: node.parent, first: node.parent.children[0] === node });
  }
  return found;
}

/** The name English PowerPoint gives a new shape of this kind, without the number. */
function labelFor(el: El, context: Context): string {
  const nv = el.children.find((c) => c.local.startsWith('nv'));
  const nvPr = nv?.children.find((c) => c.local === 'nvPr');
  const ph = nvPr?.children.find((c) => c.local === 'ph');
  if (ph) return placeholderLabel(attrOf(ph, 'type') ?? 'obj', attrOf(ph, 'orient') === 'vert', context);
  const spPr = el.children.find((c) => c.local === 'spPr');
  const prst = spPr?.children.find((c) => c.local === 'prstGeom');
  const preset = prst && attrOf(prst, 'prst');
  switch (el.local) {
    case 'grpSp':
      return 'Group';
    case 'contentPart':
      return 'Ink';
    case 'graphicFrame': {
      const data = el.children.find((c) => c.local === 'graphic')?.children.find((c) => c.local === 'graphicData');
      const kind = (data && attrOf(data, 'uri'))?.replace(/^.*\//, '') ?? '';
      return FRAMES[kind] ?? 'Object';
    }
    case 'pic': {
      const media = nvPr?.children.map((c) => c.local) ?? [];
      if (media.some((m) => m === 'videoFile' || m === 'quickTimeFile')) return 'Video';
      if (media.some((m) => m === 'audioFile' || m === 'wavAudioFile' || m === 'audioCd')) return 'Audio';
      const fill = el.children.find((c) => c.local === 'blipFill');
      return fill && descendants(fill, 'svgBlip').length > 0 ? 'Graphic' : 'Picture';
    }
    case 'cxnSp':
      if (!preset || preset === 'line' || preset === 'lineInv' || preset === 'straightConnector1') return lineLabel(spPr);
      return PRESETS[preset] ?? 'Straight Connector';
    default: {
      const cNvSpPr = nv?.children.find((c) => c.local === 'cNvSpPr');
      if (cNvSpPr && /^(1|true)$/.test(attrOf(cNvSpPr, 'txBox') ?? '')) return 'TextBox';
      if (preset === 'line' || preset === 'lineInv' || preset === 'straightConnector1') return lineLabel(spPr);
      if (preset) return PRESETS[preset] ?? 'Rectangle';
      return spPr?.children.some((c) => c.local === 'custGeom') ? 'Freeform: Shape' : 'Rectangle';
    }
  }
}

const FRAMES: Record<string, string> = {
  table: 'Table',
  chart: 'Chart',
  chartex: 'Chart',
  diagram: 'Diagram',
  ole: 'Object',
  model3d: '3D Model',
  slidezoom: 'Slide Zoom',
  sectionzoom: 'Section Zoom',
  summaryzoom: 'Summary Zoom',
};

/** A straight line is a connector, with "Arrow" in its name when either end has an arrowhead. */
function lineLabel(spPr: El | undefined): string {
  const ln = spPr?.children.find((c) => c.local === 'ln');
  const arrow = ln?.children.some((c) => (c.local === 'headEnd' || c.local === 'tailEnd') && (attrOf(c, 'type') ?? 'none') !== 'none');
  return arrow ? 'Straight Arrow Connector' : 'Straight Connector';
}

function placeholderLabel(type: string, vertical: boolean, context: Context): string {
  const master = context === 'master' || context === 'notesMaster' || context === 'handoutMaster';
  const v = vertical ? 'Vertical ' : '';
  switch (type) {
    case 'title':
    case 'ctrTitle':
      return master ? `${v}Title Placeholder` : `${v}Title`;
    case 'subTitle':
      return 'Subtitle';
    case 'body':
      return context === 'notes' || context === 'notesMaster' ? 'Notes Placeholder' : `${v}Text Placeholder`;
    case 'dt':
      return 'Date Placeholder';
    case 'ftr':
      return 'Footer Placeholder';
    case 'sldNum':
      return 'Slide Number Placeholder';
    case 'hdr':
      return 'Header Placeholder';
    case 'sldImg':
      return 'Slide Image Placeholder';
    case 'pic':
      return 'Picture Placeholder';
    case 'chart':
      return 'Chart Placeholder';
    case 'tbl':
      return 'Table Placeholder';
    case 'dgm':
      return 'SmartArt Placeholder';
    case 'media':
      return 'Media Placeholder';
    case 'clipArt':
      return 'Clip Art Placeholder';
    default:
      return `${v}Content Placeholder`;
  }
}

// ---------- a light XML tree that remembers where each start tag is ----------

interface El {
  local: string;
  /** Where the start tag begins and ends in the text. */
  start: number;
  end: number;
  /** Where the attributes begin, right after the element's name, and the attributes as written. */
  attrsAt: number;
  attrs: string;
  children: El[];
  parent: El | null;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const ATTRS = `(?:\\s+[^\\s=/>]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*`;
const TOKEN_RE = new RegExp(
  `<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<![^>]*>|<\\?[\\s\\S]*?\\?>|</([^\\s>]+)\\s*>|<([^\\s/>!?]+)(${ATTRS})\\s*(/?)>`,
  'g',
);
const ATTR_RE = /\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const localOf = (name: string) => name.slice(name.indexOf(':') + 1);

/** The root element, or null when the text is not well-formed enough to be sure of where things are. */
function parseTree(xml: string): El | null {
  const doc: El = { local: '', start: 0, end: 0, attrsAt: 0, attrs: '', children: [], parent: null };
  let current = doc;
  let last = 0;
  for (const m of xml.matchAll(TOKEN_RE)) {
    // A "<" that is not part of any markup recognised here means the guesses below could be wrong.
    if (xml.indexOf('<', last) < m.index) return null;
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      if (current === doc || localOf(m[1]) !== current.local) return null;
      current = current.parent!;
    } else if (m[2] !== undefined) {
      const el: El = {
        local: localOf(m[2]),
        start: m.index,
        end: last,
        attrsAt: m.index + 1 + m[2].length,
        attrs: m[3] ?? '',
        children: [],
        parent: current,
      };
      current.children.push(el);
      if (!m[4]) current = el;
    }
  }
  if (current !== doc || xml.indexOf('<', last) >= 0) return null;
  return doc.children.length === 1 ? doc.children[0]! : null;
}

function attrOf(el: El, local: string): string | undefined {
  for (const m of el.attrs.matchAll(ATTR_RE)) if (localOf(m[1]!) === local) return unescapeXml(m[2] ?? m[3] ?? '');
  return undefined;
}

function descendants(el: El, local: string): El[] {
  const found: El[] = [];
  const walk = (node: El) => {
    for (const child of node.children) {
      if (child.local === local) found.push(child);
      walk(child);
    }
  };
  walk(el);
  return found;
}

/** The start tag of `el` with its name attribute set to `name`, everything else as written. */
function withName(source: string, el: El, name: string): string {
  const tag = source.slice(el.start, el.end);
  const offset = el.attrsAt - el.start;
  const value = `"${escapeXml(name)}"`;
  for (const m of el.attrs.matchAll(ATTR_RE)) {
    if (m[1] !== 'name') continue;
    const at = offset + m.index;
    return `${tag.slice(0, at)} name=${value}${tag.slice(at + m[0].length)}`;
  }
  return `${tag.slice(0, offset)} name=${value}${tag.slice(offset)}`;
}

function applyEdits(source: string, edits: Edit[]): string {
  let text = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
