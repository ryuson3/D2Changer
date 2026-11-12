/* The hero's standing pose for the 3D preview: one frame of its idle animation, from the game's files.
 *
 * Without it every wearable is drawn in the bind pose (a T-pose with empty hands) and a weapon has
 * nothing to hang on. A hero's model carries its animations inside (the CTRL block names the blocks:
 * `embedded_animation`: group_data_block (the decode key), anim_data_block (the clips), seqgroup_data_block
 * (the sequences, which name the activity each clip plays)); a model with none can include another's
 * (m_refAnimIncludeModels) or name an animation group (m_refAnimGroups).
 *
 * A clip is frames cut into blocks of frames, each block a list of segments; a segment is the values of
 * one channel (position, angle or scale) of some of the bones, packed by one of twelve decoders. The layout
 * follows ValveResourceFormat's ModelAnimation (MIT): segment header = decoder index, cardinality, element
 * count and length as int16 each, then one int16 per element, then the packed values. Only one frame is
 * wanted here, so nothing is interpolated.
 *
 * Nothing is trusted blindly: a pose is used only when it comes out sane (finite, and the bind pose of the
 * skeleton agrees with the one the mesh was skinned to); otherwise the preview stays in the bind pose and
 * says why (`PoseResult.why`).
 */
import { resourceBlocks } from './resource.ts';
import { readKv3, numberOf } from './kv3.ts';
import type { Kv3Block, Kv3Node } from './kv3.ts';
import { readModelData, readModelSkeleton, half, invert3x4, multiply3x4, type ModelSkeleton, type Resolve } from './mesh.ts';

// ----- KV3 nodes, read where they lie (the clips are far too big to turn into plain values) -----
type Node = Kv3Node | undefined;
const member = (n: Node, k: string): Node => (n?.kind === 'object' ? n.members.get(k) : undefined);
const items = (n: Node): Kv3Node[] => (n?.kind === 'array' ? n.items : []);
const text = (n: Node): string => (n?.kind === 'string' ? n.value : '');
const flag = (n: Node): boolean => n?.kind === 'other' && (n.type === 13 || (n.type === 2 && !!n.value));

interface Doc { kv: Kv3Block; root: Kv3Node }
const doc = (file: Buffer, at: { at: number; size: number }): Doc => { const kv = readKv3(file.subarray(at.at, at.at + at.size)); return { kv, root: kv.root }; };
const numAt = (d: Doc, n: Node): number => (n?.kind === 'number' ? numberOf(d.kv, n) : 0);
const bytesOf = (d: Doc, n: Node): Buffer => {
  if (n?.kind === 'blob') return n.data;
  return Buffer.from(items(n).map((x) => numAt(d, x)));
};

/** Where one model keeps its animations. */
export interface Source { anim: Doc; key: Doc | null; seq: Doc | null }

function sourceOf(file: Buffer, errors: string[]): Source | null {
  const blocks = resourceBlocks(file);
  const ctrl = blocks.find((b) => b.name === 'CTRL');
  if (ctrl) {
    try {
      const c = doc(file, ctrl);
      const emb = member(c.root, 'embedded_animation');
      if (emb) {
        const at = (k: string) => { const i = numAt(c, member(emb, k)); return i > 0 || k !== 'seqgroup_data_block' ? blocks[i] : undefined; };
        const anim = at('anim_data_block'), grp = at('group_data_block'), seq = at('seqgroup_data_block');
        if (anim && grp) return { anim: doc(file, anim), key: doc(file, grp), seq: seq ? doc(file, seq) : null };
      }
    } catch (e) { errors.push(`CTRL: ${(e as Error).message}`); }
  }
  const named = (n: string) => blocks.find((b) => b.name === n);
  const anim = named('ANIM');
  if (!anim) return null;
  const grp = named('AGRP');
  const seq = named('ASEQ');
  return { anim: doc(file, anim), key: grp ? doc(file, grp) : null, seq: seq ? doc(file, seq) : null };
}

/** Every place a model's animations can come from, nearest first. */
function sourcesOf(file: Buffer, resolve: Resolve | undefined, errors: string[], depth = 0): Source[] {
  const out: Source[] = [];
  try { const s = sourceOf(file, errors); if (s) out.push(s); } catch (e) { errors.push(`ANIM: ${(e as Error).message}`); }
  if (!resolve || depth > 2) return out;
  const data = readModelData(file);
  for (const g of (data.m_refAnimGroups as string[] | undefined) ?? []) {
    if (!g) continue;
    try {
      const f = resolve(`${g}_c`);
      if (!f) continue;
      const blocks = resourceBlocks(f);
      const dataB = blocks.find((b) => b.name === 'DATA'), animB = blocks.find((b) => b.name === 'ANIM');
      if (!dataB) continue;
      const key = doc(f, dataB);
      if (animB) out.push({ anim: doc(f, animB), key, seq: null });
      else {
        // the clips in files of their own (.vanim)
        for (const a of items(member(key.root, 'm_localHAnimArray'))) {
          const af = a.kind === 'string' && a.value ? resolve(`${a.value}_c`) : null;
          const ab = af ? resourceBlocks(af).find((b) => b.name === 'DATA') : undefined;
          if (af && ab) out.push({ anim: doc(af, ab), key, seq: null });
        }
      }
    } catch (e) { errors.push(`${g}: ${(e as Error).message}`); }
  }
  for (const m of (data.m_refAnimIncludeModels as string[] | undefined) ?? []) {
    if (!m) continue;
    const f = resolve(`${m}_c`);
    if (f) out.push(...sourcesOf(f, resolve, errors, depth + 1));
    else errors.push(`нет файла ${m}`);
  }
  return out;
}

/** The clip that is the hero standing: the sequence of the ACT_DOTA_IDLE activity with the fewest modifiers, and the clip it plays. */
function idleClip(src: Source): Kv3Node | null {
  const clips = items(member(src.anim.root, 'm_animArray'));
  const byName = new Map<string, Kv3Node>();
  for (const c of clips) byName.set(text(member(c, 'm_name')).toLowerCase(), c);
  const isIdle = (n: Node) => items(member(n, 'm_activityArray')).some((a) => text(member(a, 'm_name')).toUpperCase() === 'ACT_DOTA_IDLE');
  const additive = (n: Node, k: string) => flag(member(member(n, 'm_flags'), k));

  if (src.seq) {
    const seqs = items(member(src.seq.root, 'm_localS1SeqDescArray'));
    const names = items(member(src.seq.root, 'm_localSequenceNameArray')).map(text);
    const seqByName = new Map<string, Kv3Node>();
    for (const s of seqs) seqByName.set(text(member(s, 'm_sName')).toLowerCase(), s);
    const resolveClip = (s: Kv3Node, hops = 0): Kv3Node | null => {
      const ref = numAt(src.seq!, items(member(member(s, 'm_fetch'), 'm_localReferenceArray'))[0]);
      const name = (names[ref] ?? '').toLowerCase();
      if (!name) return null;
      const clip = byName.get(name);
      if (clip) return clip;
      const next = seqByName.get(name);
      return next && hops < 4 ? resolveClip(next, hops + 1) : null;
    };
    const idles = seqs
      .filter((s) => isIdle(s) && !additive(s, 'm_bLegacyDelta') && !additive(s, 'm_bHidden'))
      .sort((a, b) => items(member(a, 'm_activityArray')).length - items(member(b, 'm_activityArray')).length);
    for (const s of idles) { const c = resolveClip(s); if (c && !additive(c, 'm_bDelta')) return c; }
  }
  // no sequences: a clip that names the activity itself, or is called idle
  const own = clips.filter((c) => !additive(c, 'm_bDelta') && !additive(c, 'm_bAnimGraphAdditive'));
  return own.find(isIdle) ?? own.find((c) => /idle/i.test(text(member(c, 'm_name')))) ?? null;
}

// ----- packed values -----
const SIN45_OVER = Math.sin(Math.PI / 4) / 16384;

/** A rotation stored in 48 bits: three 14-bit values and the signs and order that put the fourth back. [x, y, z, w] */
function quaternion48(b: Buffer, at: number): number[] {
  const i1 = b[at] + ((b[at + 1] & 63) << 8), i2 = b[at + 2] + ((b[at + 3] & 63) << 8), i3 = b[at + 4] + ((b[at + 5] & 63) << 8);
  const s1 = b[at + 1] & 128, s2 = b[at + 3] & 128, s3 = b[at + 5] & 128;
  const x = (b[at + 1] & 64) === 0 ? SIN45_OVER * (i1 - 16384) : SIN45_OVER * i1;
  const y = (b[at + 3] & 64) === 0 ? SIN45_OVER * (i2 - 16384) : SIN45_OVER * i2;
  const z = (b[at + 5] & 64) === 0 ? SIN45_OVER * (i3 - 16384) : SIN45_OVER * i3;
  let w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  if (s3) w = -w;
  if (s1) return s2 ? [y, z, w, x] : [z, w, x, y];
  return s2 ? [w, x, y, z] : [x, y, z, w];
}
const half3 = (b: Buffer, at: number) => [half(b.readUInt16LE(at)), half(b.readUInt16LE(at + 2)), half(b.readUInt16LE(at + 4))];
const float3 = (b: Buffer, at: number) => [b.readFloatLE(at), b.readFloatLE(at + 4), b.readFloatLE(at + 8)];

type Attr = 'pos' | 'rot' | 'scale';
/** One element of one segment at one frame (the frame is relative to the block the segment is in). */
type Reader = (data: Buffer, frame: number, element: number, count: number) => number[] | number;
const READERS: Record<string, { attr: Attr; read: Reader }> = {
  CCompressedStaticFullVector3: { attr: 'pos', read: (d, _f, e) => float3(d, e * 12) },
  CCompressedStaticVector3: { attr: 'pos', read: (d, _f, e) => half3(d, e * 6) },
  CCompressedStaticQuaternion: { attr: 'rot', read: (d, _f, e) => quaternion48(d, e * 6) },
  CCompressedStaticFloat: { attr: 'scale', read: (d, _f, e) => d.readFloatLE(e * 4) },
  CCompressedFullVector3: { attr: 'pos', read: (d, f, e, n) => float3(d, (f * n + e) * 12) },
  CCompressedDeltaVector3: { attr: 'pos', read: (d, f, e, n) => { const b = float3(d, e * 12), t = half3(d, n * 12 + (f * n + e) * 6); return [b[0] + t[0], b[1] + t[1], b[2] + t[2]]; } },
  CCompressedAnimVector3: { attr: 'pos', read: (d, f, e, n) => half3(d, (f * n + e) * 6) },
  CCompressedAnimQuaternion: { attr: 'rot', read: (d, f, e, n) => quaternion48(d, (f * n + e) * 6) },
  CCompressedFullQuaternion: { attr: 'rot', read: (d, f, e, n) => { const o = (f * n + e) * 16; return [d.readFloatLE(o), d.readFloatLE(o + 4), d.readFloatLE(o + 8), d.readFloatLE(o + 12)]; } },
  CCompressedFullFloat: { attr: 'scale', read: (d, f, e, n) => d.readFloatLE((f * n + e) * 4) },
};

/** Local pose of every bone: place in the parent, rotation (x y z w) and uniform scale. */
export interface Local { pos: number[][]; rot: number[][]; scale: number[] }

/** The frame of a clip, over the skeleton's own pose (a bone the clip does not animate keeps its place). */
export function decodeFrame(src: Source, clip: Kv3Node, skel: ModelSkeleton, frame: number, stats: Record<string, number | string> = {}): { local: Local; touched: number } {
  const local: Local = { pos: skel.pos.map((p) => p.slice()), rot: skel.rot.map((q) => q.slice()), scale: skel.names.map(() => 1) };
  const boneAt = new Map<string, number>();
  skel.names.forEach((n, i) => { if (!boneAt.has(n)) boneAt.set(n, i); });

  const a = src.anim, key = src.key;
  const pData = member(clip, 'm_pData');
  const blocks = items(member(pData ?? clip, 'm_frameblockArray'));
  const decoders = items(member(a.root, 'm_decoderArray')).map((d) => text(member(d, 'm_szName')));
  const segments = items(member(a.root, 'm_segmentArray'));
  const channels = key ? items(member(member(key.root, 'm_decodeKey'), 'm_dataChannelArray')) : [];
  let touched = 0;
  const keys = (n: Node) => (n?.kind === 'object' ? [...n.members.keys()].join(',') : '-');
  Object.assign(stats, { clipKeys: keys(clip), pDataKeys: keys(pData), blocks: blocks.length, decoders: decoders.length, segments: segments.length, channels: channels.length, key: key ? 'yes' : 'no', inFrame: 0, noSeg: 0, noDecoder: 0, noChannel: 0, attrMismatch: 0, noBone: 0, noElement: 0 });
  const bump = (k: string) => { stats[k] = (stats[k] as number) + 1; };

  for (const fb of blocks) {
    const start = numAt(a, member(fb, 'm_nStartFrame')), end = numAt(a, member(fb, 'm_nEndFrame'));
    if (frame < start || frame > end) continue;
    bump('inFrame');
    for (const si of items(member(fb, 'm_segmentIndexArray'))) {
      const seg = segments[numAt(a, si)];
      if (!seg) { bump('noSeg'); continue; }
      const container = bytesOf(a, member(seg, 'm_container'));
      const decoder = READERS[decoders[container.readInt16LE(0)] ?? ''];
      const count = container.readInt16LE(4);
      const channel = channels[numAt(a, member(seg, 'm_nLocalChannel'))];
      if (!decoder) { bump('noDecoder'); stats.lastDecoder = decoders[container.readInt16LE(0)] ?? `#${container.readInt16LE(0)}`; continue; }
      if (!channel || count <= 0) { bump('noChannel'); continue; }
      const cls = text(member(channel, 'm_szChannelClass')), variable = text(member(channel, 'm_szVariableName'));
      if (cls === 'MorphChannel' || cls === 'UserChannel') continue;
      const want: Attr | null = variable === 'Position' ? 'pos' : variable === 'Angle' ? 'rot' : variable === 'Scale' ? 'scale' : null;
      if (want !== decoder.attr) { bump('attrMismatch'); stats.lastChannel = `${cls}/${variable}/${decoders[container.readInt16LE(0)]}`; continue; }
      const data = container.subarray(8 + count * 2);
      const where = new Map<number, number>();           // element number to its place in this segment
      for (let k = count - 1; k >= 0; k--) where.set(container.readInt16LE(8 + k * 2), k);
      const names = items(member(channel, 'm_szElementNameArray')), indices = items(member(channel, 'm_nElementIndexArray'));
      for (let k = 0; k < names.length; k++) {
        const bone = boneAt.get(text(names[k]).toLowerCase());
        const place = where.get(numAt(key!, indices[k]));
        if (bone === undefined) { bump('noBone'); stats.lastBone = text(names[k]); continue; }
        if (place === undefined) { bump('noElement'); continue; }
        const v = decoder.read(data, frame - start, place, count);
        if (decoder.attr === 'pos') local.pos[bone] = v as number[];
        else if (decoder.attr === 'rot') local.rot[bone] = v as number[];
        else local.scale[bone] = v as number;
        touched++;
      }
    }
  }
  return { local, touched };
}

// ----- matrices (3x4 by rows, as src/mesh.ts has them) -----
function matrixOf(pos: number[], q: number[], scale: number): number[] {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const x = q[0] / l, y = q[1] / l, z = q[2] / l, w = q[3] / l;
  return [
    scale * (1 - 2 * (y * y + z * z)), scale * 2 * (x * y - z * w), scale * 2 * (x * z + y * w), pos[0],
    scale * 2 * (x * y + z * w), scale * (1 - 2 * (x * x + z * z)), scale * 2 * (y * z - x * w), pos[1],
    scale * 2 * (x * z - y * w), scale * 2 * (y * z + x * w), scale * (1 - 2 * (x * x + y * y)), pos[2],
  ];
}
export function worldOf(skel: ModelSkeleton, local: Local): number[][] {
  const world: number[][] = [];
  for (let i = 0; i < skel.names.length; i++) {      // parents come before their children; a bone that does not is treated as a root
    const m = matrixOf(local.pos[i], local.rot[i], local.scale[i]);
    const p = skel.parent[i];
    world.push(p >= 0 && p < i ? multiply3x4(world[p], m) : m);
  }
  return world;
}

export interface PoseResult {
  /** bone name (lower case) to the matrix that takes a vertex from the bind pose to the pose, 3x4 by rows; null when there is no pose */
  skin: Map<string, number[]> | null;
  /** bone name to the matrix that takes model space to that bone's space in the bind pose, for every bone of the skeleton */
  bind: Map<string, number[]>;
  /** why there is no pose, for people */ why?: string;
  /** the clip that stands */ clip?: string;
}

/**
 * The hero standing: frame 0 of its idle clip. `meshBind` are the inverse bind matrices the hero's mesh was
 * skinned to (src/mesh.ts readModelBones), against which the skeleton's own bind pose is checked.
 */
export function idlePose(file: Buffer, meshBind: Map<string, number[]>, resolve?: Resolve): PoseResult {
  const skel = readModelSkeleton(file);
  if (!skel) return { skin: null, bind: new Map(), why: 'у модели нет списка костей' };
  const bindWorld = worldOf(skel, { pos: skel.pos, rot: skel.rot, scale: skel.names.map(() => 1) });
  const bind = new Map<string, number[]>();
  skel.names.forEach((n, i) => { if (!bind.has(n)) bind.set(n, invert3x4(bindWorld[i])); });

  // the skeleton's bind pose must be the one the mesh was skinned to, or a pose built on it would tear the mesh
  let seen = 0, off = 0;
  for (const [n, inv] of meshBind) {
    const mine = bind.get(n);
    if (!mine) continue;
    seen++;
    const a = invert3x4(inv), b = invert3x4(mine);
    if (Math.hypot(a[3] - b[3], a[7] - b[7], a[11] - b[11]) > 0.5) off++;
  }
  if (seen && off > seen * 0.1) return { skin: null, bind, why: `позы костей скелета не совпадают с позой меша (${off} из ${seen})` };

  const errors: string[] = [];
  let sources: Source[];
  try { sources = sourcesOf(file, resolve, errors); } catch (e) { return { skin: null, bind, why: `анимации не прочитались (${(e as Error).message})` }; }
  if (!sources.length) {
    const data = readModelData(file);
    const has = (k: string) => (Array.isArray(data[k]) ? `${k}:${data[k].length}` : '');
    return { skin: null, bind, why: `анимации не нашлись. Блоки: ${resourceBlocks(file).map((b) => `${b.name}(${b.size})`).join(' ')}. ${[has('m_refAnimGroups'), has('m_refAnimIncludeModels')].filter(Boolean).join(' ')}${errors.length ? ` Ошибки: ${errors.join('; ')}` : ''}` };
  }

  let why = 'не нашёлся клип стойки (idle)';
  for (const src of sources) {
    let clip: Kv3Node | null;
    try { clip = idleClip(src); } catch (e) { why = `клипы не прочитались (${(e as Error).message})`; continue; }
    if (!clip) continue;
    try {
      const stats: Record<string, number | string> = {};
      const { local, touched } = decodeFrame(src, clip, skel, 0, stats);
      if (!touched) { why = `клип стойки ничего не двигает: ${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ')}`; continue; }
      const world = worldOf(skel, local);
      const sane = world.every((m) => m.every(Number.isFinite)) && world.every((m, i) => Math.hypot(m[3] - bindWorld[i][3], m[7] - bindWorld[i][7], m[11] - bindWorld[i][11]) < 500);
      if (!sane) { why = 'поза из клипа вышла нерезонной (не тот формат?), оставлена поза по умолчанию'; continue; }
      const skin = new Map<string, number[]>();
      skel.names.forEach((n, i) => { if (!skin.has(n)) skin.set(n, multiply3x4(world[i], invert3x4(bindWorld[i]))); });
      return { skin, bind, clip: text(member(clip, 'm_name')) };
    } catch (e) { why = `клип стойки не раскрылся (${(e as Error).message})`; }
  }
  return { skin: null, bind, why };
}
