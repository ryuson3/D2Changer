// The standing pose of a hero (src/anim.ts) on a made-up two-bone skeleton and clip: the packed rotation comes out as
// the rotation put in, the child bone swings about its own joint, and the skin matrix carries a vertex there.
import assert from 'node:assert/strict';
import { decodeFrame, worldOf, type Source } from '../src/anim.ts';
import { invert3x4, multiply3x4 } from '../src/mesh.ts';
import type { Kv3Block, Kv3Node } from '../src/kv3.ts';

// a fake KV3 block: numbers live in one buffer, like the real thing
const store = Buffer.alloc(4096);
let at = 0;
const kv = { buffers: [store] } as unknown as Kv3Block;
const store2 = Buffer.alloc(4096);   // the decode key is a block of its own, with its own numbers
let at2 = 0;
const kv2 = { buffers: [store2] } as unknown as Kv3Block;
const num2 = (v: number): Kv3Node => { store2.writeInt32LE(v, at2); const cell = { buffer: 0 as const, offset: at2, width: 4 as const, signed: true }; at2 += 4; return { kind: 'number', type: 11, cell, typeAt: null }; };
const num = (v: number): Kv3Node => { store.writeInt32LE(v, at); const cell = { buffer: 0 as const, offset: at, width: 4 as const, signed: true }; at += 4; return { kind: 'number', type: 11, cell, typeAt: null }; };
const str = (value: string): Kv3Node => ({ kind: 'string', value });
const arr = (items: Kv3Node[]): Kv3Node => ({ kind: 'array', items });
const obj = (o: Record<string, Kv3Node>): Kv3Node => ({ kind: 'object', members: new Map(Object.entries(o)) });

// 14-bit packing of a rotation whose fourth component is w (the largest), signs all clear
const SIN45 = Math.sin(Math.PI / 4) / 16384;
function pack48(x: number, y: number, z: number): Buffer {
  const b = Buffer.alloc(6);
  [x, y, z].forEach((v, k) => {
    const i = v >= 0 ? Math.round(v / SIN45) : Math.round(v / SIN45) + 16384;
    b[k * 2] = i & 255; b[k * 2 + 1] = (i >> 8) & 63 | (v >= 0 ? 64 : 0);
  });
  return b;
}

// root at the origin, child 10 along x; the clip turns the child 60 degrees about z
const skel = { names: ['root', 'child'], parent: [-1, 0], pos: [[0, 0, 0], [10, 0, 0]], rot: [[0, 0, 0, 1], [0, 0, 0, 1]] };
const half = Math.PI / 6;                      // 60 degrees is 30 each side
const container = Buffer.concat([
  (() => { const h = Buffer.alloc(8 + 2); h.writeInt16LE(0, 0); h.writeInt16LE(1, 2); h.writeInt16LE(1, 4); h.writeInt16LE(18, 6); h.writeInt16LE(7, 8); return h; })(),
  pack48(0, 0, Math.sin(half)),
]);
const src: Source = {
  anim: { kv, root: obj({
    m_decoderArray: arr([obj({ m_szName: str('CCompressedStaticQuaternion') })]),
    m_segmentArray: arr([obj({ m_container: { kind: 'blob', data: container }, m_nLocalChannel: num(0) })]),
  }) },
  key: { kv: kv2, root: obj({ m_decodeKey: obj({ m_dataChannelArray: arr([obj({
    m_szChannelClass: str('BoneChannel'), m_szVariableName: str('Angle'),
    m_szElementNameArray: arr([str('child')]), m_nElementIndexArray: arr([num2(7)]),
  })]) }) }) },
  seq: null,
};
const clip = obj({ m_pData: obj({ m_nFrames: num(1), m_frameblockArray: arr([obj({ m_nStartFrame: num(0), m_nEndFrame: num(0), m_segmentIndexArray: arr([num(0)]) })]) }) });

const { local, touched } = decodeFrame(src, clip, skel, 0);
assert.equal(touched, 1);
assert.ok(Math.abs(local.rot[1][2] - Math.sin(half)) < 1e-3 && Math.abs(local.rot[1][3] - Math.cos(half)) < 1e-3, `rotation ${local.rot[1]}`);
assert.deepEqual(local.rot[0], [0, 0, 0, 1], 'a bone the clip does not move keeps its bind rotation');

const bind = worldOf(skel, { pos: skel.pos, rot: skel.rot, scale: [1, 1] });
const posed = worldOf(skel, local);
const skin = multiply3x4(posed[1], invert3x4(bind[1]));
// a point 10 past the child's joint, along x, swings 60 degrees about the joint at (10, 0, 0)
const p = [20, 0, 0];
const out = [0, 1, 2].map((r) => skin[r * 4] * p[0] + skin[r * 4 + 1] * p[1] + skin[r * 4 + 2] * p[2] + skin[r * 4 + 3]);
assert.ok(Math.hypot(out[0] - (10 + 10 * Math.cos(Math.PI / 3)), out[1] - 10 * Math.sin(Math.PI / 3), out[2]) < 0.05, `got ${out}`);
// and the joint itself stays put
const j = [0, 1, 2].map((r) => skin[r * 4] * 10 + skin[r * 4 + 3]);
assert.ok(Math.hypot(j[0] - 10, j[1], j[2]) < 1e-3);
console.log('ANIM POSE OK');
