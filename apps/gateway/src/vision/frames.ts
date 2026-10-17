// Frames for the edge vision pipeline: JPEG in, grey/RGB planes out, crops back to JPEG.
// Pure JavaScript (jpeg-js) so it runs on any edge PC without native modules.
import { decode as jpegDecode, encode as jpegEncode } from 'jpeg-js';

export interface Frame {
  width: number;
  height: number;
  /** RGBA, row-major. */
  rgba: Uint8Array;
  /** When the frame was captured (ms). */
  at: number;
}

export interface GreyFrame {
  width: number;
  height: number;
  /** One byte per pixel. */
  data: Uint8Array;
}

/** Normalised box in the frame: x, y, width, height (0–1). */
export type Box = [number, number, number, number];

export function decodeJpeg(bytes: Uint8Array, at: number, maxPixels = 4_000_000): Frame {
  const d = jpegDecode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
  if (d.width * d.height > maxPixels) throw new Error(`Frame too large (${d.width}×${d.height}).`);
  return { width: d.width, height: d.height, rgba: d.data, at };
}

/** Luma plane, optionally scaled down to `width` pixels wide (box filter). */
export function toGrey(f: Frame, width = f.width): GreyFrame {
  const scale = Math.max(1, Math.round(f.width / width));
  const w = Math.floor(f.width / scale);
  const h = Math.floor(f.height / scale);
  const out = new Uint8Array(w * h);
  const n = scale * scale;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < scale; dy++) {
        let i = ((y * scale + dy) * f.width + x * scale) * 4;
        for (let dx = 0; dx < scale; dx++, i += 4) sum += (f.rgba[i] * 77 + f.rgba[i + 1] * 150 + f.rgba[i + 2] * 29) >> 8;
      }
      out[y * w + x] = sum / n;
    }
  }
  return { width: w, height: h, data: out };
}

/** Nearest-neighbour RGB resample into a WxH planar float tensor (CHW, 0–1) with letterbox padding. */
export function letterbox(f: Frame, size: number): { data: Float32Array; scale: number; padX: number; padY: number } {
  const scale = Math.min(size / f.width, size / f.height);
  const nw = Math.round(f.width * scale);
  const nh = Math.round(f.height * scale);
  const padX = Math.floor((size - nw) / 2);
  const padY = Math.floor((size - nh) / 2);
  const data = new Float32Array(3 * size * size).fill(114 / 255);
  const plane = size * size;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(f.height - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(f.width - 1, Math.floor(x / scale));
      const si = (sy * f.width + sx) * 4;
      const di = (y + padY) * size + (x + padX);
      data[di] = f.rgba[si] / 255;
      data[plane + di] = f.rgba[si + 1] / 255;
      data[2 * plane + di] = f.rgba[si + 2] / 255;
    }
  }
  return { data, scale, padX, padY };
}

/** JPEG of a region of the frame (with margin), longest side ≤ maxSide. */
export function cropJpeg(f: Frame, box: Box | undefined, opts: { maxSide?: number; quality?: number; marginFrac?: number } = {}): { mime: 'image/jpeg'; base64: string; bytes: number } {
  const maxSide = opts.maxSide ?? 640;
  const m = opts.marginFrac ?? 0.15;
  let x0 = 0;
  let y0 = 0;
  let x1 = f.width;
  let y1 = f.height;
  if (box) {
    const [bx, by, bw, bh] = box;
    x0 = Math.max(0, Math.floor((bx - bw * m) * f.width));
    y0 = Math.max(0, Math.floor((by - bh * m) * f.height));
    x1 = Math.min(f.width, Math.ceil((bx + bw * (1 + m)) * f.width));
    y1 = Math.min(f.height, Math.ceil((by + bh * (1 + m)) * f.height));
    if (x1 - x0 < 16 || y1 - y0 < 16) {
      x0 = 0;
      y0 = 0;
      x1 = f.width;
      y1 = f.height;
    }
  }
  const cw = x1 - x0;
  const ch = y1 - y0;
  const step = Math.max(1, Math.ceil(Math.max(cw, ch) / maxSide));
  const ow = Math.floor(cw / step);
  const oh = Math.floor(ch / step);
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const si = ((y0 + y * step) * f.width + (x0 + x * step)) * 4;
      const di = (y * ow + x) * 4;
      out[di] = f.rgba[si];
      out[di + 1] = f.rgba[si + 1];
      out[di + 2] = f.rgba[si + 2];
      out[di + 3] = 255;
    }
  }
  const enc = jpegEncode({ data: out, width: ow, height: oh }, opts.quality ?? 80);
  return { mime: 'image/jpeg', base64: Buffer.from(enc.data).toString('base64'), bytes: enc.data.length };
}

/** Test and demo helper: an RGBA frame painted with rectangles. */
export function paintFrame(width: number, height: number, bg: [number, number, number], rects: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }[], at = Date.now()): Frame {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }
  for (const r of rects)
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.h); y++)
      for (let x = Math.max(0, r.x); x < Math.min(width, r.x + r.w); x++) {
        const i = (y * width + x) * 4;
        rgba[i] = r.rgb[0];
        rgba[i + 1] = r.rgb[1];
        rgba[i + 2] = r.rgb[2];
      }
  return { width, height, rgba, at };
}

/** Encode a frame as JPEG bytes (tests, demo sources). */
export function encodeJpeg(f: Frame, quality = 85): Buffer {
  return Buffer.from(jpegEncode({ data: Buffer.from(f.rgba.buffer, f.rgba.byteOffset, f.rgba.byteLength), width: f.width, height: f.height }, quality).data);
}

/** Connected components over a binary mask (4-connectivity) → boxes in mask pixels. */
export function components(mask: Uint8Array, w: number, h: number, minPixels: number): { x0: number; y0: number; x1: number; y1: number; n: number; sum: number }[] {
  const seen = new Uint8Array(w * h);
  const out: { x0: number; y0: number; x1: number; y1: number; n: number; sum: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let x0 = i % w;
    let y0 = (i / w) | 0;
    let x1 = x0;
    let y1 = y0;
    let n = 0;
    let sum = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w;
      const y = (j / w) | 0;
      n++;
      sum += mask[j];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[j - 1] && !seen[j - 1]) (seen[j - 1] = 1), stack.push(j - 1);
      if (x < w - 1 && mask[j + 1] && !seen[j + 1]) (seen[j + 1] = 1), stack.push(j + 1);
      if (y > 0 && mask[j - w] && !seen[j - w]) (seen[j - w] = 1), stack.push(j - w);
      if (y < h - 1 && mask[j + w] && !seen[j + w]) (seen[j + w] = 1), stack.push(j + w);
    }
    if (n >= minPixels) out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, n, sum });
  }
  return out;
}

export const boxIoU = (a: Box, b: Box) => {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
};

/** Point-in-polygon for normalised image coordinates. */
export function inPolygon(px: number, py: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
