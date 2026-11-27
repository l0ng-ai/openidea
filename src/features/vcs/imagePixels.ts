export interface ImageSize {
  width: number;
  height: number;
}

export interface PixelImage extends ImageSize {
  data: Uint8ClampedArray;
}

export function imageBounds(sizes: readonly ImageSize[]): ImageSize {
  return {
    width: Math.max(0, ...sizes.map((size) => size.width)),
    height: Math.max(0, ...sizes.map((size) => size.height)),
  };
}

export function canComparePixels({ width, height }: ImageSize): boolean {
  return width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 8_388_608;
}

function rgbaWords(frame: PixelImage | null) {
  const data = frame?.data;
  return data && new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
}

/** The mask has the enclosing dimensions. Coordinates are anchored at the top left of each revision. */
export function paintPixelDifference(before: PixelImage | null, after: PixelImage | null, mask: PixelImage): number {
  let changed = 0;
  const a = rgbaWords(before);
  const b = rgbaWords(after);
  const out = mask.data;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const i = 4 * (y * mask.width + x);
      const left = before && x < before.width && y < before.height ? y * before.width + x : -1;
      const right = after && x < after.width && y < after.height ? y * after.width + x : -1;
      if (left < 0 && right < 0) continue;
      if (after && a?.[left] === b?.[right]) {
        const offset = 4 * right;
        const rgba = after.data;
        const luminance = (rgba[offset]! + 2 * rgba[offset + 1]! + rgba[offset + 2]!) / 4;
        const gray = 90 + luminance * 0.4;
        out[i] = gray;
        out[i + 1] = gray;
        out[i + 2] = gray;
        out[i + 3] = rgba[offset + 3]!;
      } else {
        changed++;
        out[i] = 240;
        out[i + 1] = 48;
        out[i + 2] = 141;
        out[i + 3] = 255;
      }
    }
  }
  return changed;
}
