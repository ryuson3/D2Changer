/* The 3D preview of a hero: the hero's own model with its items on, from the game's files.
 *
 * Every wearable shares its hero's skeleton, so its meshes already stand where they belong in the
 * bind pose and nothing has to be skinned (src/mesh.ts). A wearable that hangs on a bone the hero's
 * mesh does not have (a weapon in the hand) has to be placed by that bone: not done yet, and said so
 * in `notes` rather than drawn at the hero's feet. Textures are the colour map of each material, read
 * down to 512 px (src/vtex-decode.ts); the game's lighting and normal maps are not shown.
 *
 * Effects: the particle systems each worn item brings (and the ones picked on top) go along as specs
 * (src/particle-def.ts) with the attachment points they hang on, already in the hero's pose; the
 * window runs them (ui/preview.js). They are an approximation: colour, motion and place, not every
 * operator the game has.
 */
import { readModelMeshes, readModelBones, readModelSkeleton, readModelAttachments, colourTextureOf, invert3x4, multiply3x4, loadMeshopt, type MeshSkin } from './mesh.ts';
import { resourceBlocks } from './resource.ts';
import { particleDef, modelParticles } from './particle-spec.ts';
import { particleSpec, specTextures, type ParticleSpec } from './particle-def.ts';
import { idlePose, type PoseResult } from './anim.ts';
import { references } from './resource.ts';
import { decodeVtex, type Pixels } from './vtex-decode.ts';
import type { VpkIndex } from './vpk.ts';

export interface PreviewModel {
  label: string; /** as the item table names it, with no _c */ model: string;
  /** what to show when this one cannot be read: the slot's stock item */ fallback?: { label: string; model: string };
  /** the particle systems it brings (.vpcf), besides the ones its model lists itself */ particles?: string[];
}
/** A particle system on model `owner` (an index into the models given; 0 is the hero). */
export interface PreviewFx { owner: number; spec: ParticleSpec }
export interface PreviewPartData {
  label: string;
  positions: Float32Array; uvs: Float32Array; normals: Float32Array; indices: Uint32Array;
  /** index into `textures`, or -1 for none */ texture: number;
}
export interface PreviewTexture { width: number; height: number; rgba: Uint8Array }
export interface PreviewScene {
  parts: PreviewPartData[]; textures: PreviewTexture[];
  /** what is not shown, and why, for people */ notes: string[];
  min: number[]; max: number[];
  fx: PreviewFx[];
  /** per model (same index as `owner`): attachment name to its place in the hero's pose */ attachments: Record<string, number[]>[];
  /** points on the hero's body, x y z each, for systems that spawn on the model */ surface: Float32Array;
  /** sprite pictures by texture path */ fxTextures: Record<string, PreviewTexture>;
}

const MAX_TEXTURE = 512;
const MAX_SPRITE = 128;
/** Systems across the whole hero: a few hundred would cost the window more than their look is worth. */
const MAX_SYSTEMS = 160;
const apply3x4 = (m: number[], p: number[]) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
/** A wearable that hangs on a bone the hero does not have: left out of the picture, and not worth a line of notes. */
const SKIPPED = '\0skipped';
const pixelCache = new Map<string, Pixels | null>();

function pixelsOf(ix: VpkIndex, material: string): { key: string; px: Pixels } | null {
  const mat = ix.read(`${material}_c`);
  if (!mat) return null;
  let tex: string | null = null;
  try { tex = colourTextureOf(references(mat)); } catch { /* none */ }
  if (!tex) return null;
  if (!pixelCache.has(tex)) {
    if (pixelCache.size > 80) pixelCache.clear();
    const file = ix.read(`${tex}_c`);
    pixelCache.set(tex, file ? decodeVtex(file, MAX_TEXTURE) : null);
  }
  const px = pixelCache.get(tex);
  return px ? { key: tex, px } : null;
}

/** Smooth normals from the triangles (the game's own are stored packed). */
function normalsOf(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const i of [a, b, c]) { n[i] += x; n[i + 1] += y; n[i + 2] += z; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/**
 * Move a mesh's vertices from the bind pose into the pose: each goes where its bones (up to four, by weight) have
 * gone. `names` are the bone names of the model the mesh is of, which `skin` indexes; `only` is the one bone of a
 * mesh that stores no skin (a weapon on one bone). A vertex none of whose bones the pose knows stays where it is, and
 * the result says which vertices the pose moved (1) and which it did not (0).
 */
function pose(P: Float32Array, skin: MeshSkin | undefined, names: string[], only: string | null, moves: Map<string, number[]>): Uint8Array {
  const rigid = only ? moves.get(only) : undefined;
  const n = P.length / 3;
  const moved = new Uint8Array(n);
  if (!skin && !rigid) return moved;
  for (let v = 0; v < n; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0, sum = 0;
    for (let k = 0; k < 4; k++) {
      let m: number[] | undefined, w: number;
      if (skin) {
        w = skin.weights[v * 4 + k];
        if (w <= 0) continue;
        const b = skin.bones[v * 4 + k];
        m = b === 65535 ? undefined : moves.get(names[b]);
      } else { if (k > 0) break; w = 1; m = rigid; }
      if (!m) continue;
      ox += w * (m[0] * x + m[1] * y + m[2] * z + m[3]);
      oy += w * (m[4] * x + m[5] * y + m[6] * z + m[7]);
      oz += w * (m[8] * x + m[9] * y + m[10] * z + m[11]);
      sum += w;
    }
    if (sum <= 0) continue;
    P[v * 3] = ox / sum; P[v * 3 + 1] = oy / sum; P[v * 3 + 2] = oz / sum;
    moved[v] = 1;
  }
  return moved;
}

/**
 * @param models the hero's own model first, then the items it wears
 */
export async function buildPreview(ix: VpkIndex, models: PreviewModel[], replacements: Map<string, string> = new Map()): Promise<PreviewScene> {
  const decoder = await loadMeshopt();
  const scene: PreviewScene = { parts: [], textures: [], notes: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], fx: [], attachments: [], surface: new Float32Array(0), fxTextures: {} };
  const files: (Buffer | null)[] = [];
  let heroParts = 0;
  const textureAt = new Map<string, number>();
  let heroBones: Map<string, number[]> | null = null;
  let standing: PoseResult | null = null;
  const resolve = (p: string) => ix.read(p);

  /** Model k's attachment points, where they stand on the hero as posed. */
  const placeAttachments = (file: Buffer, k: number, own: Map<string, number[]>, place: number[] | null, only: string | null) => {
    const out: Record<string, number[]> = scene.attachments[k] ?? {};
    for (const a of readModelAttachments(file, resolve)) {
      if (out[a.name]) continue;
      const sum = [0, 0, 0];
      let wsum = 0;
      a.bones.forEach((b, i) => {
        const w = a.weights[i];
        if (!(w > 0)) return;
        let p = a.offsets[i];
        if (!a.root[i]) {
          const inv = own.get(b) ?? heroBones?.get(b);
          if (!inv) return;
          p = apply3x4(invert3x4(inv), p);
        }
        if (place) p = apply3x4(place, p);
        const moved = standing?.skin?.get(only ?? b);
        if (moved) p = apply3x4(moved, p);
        for (let d = 0; d < 3; d++) sum[d] += w * p[d];
        wsum += w;
      });
      if (wsum > 0) out[a.name] = sum.map((x) => x / wsum);
    }
    scene.attachments[k] = out;
  };

  /** Put one model in the scene; the reason it could not be shown, or null. */
  const add = (m: { label: string; model: string }, k: number): string | null => {
    const file = ix.read(`${m.model}_c`);
    if (!file) return `${m.label}: модели нет в файлах игры`;
    // a wearable on one bone of its own (a weapon in the hand) stands at that bone's place on the hero
    let place: number[] | null = null;
    let only: string | null = null;
    if (k === 0) {
      heroBones = readModelBones(file, resolve);
      // the hero standing (frame 0 of its idle); without it, in the bind pose, and the note says why
      try { standing = idlePose(file, heroBones, resolve); } catch (e) { standing = { skin: null, bind: new Map(), why: (e as Error).message }; }
      if (!standing.skin) scene.notes.push(`Поза героя не применена, он в позе по умолчанию: ${standing.why}`);
      // a bone the hero's mesh does not use is still a bone of its skeleton: the place a wearable hangs on
      for (const [n, inv] of standing.bind) if (!heroBones.has(n)) heroBones.set(n, inv);
    } else {
      const bones = readModelBones(file, resolve);
      if (heroBones && bones.size && ![...bones.keys()].some((b) => heroBones!.has(b))) return SKIPPED;
      if (heroBones && bones.size === 1) {
        const [name, inv] = [...bones][0];
        const hero = heroBones.get(name);
        if (hero) place = multiply3x4(invert3x4(hero), inv);
        only = name;
      }
    }
    files[k] = file;
    try { placeAttachments(file, k, k === 0 ? heroBones! : readModelBones(file, resolve), place, only); } catch { /* no points: its effects stand at the hero's */ }
    const skeletonNames: string[] | undefined = readModelSkeleton(file)?.names;
    let meshes;
    const why: string[] = [];
    try { meshes = readModelMeshes(file, why, 1, resolve); } catch (e) { return `${m.label}: не прочитать (${(e as Error).message})`; }
    if (!meshes.length) return `${m.label}: нечего показать: ${[...new Set(why)].join('; ') || 'в модели нет меша'}${decoder ? '' : ' (распаковщик сжатых мешей не загрузился)'}`;
    let hung = false;
    for (const mesh of meshes) {
      let texture = -1;
      const found = pixelsOf(ix, mesh.material);
      if (found) {
        if (!textureAt.has(found.key)) { textureAt.set(found.key, scene.textures.length); scene.textures.push({ width: found.px.width, height: found.px.height, rgba: new Uint8Array(found.px.rgba) }); }
        texture = textureAt.get(found.key)!;
      }
      const P = mesh.positions;
      if (place) {
        for (let i = 0; i < P.length; i += 3) {
          const x = P[i], y = P[i + 1], z = P[i + 2];
          P[i] = place[0] * x + place[1] * y + place[2] * z + place[3];
          P[i + 1] = place[4] * x + place[5] * y + place[6] * z + place[7];
          P[i + 2] = place[8] * x + place[9] * y + place[10] * z + place[11];
        }
      }
      let indices = mesh.indices;
      if (standing?.skin) {
        const moved = pose(P, only ? undefined : mesh.skin, skeletonNames ?? [], only, standing.skin);
        // On a wearable, a triangle none of whose corners the pose could move hangs on something the hero's skeleton
        // does not have (a prop made to sit on an attachment). Left where it is it stands at the hero's feet, so it is
        // not drawn, and the note says so.
        if (k > 0) {
          const keep: number[] = [];
          for (let t = 0; t + 2 < indices.length; t += 3) {
            if (moved[indices[t]] || moved[indices[t + 1]] || moved[indices[t + 2]]) keep.push(indices[t], indices[t + 1], indices[t + 2]);
          }
          if (keep.length < indices.length) { hung = true; indices = Uint32Array.from(keep); }
          if (!indices.length) continue;
        }
      }
      for (let i = 0; i < P.length; i += 3) for (let d = 0; d < 3; d++) {
        if (P[i + d] < scene.min[d]) scene.min[d] = P[i + d];
        if (P[i + d] > scene.max[d]) scene.max[d] = P[i + d];
      }
      scene.parts.push({ label: m.label, positions: P, uvs: mesh.uvs, normals: normalsOf(P, indices), indices, texture });
    }
    if (hung) scene.notes.push(`${m.label}: часть модели привязана к точке, которой нет на скелете героя, в превью она не показана`);
    return null;
  };
  models.forEach((m, k) => {
    const failed = add(m, k);
    if (k === 0) heroParts = scene.parts.length;
    if (failed === null) return;
    if (failed === SKIPPED) return;
    // the slot is not left empty (a bare head, no legs): its stock item stands in, and the note says so
    if (m.fallback && add(m.fallback, k) === null) scene.notes.push(`${failed}; вместо него показан стоковый предмет слота`);
    else scene.notes.push(failed);
  });
  if (!scene.parts.length) { scene.min = [0, 0, 0]; scene.max = [1, 1, 1]; }
  addEffects(ix, models, files, scene, heroParts, replacements);
  return scene;
}

/** The particle systems of every model, their sprite pictures, and points on the hero's body to spawn on. */
function addEffects(ix: VpkIndex, models: PreviewModel[], files: (Buffer | null)[], scene: PreviewScene, heroParts: number, replacements: Map<string, string>): void {
  const budget = { left: MAX_SYSTEMS };
  // a worn item's swap can name a child of a system as well as its root, so every read goes through it
  const swapped = (p: string) => replacements.get(p.toLowerCase().replace(/_c$/, '')) ?? p.replace(/_c$/i, '');
  const read = (p: string) => ix.read(`${swapped(p)}_c`);
  const seen = new Set<string>();
  models.forEach((m, k) => {
    // the body lists its ambient systems itself as well (an arcana's body: its glow and smoke)
    const own = files[k] ? modelParticles(files[k]) : [];
    for (const root of new Set([...(m.particles ?? []), ...own])) {
      if (budget.left <= 0) break;
      const path = swapped(root);
      if (seen.has(`${k}|${path}`)) continue;
      seen.add(`${k}|${path}`);
      try {
        const def = particleDef(read, path, budget);
        if (def) scene.fx.push({ owner: k, spec: particleSpec(def) });
      } catch { /* a system the reader cannot take is left out */ }
    }
  });
  if (!scene.fx.length) return;
  for (let k = 0; k < models.length; k++) scene.attachments[k] ??= {};
  const wanted = new Set<string>();
  for (const f of scene.fx) specTextures(f.spec, wanted);
  for (const tex of wanted) {
    const file = ix.read(`${tex}_c`);
    // a sheet of frames drawn whole would show as a grid: such a sprite stays a soft glow
    if (!file || resourceBlocks(file).some((b) => b.name === 'SHEET')) continue;
    try {
      const px = decodeVtex(file, MAX_SPRITE);
      if (px && px.width >= 24) scene.fxTextures[tex] = { width: px.width, height: px.height, rgba: new Uint8Array(px.rgba) };
    } catch { /* stays a glow */ }
  }
  const points: number[] = [];
  const body = scene.parts.slice(0, heroParts);
  const total = body.reduce((n, p) => n + p.positions.length / 3, 0);
  const every = Math.max(1, Math.floor(total / 600));
  let i = 0;
  for (const p of body) for (let v = 0; v < p.positions.length; v += 3, i++) if (i % every === 0) points.push(p.positions[v], p.positions[v + 1], p.positions[v + 2]);
  scene.surface = new Float32Array(points);
  scene.notes.push('Эффекты в превью приблизительные: цвет, движение и место те же, что в игре, но форма упрощена');
}
