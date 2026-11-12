/* The meshes of a compiled Source 2 model (.vmdl_c), for the 3D preview.
 *
 * What a model holds (measured over QoP's models, 2026-10): its resource blocks come as pairs, MDAT
 * (KV3: the draw calls) then MBUF (the vertex and index buffers), one pair per mesh; the model's DATA
 * block says in m_refLODGroupMasks which pair is which level of detail. Wearables share their hero's
 * skeleton, so every mesh is already in the hero's model space in its bind pose: a hero and its items
 * can be drawn together with no skinning at all.
 *
 * MBUF layout: u32 offset+count of the vertex-buffer list (offset from the start of the block), then
 * the same for the index-buffer list (offset from its own field). A vertex buffer is
 * {count, stride, layoutOffset(from its field), layoutCount, dataOffset(from its field), dataSize}
 * and an index buffer {count, stride, 0, 0, dataOffset(from its field), dataSize}. A layout entry is
 * 56 bytes: name[32], semantic index, DXGI format, offset, slot, slot type, step rate. A buffer whose
 * dataSize is smaller than count*stride is meshopt-compressed; it is decoded with the `meshoptimizer`
 * package (checked on QoP's second level of detail: the positions come out inside the first level's
 * bounds and every index is below the vertex count). Without the package such a mesh is left out.
 */
import { resourceBlocks } from './resource.ts';
import { readKv3, numberOf } from './kv3.ts';
import type { Kv3Block, Kv3Node } from './kv3.ts';

/** The meshopt decoder, once loadMeshopt has found it. */
let meshopt: { decodeVertexBuffer(t: Uint8Array, count: number, size: number, src: Uint8Array): void; decodeIndexBuffer(t: Uint8Array, count: number, size: number, src: Uint8Array): void } | null = null;

/** Get the meshopt decoder ready (it is a small wasm module); false when the package is not installed. */
export async function loadMeshopt(): Promise<boolean> {
  if (meshopt) return true;
  try {
    const m = await import('meshoptimizer/decoder');
    await m.MeshoptDecoder.ready;
    meshopt = m.MeshoptDecoder;
    return true;
  } catch { return false; }
}

export interface MeshPart {
  /** x y z per vertex, model space */ positions: Float32Array;
  /** u v per vertex (zeros when the mesh has none) */ uvs: Float32Array;
  /** x y z per vertex, or null when the mesh stores them packed */ normals: Float32Array | null;
  /** triangles, three indices each, into the arrays above */ indices: Uint32Array;
  /** the material file the draw call names, e.g. materials/models/x.vmat */ material: string;
  /** what each vertex is skinned to, when the mesh stores it (src/anim.ts poses by it) */ skin?: MeshSkin;
}

/** Up to four bones per vertex: indices into the model's own skeleton (65535 for none) and their weights. */
export interface MeshSkin { bones: Uint16Array; weights: Float32Array }

/** A KV3 node as plain JS values. */
export function kv3Plain(kv: Kv3Block, n: Kv3Node): any {
  switch (n.kind) {
    case 'object': return Object.fromEntries([...n.members].map(([k, v]) => [k, kv3Plain(kv, v)]));
    case 'array': return n.items.map((x) => kv3Plain(kv, x));
    case 'number': return numberOf(kv, n);
    case 'string': return n.value;
    case 'blob': return null;
    default: return (n as { value?: number }).value ?? null;
  }
}

const DXGI = { R32G32B32_FLOAT: 6, R16G16_FLOAT: 34, R16G16_SNORM: 37, R8G8B8A8_UNORM: 28 };

export function half(v: number): number {
  const s = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 31, m = v & 1023;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

interface Layout { name: string; index: number; format: number; offset: number }
interface VBuf { count: number; stride: number; layout: Layout[]; data: Buffer; compressed: boolean }
interface IBuf { count: number; stride: number; data: Buffer; compressed: boolean }

function readMbuf(d: Buffer): { vertex: VBuf[]; index: IBuf[] } {
  const vertex: VBuf[] = [], index: IBuf[] = [];
  const vbAt = d.readUInt32LE(0), vbN = d.readUInt32LE(4);
  const ibAt = 8 + d.readUInt32LE(8), ibN = d.readUInt32LE(12);
  for (let i = 0; i < vbN; i++) {
    const o = vbAt + i * 24;
    const count = d.readUInt32LE(o), stride = d.readUInt32LE(o + 4);
    const lo = o + 8 + d.readUInt32LE(o + 8), ln = d.readUInt32LE(o + 12);
    const at = o + 16 + d.readUInt32LE(o + 16), size = d.readUInt32LE(o + 20);
    const layout: Layout[] = [];
    for (let k = 0; k < ln; k++) {
      const a = lo + k * 56;
      layout.push({ name: d.toString('latin1', a, a + 32).replace(/\0[\s\S]*$/, ''), index: d.readUInt32LE(a + 32), format: d.readUInt32LE(a + 36), offset: d.readUInt32LE(a + 40) });
    }
    vertex.push({ count, stride, layout, data: d.subarray(at, at + size), compressed: size !== count * stride });
  }
  for (let i = 0; i < ibN; i++) {
    const o = ibAt + i * 24;
    const count = d.readUInt32LE(o), stride = d.readUInt32LE(o + 4);
    const at = o + 16 + d.readUInt32LE(o + 16), size = d.readUInt32LE(o + 20);
    index.push({ count, stride, data: d.subarray(at, at + size), compressed: size !== count * stride });
  }
  return { vertex, index };
}

/** A buffer the CTRL block describes (count, element size, layout) whose bytes are in a block of their own. */
function bufferOf(d: any, block: { at: number; size: number } | undefined, file: Buffer, vertex = true): VBuf | IBuf {
  if (!block) throw new Error('у буфера нет блока');
  const count = Number(d.m_nElementCount), stride = Number(d.m_nElementSizeInBytes);
  const data = file.subarray(block.at, block.at + block.size);
  const compressed = data.length !== count * stride;
  if (!vertex) return { count, stride, data, compressed };
  const layout: Layout[] = (d.m_inputLayoutFields ?? []).map((l: any) => ({
    name: String(l.m_pSemanticName ?? '').toUpperCase(), index: Number(l.m_nSemanticIndex), format: Number(l.m_Format), offset: Number(l.m_nOffset),
  }));
  return { count, stride, layout, data, compressed };
}

/** The vertex bytes of a buffer, decoded when it is compressed; null when they cannot be. */
function vertexBytes(vb: VBuf): Buffer | null {
  if (!vb.compressed) return vb.data;
  if (!meshopt) return null;
  const out = new Uint8Array(vb.count * vb.stride);
  meshopt.decodeVertexBuffer(out, vb.count, vb.stride, new Uint8Array(vb.data));
  return Buffer.from(out.buffer);
}
function indexBytes(ib: IBuf): Buffer | null {
  if (!ib.compressed) return ib.data;
  if (!meshopt) return null;
  const out = new Uint8Array(ib.count * ib.stride);
  meshopt.decodeIndexBuffer(out, ib.count, ib.stride, new Uint8Array(ib.data));
  return Buffer.from(out.buffer);
}

/** One vertex attribute as floats (`width` per vertex), or null when it is missing or in a format not read. */
function attribute(vb: VBuf, data: Buffer, name: string, width: number): Float32Array | null {
  const a = vb.layout.find((l) => l.name === name && l.index === 0);
  if (!a) return null;
  const out = new Float32Array(vb.count * width);
  for (let v = 0; v < vb.count; v++) {
    const p = v * vb.stride + a.offset;
    switch (a.format) {
      case DXGI.R32G32B32_FLOAT: for (let k = 0; k < width; k++) out[v * width + k] = data.readFloatLE(p + 4 * k); break;
      case DXGI.R16G16_FLOAT: for (let k = 0; k < width; k++) out[v * width + k] = half(data.readUInt16LE(p + 2 * k)); break;
      case DXGI.R16G16_SNORM: for (let k = 0; k < width; k++) out[v * width + k] = Math.max(-1, data.readInt16LE(p + 2 * k) / 32767); break;
      case DXGI.R8G8B8A8_UNORM: for (let k = 0; k < width; k++) out[v * width + k] = data[p + k] / 255 * 2 - 1; break;
      default: return null;
    }
  }
  return out;
}

/** Reads another file of the game by its compiled path (with _c); null when there is none. */
export type Resolve = (path: string) => Buffer | null;

/** One mesh of a model: its draw calls (a KV3 block) and its buffers (an MBUF or VBIB block). */
interface MeshSource { kv: Buffer; bufs: () => { vertex: VBuf[]; index: IBuf[] }; /** the mesh's place in the model's list, which the bone remap table is indexed by */ index: number }

/**
 * Where the meshes of a model are, at the level of detail asked for. Most models carry them inside
 * (pairs of MDAT and MBUF blocks, and the model's DATA says in m_refLODGroupMasks which is which);
 * a model can instead name separate .vmesh files in m_refMeshes, whose own DATA and buffers hold them.
 */
function meshSources(file: Buffer, lod: number, reasons: string[], resolve?: Resolve): MeshSource[] {
  const blocks = resourceBlocks(file);
  const mdat = blocks.filter((b) => b.name === 'MDAT');
  const mbuf = blocks.filter((b) => b.name === 'MBUF');
  const slice = (b: { at: number; size: number }, f = file) => f.subarray(b.at, b.at + b.size);
  let refs: string[] = [], masks: number[] | undefined;
  const dataBlock = blocks.find((b) => b.name === 'DATA');
  if (dataBlock) {
    try {
      const kv = readKv3(slice(dataBlock));
      const plain = kv3Plain(kv, kv.root);
      refs = (plain.m_refMeshes as string[] | undefined) ?? [];
      masks = plain.m_refLODGroupMasks as number[] | undefined;
    } catch (e) { reasons.push(`DATA модели не прочитался (${(e as Error).message})`); }
  }
  const out: MeshSource[] = [];
  // the newer layout: the CTRL block lists the embedded meshes, each with its MDAT block and its buffers in MVTX and MIDX blocks
  const ctrl = blocks.find((b) => b.name === 'CTRL');
  if (ctrl) {
    try {
      const ckv = readKv3(slice(ctrl));
      const embedded = (kv3Plain(ckv, ckv.root).embedded_meshes as any[] | undefined) ?? [];
      if (embedded.some((e) => Array.isArray(e.m_vertexBuffers) && e.m_vertexBuffers.length)) {
        for (const e of embedded) {
          const mask = masks && masks[e.m_nMeshIndex] !== undefined ? masks[e.m_nMeshIndex] : (e.m_nMeshIndex === 0 ? 1 : 0);
          if (!(mask & lod)) continue;
          const dataBlock = blocks[e.m_nDataBlock];
          if (!dataBlock) { reasons.push(`у меша ${e.m_Name} нет блока данных`); continue; }
          out.push({ index: e.m_nMeshIndex ?? out.length, kv: slice(dataBlock), bufs: () => ({
            vertex: (e.m_vertexBuffers as any[]).map((vb) => bufferOf(vb, blocks[vb.m_nBlockIndex], file) as VBuf),
            index: (e.m_indexBuffers as any[]).map((ib) => bufferOf(ib, blocks[ib.m_nBlockIndex], file, false) as IBuf),
          }) });
        }
        return out;
      }
    } catch (e) { reasons.push(`CTRL не прочитался (${(e as Error).message})`); }
  }
  if (refs.length) {
    let inside = 0;
    refs.forEach((name, i) => {
      if (masks && masks[i] !== undefined && !(masks[i] & lod)) { if (!name) inside++; return; }
      if (!name) {
        if (mdat[inside] && mbuf[inside]) { const kvb = slice(mdat[inside]), bb = slice(mbuf[inside]); out.push({ index: i, kv: kvb, bufs: () => readMbuf(bb) }); }
        inside++;
        return;
      }
      const vm = resolve?.(`${name}_c`);
      if (!vm) { reasons.push(`внешний меш ${name}: ${resolve ? 'файла нет в игре' : 'нет доступа к файлам'}`); return; }
      const vb = resourceBlocks(vm);
      const kv = vb.find((b) => b.name === 'DATA'), buf = vb.find((b) => b.name === 'MBUF' || b.name === 'VBIB');
      if (!kv || !buf) { reasons.push(`внешний меш ${name}: блоки ${vb.map((b) => b.name).join(',')}`); return; }
      { const kvb = slice(kv, vm), bb = slice(buf, vm); out.push({ index: i, kv: kvb, bufs: () => readMbuf(bb) }); }
    });
    return out;
  }
  if (!mdat.length || mdat.length !== mbuf.length) {
    reasons.push(`блоки меша: MDAT ${mdat.length}, MBUF ${mbuf.length}; в файле есть: ${blocks.map((b) => `${b.name}:${b.size}`).join(' ')}`);
    return [];
  }
  // no list of meshes: the pairs are levels of detail when the masks say so, and otherwise the first pair is the model
  const pick = masks && masks.length === mdat.length ? masks.map((m, i) => (m & lod ? i : -1)).filter((i) => i >= 0) : [0];
  for (const i of pick) { const kvb = slice(mdat[i]), bb = slice(mbuf[i]); out.push({ index: i, kv: kvb, bufs: () => readMbuf(bb) }); }
  return out;
}

/**
 * The meshes of a model at its first level of detail, one part per draw call. A model with no mesh in
 * it (one that only includes others) gives none, and `reasons` says why.
 */
export function readModelMeshes(file: Buffer, reasons: string[] = [], lod = 1, resolve?: Resolve): MeshPart[] {
  const sources = meshSources(file, lod, reasons, resolve);
  const remap = boneRemap(file);
  const parts: MeshPart[] = [];
  for (const src of sources) {
    let mesh, vertex, index;
    try {
      const kv = readKv3(src.kv);
      mesh = kv3Plain(kv, kv.root);
      ({ vertex, index } = src.bufs());
    } catch (e) { reasons.push(`меш не прочитался (${(e as Error).message})`); continue; }
    for (const so of mesh.m_sceneObjects ?? []) {
      for (const dc of so.m_drawCalls ?? []) {
        if (dc.m_nPrimitiveType !== 'RENDER_PRIM_TRIANGLES') { reasons.push(`тип примитивов ${dc.m_nPrimitiveType}`); continue; }
        const vb = vertex[dc.m_vertexBuffers?.[0]?.m_hBuffer ?? 0], ib = index[dc.m_indexBuffer?.m_hBuffer ?? 0];
        if (!vb || !ib) { reasons.push('у вызова отрисовки нет буфера'); continue; }
        let vdata: Buffer | null = null, idata: Buffer | null = null;
        try { vdata = vertexBytes(vb); idata = indexBytes(ib); } catch (e) { reasons.push(`буфер не распаковался (${(e as Error).message})`); continue; }
        if (!vdata || !idata) { reasons.push('буферы сжаты, а распаковщика нет (нужен npm install)'); continue; }
        const positions = attribute(vb, vdata, 'POSITION', 3);
        if (!positions) { const a = vb.layout.find((l) => l.name === 'POSITION'); reasons.push(a ? `формат вершин POSITION ${a.format}` : 'нет POSITION'); continue; }
        const uvs = attribute(vb, vdata, 'TEXCOORD', 2) ?? new Float32Array(vb.count * 2);
        const normals = attribute(vb, vdata, 'NORMAL', 3);
        const n = dc.m_nIndexCount - (dc.m_nIndexCount % 3);
        const indices = new Uint32Array(n);
        for (let k = 0; k < n; k++) {
          const at = (dc.m_nStartIndex + k) * ib.stride;
          indices[k] = dc.m_nBaseVertex + (ib.stride === 2 ? idata.readUInt16LE(at) : idata.readUInt32LE(at));
        }
        let skin: MeshSkin | undefined;
        try { skin = skinOf(vb, vdata, remap, src.index) ?? undefined; } catch { /* drawn unposed */ }
        parts.push({ positions, uvs, normals, indices, material: dc.m_material ?? '', skin });
      }
    }
  }
  if (!parts.length && !reasons.length) reasons.push("в модели нет вызовов отрисовки");
  return parts;
}

/**
 * The bones the first mesh of a model is skinned to: name (lower case) to the 3x4 matrix (12 numbers, rows)
 * that takes model space to that bone's space in the bind pose. What a wearable has in common with its hero.
 */
export function readModelBones(file: Buffer, resolve?: Resolve): Map<string, number[]> {
  const out = new Map<string, number[]>();
  try {
    const src = meshSources(file, 1, [], resolve)[0];
    if (!src) return out;
    const kv = readKv3(src.kv);
    const bones = kv3Plain(kv, kv.root).m_skeleton?.m_bones as { m_boneName: string; m_invBindPose: number[] }[] | undefined;
    for (const b of bones ?? []) out.set(String(b.m_boneName).toLowerCase(), b.m_invBindPose);
  } catch { /* none */ }
  return out;
}

/** An attachment point (attach_hitloc, attach_weapon): the bones it follows and where it sits from each, in that bone's space. */
export interface ModelAttachment { name: string; bones: string[]; offsets: number[][]; weights: number[]; root: boolean[] }

/** A model's attachment points, out of its meshes' data (where the game keeps them), the first of each name. */
export function readModelAttachments(file: Buffer, resolve?: Resolve): ModelAttachment[] {
  const out: ModelAttachment[] = [];
  let sources: MeshSource[] = [];
  try { sources = meshSources(file, 1, [], resolve); } catch { return out; }
  for (const src of sources) {
    let list: any[] = [];
    try { const kv = readKv3(src.kv); list = kv3Plain(kv, kv.root).m_attachments ?? []; } catch { continue; }
    for (const a of Array.isArray(list) ? list : []) {
      const v = a?.value ?? a;
      const name = String(a?.key || v?.m_name || '').toLowerCase();
      const n = Math.max(1, Number(v?.m_nInfluences ?? 1));
      const bones = (Array.isArray(v?.m_influenceNames) ? v.m_influenceNames : []).slice(0, n).map((b: unknown) => String(b).toLowerCase());
      if (!name || !bones.length || out.some((x) => x.name === name)) continue;
      out.push({
        name, bones,
        offsets: bones.map((_: string, i: number) => (Array.isArray(v.m_vInfluenceOffsets?.[i]) ? v.m_vInfluenceOffsets[i] : [0, 0, 0])),
        weights: bones.map((_: string, i: number) => Number(v.m_influenceWeights?.[i] ?? (i === 0 ? 1 : 0))),
        root: bones.map((_: string, i: number) => !!v.m_bInfluenceRootTransform?.[i]),
      });
    }
  }
  return out;
}

/** The model's DATA block as plain values (kept per file: the meshes, the skeleton and the remap table all read it). */
const dataCache = new WeakMap<Buffer, any>();
export function readModelData(file: Buffer): any {
  if (dataCache.has(file)) return dataCache.get(file);
  let plain: any = {};
  try {
    const d = resourceBlocks(file).find((b) => b.name === 'DATA');
    if (d) { const kv = readKv3(file.subarray(d.at, d.at + d.size)); plain = kv3Plain(kv, kv.root); }
  } catch { /* none */ }
  dataCache.set(file, plain);
  return plain;
}

/** The bones of a model as its DATA lists them: names (lower case), parents (-1 for a root), and each bone's place in its parent. */
export interface ModelSkeleton { names: string[]; parent: number[]; pos: number[][]; rot: number[][] }
export function readModelSkeleton(file: Buffer): ModelSkeleton | null {
  const sk = readModelData(file).m_modelSkeleton;
  if (!sk || !Array.isArray(sk.m_boneName) || !sk.m_boneName.length) return null;
  const n = sk.m_boneName.length;
  if (!Array.isArray(sk.m_bonePosParent) || !Array.isArray(sk.m_boneRotParent) || sk.m_bonePosParent.length < n || sk.m_boneRotParent.length < n) return null;
  return {
    names: sk.m_boneName.map((x: string) => String(x).toLowerCase()),
    parent: Array.from({ length: n }, (_, i) => Number(sk.m_nParent?.[i] ?? -1)),
    pos: sk.m_bonePosParent.slice(0, n), rot: sk.m_boneRotParent.slice(0, n),
  };
}

/** The table that turns the bone numbers a mesh's vertices carry into the model skeleton's: its slice for mesh `index`, or null when there is none. */
function boneRemap(file: Buffer): { table: number[]; starts: number[] } | null {
  const d = readModelData(file);
  const table = d.m_remappingTable, starts = d.m_remappingTableStarts;
  return Array.isArray(table) && Array.isArray(starts) && starts.length ? { table, starts } : null;
}

const SKIN = { R8G8B8A8_UNORM: 28, R8G8B8A8_UINT: 30, R16G16_UNORM: 35, R16G16_SINT: 38, R16G16B16A16_UNORM: 11, R16G16B16A16_UINT: 12, R16G16B16A16_SINT: 14 };

/** The bones and weights of every vertex of a buffer; null when it has no blend indices (or in a format not read). */
function skinOf(vb: VBuf, data: Buffer, remap: { table: number[]; starts: number[] } | null, meshIndex: number): MeshSkin | null {
  const bi = vb.layout.find((l) => l.name === 'BLENDINDICES' && l.index === 0);
  if (!bi) return null;
  const bw = vb.layout.find((l) => (l.name === 'BLENDWEIGHT' || l.name === 'BLENDWEIGHTS') && l.index === 0);
  const idxWidth = ({ [SKIN.R8G8B8A8_UINT]: 4, [SKIN.R16G16_SINT]: 2, [SKIN.R16G16B16A16_SINT]: 4, [SKIN.R16G16B16A16_UINT]: 4 } as Record<number, number>)[bi.format];
  if (!idxWidth) return null;
  const wtWidth = bw ? ({ [SKIN.R8G8B8A8_UNORM]: 4, [SKIN.R16G16_UNORM]: 2, [SKIN.R16G16B16A16_UNORM]: 4 } as Record<number, number>)[bw.format] : 0;
  if (bw && !wtWidth) return null;
  const start = remap ? remap.starts[meshIndex] ?? 0 : 0;
  const end = remap ? (meshIndex + 1 < remap.starts.length ? remap.starts[meshIndex + 1] : remap.table.length) : 0;
  const bones = new Uint16Array(vb.count * 4).fill(65535), weights = new Float32Array(vb.count * 4);
  for (let v = 0; v < vb.count; v++) {
    const pi = v * vb.stride + bi.offset, pw = bw ? v * vb.stride + bw.offset : 0;
    let sum = 0;
    for (let k = 0; k < idxWidth; k++) {
      const raw = bi.format === SKIN.R8G8B8A8_UINT ? data[pi + k] : bi.format === SKIN.R16G16B16A16_UINT ? data.readUInt16LE(pi + 2 * k) : data.readInt16LE(pi + 2 * k);
      let w = 1;
      if (bw) w = bw.format === SKIN.R8G8B8A8_UNORM ? data[pw + k] / 255 : (k < wtWidth ? data.readUInt16LE(pw + 2 * k) / 65535 : 0);
      else if (k > 0) w = 0;
      if (w <= 0 || raw < 0) continue;
      const bone = remap ? (start + raw < end ? remap.table[start + raw] : -1) : raw;
      if (bone === undefined || bone < 0 || bone > 65534) continue;
      bones[v * 4 + k] = bone; weights[v * 4 + k] = w; sum += w;
    }
    if (sum > 0) for (let k = 0; k < 4; k++) weights[v * 4 + k] /= sum;
  }
  return { bones, weights };
}

/** The inverse of a 3x4 rigid-and-scale matrix given as 12 numbers by rows. */
export function invert3x4(m: number[]): number[] {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!det) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const r = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  return [
    r[0], r[1], r[2], -(r[0] * tx + r[1] * ty + r[2] * tz),
    r[3], r[4], r[5], -(r[3] * tx + r[4] * ty + r[5] * tz),
    r[6], r[7], r[8], -(r[6] * tx + r[7] * ty + r[8] * tz),
  ];
}

/** a x b for 3x4 matrices (b applies first). */
export function multiply3x4(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      out.push(a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0));
    }
  }
  return out;
}

/** The colour texture a material names: the first referenced picture called ..._color_<psd|png|tga|jpg>_.... */
export function colourTextureOf(references: string[]): string | null {
  return references.find((r) => /_color_(psd|png|tga|jpg)_/i.test(r)) ?? null;
}
