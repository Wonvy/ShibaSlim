import sharp from 'sharp';
import type { ImageNeed } from './usage.js';

export interface ImageSettings {
  jpegQuality: number;
  /** Palette quantisation quality for PNG (1-100); 0 keeps PNG lossless. */
  pngQuality: number;
  /** Let opaque PNG/TIFF images become JPEG when that is clearly smaller. */
  convertToJpeg: boolean;
}

export interface ImageOutcome {
  status: 'optimized' | 'kept' | 'skipped';
  note?: string;
  data?: Buffer;
  format?: 'jpeg' | 'png';
  width: number;
  height: number;
  newWidth: number;
  newHeight: number;
}

/** Extensions we attempt to process; everything else (EMF, WMF, SVG, GIF...) is left alone. */
export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'tif', 'tiff']);
export const JPEG_EXT = new Set(['jpg', 'jpeg', 'jpe', 'jfif']);
export const PNG_EXT = new Set(['png']);

/** Below this size there is nothing worth saving. */
const MIN_BYTES = 8 * 1024;
/** A re-encode must save at least this fraction; otherwise the original stays, avoiding generation loss for nothing. */
const MIN_SAVING = 0.1;
/** Downsample only when the needed size is below this fraction of the actual size. */
const RESIZE_THRESHOLD = 0.9;
/** JPEG must be this much smaller than the PNG result before a PNG is converted. */
const JPEG_ADVANTAGE = 0.8;

const INPUT = { failOn: 'error' } as const;

export async function optimizeImage(
  data: Buffer,
  need: ImageNeed | undefined,
  settings: ImageSettings,
): Promise<ImageOutcome> {
  const meta = await sharp(data, INPUT).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const unchanged = { width, height, newWidth: width, newHeight: height };

  if (need?.noTouch) return { status: 'skipped', note: '使用了“设置透明色”，需保持像素不变', ...unchanged };
  if (data.length < MIN_BYTES) return { status: 'kept', note: '文件很小', ...unchanged };
  if (!width || !height) return { status: 'skipped', note: '无法读取尺寸', ...unchanged };
  if (meta.format !== 'jpeg' && meta.format !== 'png' && meta.format !== 'tiff') {
    return { status: 'skipped', note: `不处理 ${meta.format ?? '未知'} 格式`, ...unchanged };
  }
  if ((meta.pages ?? 1) > 1) return { status: 'skipped', note: '多帧图片', ...unchanged };

  const orientation = meta.orientation ?? 1;
  let scale = 1;
  if (need && !need.noResize) {
    let wanted = Math.max(need.width / width, need.height / height);
    // Orientations 5-8 swap the axes for viewers that honour EXIF; cover both readings.
    if (orientation >= 5) wanted = Math.max(wanted, need.width / height, need.height / width);
    if (wanted < RESIZE_THRESHOLD) scale = wanted;
  }
  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));
  const pipeline = () => {
    const image = sharp(data, INPUT);
    return scale < 1 ? image.resize(newWidth, newHeight, { fit: 'fill' }) : image;
  };

  let best: { data: Buffer; format: 'jpeg' | 'png' };
  if (meta.format === 'jpeg') {
    // Matching the source's chroma sampling keeps a second run from finding "savings" in
    // an image this tool already produced, which would degrade it a little more every time.
    const chromaSubsampling = meta.chromaSubsampling === '4:4:4' ? '4:4:4' : '4:2:0';
    let image = pipeline().jpeg({ quality: settings.jpegQuality, mozjpeg: true, chromaSubsampling });
    // Pixels stay in their stored orientation, so the tag has to survive the metadata strip.
    if (orientation > 1) image = image.withExif({ IFD0: { Orientation: String(orientation) } });
    best = { data: await image.toBuffer(), format: 'jpeg' };
  } else {
    const opaque = !meta.hasAlpha || (await sharp(data, INPUT).stats()).isOpaque;
    best = { data: await encodePng(pipeline, settings.pngQuality), format: 'png' };
    if (opaque && settings.convertToJpeg) {
      // 4:4:4 keeps coloured text and thin lines crisp, which matters for screenshots.
      const jpeg = await pipeline()
        .removeAlpha()
        .jpeg({ quality: settings.jpegQuality, mozjpeg: true, chromaSubsampling: '4:4:4' })
        .toBuffer();
      if (jpeg.length < best.data.length * JPEG_ADVANTAGE) best = { data: jpeg, format: 'jpeg' };
    }
  }

  if (best.data.length > data.length * (1 - MIN_SAVING)) {
    return { status: 'kept', note: '已足够小', ...unchanged };
  }
  return { status: 'optimized', data: best.data, format: best.format, width, height, newWidth, newHeight };
}

async function encodePng(pipeline: () => ReturnType<typeof sharp>, quality: number): Promise<Buffer> {
  if (quality > 0) {
    return pipeline().png({ palette: true, quality, compressionLevel: 9, effort: 8 }).toBuffer();
  }
  // Lossless: which row filter wins depends on the image, so try both.
  const [adaptive, plain] = await Promise.all([
    pipeline().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
    pipeline().png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer(),
  ]);
  return adaptive.length <= plain.length ? adaptive : plain;
}
