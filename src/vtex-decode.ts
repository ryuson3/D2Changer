/* The pixels of a compiled Source 2 texture (.vtex_c), for the 3D preview.
 *
 * Layout, measured over the installed game (QoP's textures, 2026-10): the resource's DATA block holds
 * the header (width, height, format, mip count at fixed places), and the pixels follow the resource
 * part of the file, from where the file's first u32 says. DXT1 (BC1), DXT5 (BC3) and RGBA8888 are the
 * formats the hero textures come in; any other format returns null rather than a guess (the preview
 * then shows the model in one colour). Mips are stored one after another, and the one wanted here is the
 * largest, or the biggest one that fits the size asked for.
 */
import { resourceBlocks } from './resource.ts';

export interface Pixels { width: number; height: number; rgba: Buffer }

const FORMAT = { DXT1: 1, DXT5: 2, RGBA8888: 4 } as const;

const rgb565 = (v: number): [number, number, number] => [
  ((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31,
];

/** One 8-byte colour block (BC1, and the colour half of BC3) written into `out` as 4x4 pixels. */
function colourBlock(src: Buffer, at: number, out: Buffer, x0: number, y0: number, width: number, height: number, opaque: boolean): void {
  const c0 = src.readUInt16LE(at), c1 = src.readUInt16LE(at + 2);
  const a = rgb565(c0), b = rgb565(c1);
  const pal: number[][] = [[...a, 255], [...b, 255], [], []];
  if (c0 > c1 || !opaque) {
    pal[2] = [(2 * a[0] + b[0]) / 3, (2 * a[1] + b[1]) / 3, (2 * a[2] + b[2]) / 3, 255];
    pal[3] = [(a[0] + 2 * b[0]) / 3, (a[1] + 2 * b[1]) / 3, (a[2] + 2 * b[2]) / 3, 255];
  } else {
    pal[2] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 255];
    pal[3] = [0, 0, 0, 0];
  }
  const bits = src.readUInt32LE(at + 4);
  for (let i = 0; i < 16; i++) {
    const x = x0 + (i & 3), y = y0 + (i >> 2);
    if (x >= width || y >= height) continue;
    const p = pal[(bits >>> (2 * i)) & 3];
    const o = (y * width + x) * 4;
    out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2];
    if (opaque) out[o + 3] = p[3];
  }
}

/** The alpha half of a BC3 block (8 bytes) written into `out`. */
function alphaBlock(src: Buffer, at: number, out: Buffer, x0: number, y0: number, width: number, height: number): void {
  const a0 = src[at], a1 = src[at + 1];
  const pal = [a0, a1, 0, 0, 0, 0, 0, 255];
  if (a0 > a1) for (let k = 1; k <= 6; k++) pal[1 + k] = ((7 - k) * a0 + k * a1) / 7;
  else { for (let k = 1; k <= 4; k++) pal[1 + k] = ((5 - k) * a0 + k * a1) / 5; pal[6] = 0; pal[7] = 255; }
  let bits = 0n;
  for (let k = 5; k >= 0; k--) bits = (bits << 8n) | BigInt(src[at + 2 + k]);
  for (let i = 0; i < 16; i++) {
    const x = x0 + (i & 3), y = y0 + (i >> 2);
    if (x >= width || y >= height) continue;
    out[(y * width + x) * 4 + 3] = pal[Number((bits >> BigInt(3 * i)) & 7n)];
  }
}

/** Bytes of one mip of the given format. */
function mipSize(format: number, w: number, h: number): number {
  if (format === FORMAT.RGBA8888) return w * h * 4;
  const blocks = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4));
  return blocks * (format === FORMAT.DXT1 ? 8 : 16);
}

/**
 * @param file contents of a .vtex_c
 * @param maxDim the largest side wanted: a smaller mip is read when the picture is bigger than that
 * @returns the mip as RGBA, or null for a format that is not read here
 */
export function decodeVtex(file: Buffer, maxDim = Infinity): Pixels | null {
  let data: Buffer;
  try {
    const d = resourceBlocks(file).find((b) => b.name === 'DATA');
    if (!d) return null;
    data = file.subarray(d.at, d.at + d.size);
  } catch { return null; }
  if (data.length < 28) return null;
  const fullW = data.readUInt16LE(20), fullH = data.readUInt16LE(22), format = data[26], mips = Math.max(1, data[27]);
  if (!fullW || !fullH || data.readUInt16LE(24) > 1) return null;
  if (format !== FORMAT.DXT1 && format !== FORMAT.DXT5 && format !== FORMAT.RGBA8888) return null;

  // the pixels follow the resource part of the file
  const start = file.readUInt32LE(0);
  // the mips are stored smallest first; level 0 is the largest, and the one wanted is the first that fits maxDim
  let level = 0;
  while (level < mips - 1 && Math.max(fullW, fullH) >> level > maxDim) level++;
  const width = Math.max(1, fullW >> level), height = Math.max(1, fullH >> level);
  let before = 0;
  for (let m = mips - 1; m > level; m--) before += mipSize(format, Math.max(1, fullW >> m), Math.max(1, fullH >> m));
  const at = start + before;
  const size = mipSize(format, width, height);
  if (at + size > file.length) return null;

  const rgba = Buffer.alloc(width * height * 4, 255);
  if (format === FORMAT.RGBA8888) { file.copy(rgba, 0, at, at + size); return { width, height, rgba }; }
  const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4);
  const step = format === FORMAT.DXT1 ? 8 : 16;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const p = at + (by * bw + bx) * step;
      if (format === FORMAT.DXT1) colourBlock(file, p, rgba, bx * 4, by * 4, width, height, true);
      else { colourBlock(file, p + 8, rgba, bx * 4, by * 4, width, height, false); alphaBlock(file, p, rgba, bx * 4, by * 4, width, height); }
    }
  }
  return { width, height, rgba };
}
