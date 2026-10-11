import sharp, { type Metadata } from 'sharp';

sharp.cache(false);
sharp.concurrency(2);

/** Formats that browsers render natively. Anything else is rejected rather than served as an opaque file. */
const FORMATS: Record<string, { ext: string; mime: string }> = {
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  png: { ext: 'png', mime: 'image/png' },
  gif: { ext: 'gif', mime: 'image/gif' },
  webp: { ext: 'webp', mime: 'image/webp' },
  avif: { ext: 'avif', mime: 'image/avif' },
};

const THUMB_WIDTH = 640;
/** Very tall images (long screenshots) are cropped from the top so thumbnails stay light. */
const THUMB_MAX_RATIO = 3;
/** Above this many decoded pixels across all frames, animated thumbnails fall back to the first frame. */
const ANIMATED_THUMB_PIXEL_BUDGET = 40_000_000;
const MAX_INPUT_PIXELS = 120_000_000;

export class UnsupportedImageError extends Error {}

export interface ProcessedImage {
  ext: string;
  mime: string;
  width: number;
  height: number;
  thumbnail: Buffer;
}

function detectFormat(meta: Metadata): { ext: string; mime: string } | undefined {
  if (meta.format === 'heif') return meta.compression === 'av1' ? FORMATS.avif : undefined;
  return FORMATS[meta.format];
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new UnsupportedImageError('Unrecognised image data');
  }

  const format = detectFormat(meta);
  if (!format || !meta.width || !meta.height) {
    throw new UnsupportedImageError(`Unsupported format: ${meta.format}`);
  }

  const pages = meta.pages ?? 1;
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.pageHeight ?? meta.autoOrient?.height ?? meta.height;
  const animated = pages > 1 && width * height * pages <= ANIMATED_THUMB_PIXEL_BUDGET;

  const targetWidth = Math.min(THUMB_WIDTH, width);
  const targetHeight = Math.max(1, Math.round(Math.min(height / width, THUMB_MAX_RATIO) * targetWidth));

  let pipeline = sharp(input, { animated, limitInputPixels: MAX_INPUT_PIXELS, failOn: 'none' });
  if (!animated) pipeline = pipeline.autoOrient();

  try {
    const thumbnail = await pipeline
      .resize({ width: targetWidth, height: targetHeight, fit: 'cover', position: 'top' })
      .webp({ quality: 76, effort: 4, smartSubsample: true })
      .toBuffer();
    return { ...format, width, height, thumbnail };
  } catch {
    throw new UnsupportedImageError('Image could not be decoded');
  }
}
