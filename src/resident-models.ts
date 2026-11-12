/* A pick for a slot whose stock item has no model (Earthshaker's head, Bane's arms and back) has no
 * stock path to put its model under, so its block names the paid item's model. The game wears a
 * model only once it is loaded, and a match loads what the server's item table names: after a
 * reconnect that model is not loaded, and the item is gone (src/item-builder.ts withoutFileSwaps).
 *
 * The hero's own model is loaded whenever the hero is, and it loads the models it takes animations
 * from (m_refAnimIncludeModels). So the hero's model, as the mod carries it, lists the pick's model
 * there: it then comes with the hero, reconnect or not. Naming it in the reference block (RERL)
 * alone did not load it (tried in a match on Bane, 2026-11-12): the game loads what the model's own
 * data asks for.
 *
 * A model listed there also gives the hero its animations. One that plays an activity of its own
 * (a wearable with an idle) could be picked for the hero's, so such a model is not listed and its
 * pick stays as it was.
 */
import { readKv3, type Kv3Node } from './kv3.ts';
import { writeKv3 } from './kv3-write.ts';
import { kvJson } from './particle-spec.ts';
import { references, resourceBlock, resourceBlocks, withReferences } from './resource.ts';
import { entryAt, entryPath, type VpkEntry } from './vpk.ts';

/** A model to keep loaded: the patch it belongs to, the hero's compiled model path, and the model (.vmdl). */
export interface Resident { patch: number; heroModel: string; model: string }

const INCLUDES = 'm_refAnimIncludeModels';
const plainPath = (p: string) => p.toLowerCase().replace(/\\/g, '/').replace(/_c$/, '');
type Arr = Extract<Kv3Node, { kind: 'array' }>;

/** The models a compiled model takes animations from. */
export function includedModels(file: Buffer): string[] {
  const kv = readKv3(resourceBlock(file, 'DATA').data);
  const list = kv.root.kind === 'object' ? kv.root.members.get(INCLUDES) : undefined;
  return list?.kind === 'array' ? list.items.flatMap((x) => (x.kind === 'string' ? [x.value.toLowerCase()] : [])) : [];
}

/** Whether the pak's hero model keeps `model` loaded: listed among its includes and its references. */
export function keepsLoaded(heroModel: Buffer, model: string): boolean {
  const want = plainPath(model);
  return includedModels(heroModel).includes(want) && references(heroModel).includes(want);
}

/**
 * Whether a model plays an activity of its own: a sequence or a clip of its own, or of the
 * animation files it names, that lists one (ACT_DOTA_IDLE).
 */
export function playsActivity(file: Buffer, read: (path: string) => Buffer | null, depth = 0): boolean {
  const walk = (n: Kv3Node): boolean => (n.kind === 'string' ? /^ACT_/.test(n.value)
    : n.kind === 'array' ? n.items.some(walk)
    : n.kind === 'object' ? [...n.members.values()].some(walk) : false);
  for (const b of resourceBlocks(file)) {
    if (!['ANIM', 'ASEQ', 'AGRP'].includes(b.name) && !(depth > 0 && b.name === 'DATA')) continue;
    try { if (walk(readKv3(file.subarray(b.at, b.at + b.size)).root)) return true; } catch { /* a block this cannot read says nothing */ }
  }
  if (depth >= 2) return false;
  let named: string[] = [];
  try { named = references(file); } catch { /* names none */ }
  for (const ref of named) {
    if (!/\.(vagrp|vanim|vseq)$/i.test(ref)) continue;
    const child = read(`${ref.toLowerCase()}_c`);
    if (child && playsActivity(child, read, depth + 1)) return true;
  }
  return false;
}

/**
 * A model with `models` among those it takes animations from, and among its references.
 * The new entries are copies of one the list has, or of another resource the model names, so they
 * are written as the file writes a resource's name. The block is read back before it is used: a
 * model written wrong is the whole hero gone.
 */
export function withIncludedModels(file: Buffer, models: string[]): Buffer {
  const block = resourceBlock(file, 'DATA');
  const kv = readKv3(block.data);
  if (kv.root.kind !== 'object') throw new Error('модель героя не разобрать');
  const root = kv.root.members;
  const named = (key: string) => { const a = root.get(key); return a?.kind === 'array' && a.items[0]?.kind === 'string' ? a as Arr : null; };
  const had = root.get(INCLUDES);
  const like = named(INCLUDES) ?? named('m_refAnimGroups') ?? named('m_refMeshes') ?? named('m_refPhysicsData');
  if (!like) throw new Error('модель героя не называет ни одного ресурса, по образцу которого записать ссылку');
  const list: Arr = named(INCLUDES) ?? { ...like, items: [] };
  const before = JSON.stringify(kvJson(kv, kv.root));
  const have = new Set(list.items.flatMap((x) => (x.kind === 'string' ? [x.value.toLowerCase()] : [])));
  const added = models.map(plainPath).filter((m) => !have.has(m));
  if (!added.length) return withReferences(file, models.map(plainPath));
  for (const m of added) list.items.push({ ...like.items[0], value: m } as Kv3Node);
  root.set(INCLUDES, list);
  const written = writeKv3(kv);

  // read back: everything as it was, but for the list
  const again = readKv3(written);
  const expect = JSON.parse(before) as Record<string, unknown>;
  expect[INCLUDES] = [...(Array.isArray(expect[INCLUDES]) ? expect[INCLUDES] as unknown[] : []), ...added];
  const got = kvJson(again, again.root) as Record<string, unknown>;
  const sorted = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  if (sorted(got) !== sorted(expect)) {
    if (had === undefined) root.delete(INCLUDES);
    throw new Error('модель героя после записи читается иначе, оставлена как была');
  }
  return withReferences(block.replace(written), added);
}

/**
 * Give each hero's model its residents. A hero model one of the patches already carries (an
 * arcana's body under the hero's path, or the hero's own with an item's animations) is changed
 * where it is; otherwise the game's own file goes into the resident's patch.
 * @param read  the game's own file of a path, or null
 * @returns what could not be done, for the report
 */
export function withResidentModels(patches: { assets?: VpkEntry[] | null }[], residents: Resident[], read: (path: string) => Buffer | null): string[] {
  const failed: string[] = [];
  const byHero = new Map<string, Resident[]>();
  for (const r of residents) {
    const key = r.heroModel.toLowerCase();
    byHero.set(key, [...(byHero.get(key) ?? []), r]);
  }
  for (const [heroModel, list] of byHero) {
    const models: string[] = [];
    for (const model of new Set(list.map((r) => plainPath(r.model)))) {
      const file = read(`${model}_c`);
      if (!file) failed.push(`resident: ${model}: модели нет в файлах игры`);
      else if (playsActivity(file, read)) failed.push(`resident: ${model}: у модели свои анимации, герой мог бы заиграть ими; предмет виден только до переподключения`);
      else models.push(model);
    }
    if (!models.length) continue;
    try {
      // the pak keeps the first file of a path it is given: that is the one to change
      const holder = patches.find((p) => p.assets?.some((en) => entryPath(en).toLowerCase() === heroModel));
      if (holder) {
        holder.assets = holder.assets!.map((en) => (entryPath(en).toLowerCase() === heroModel ? entryAt(heroModel, withIncludedModels(en.data, models)) : en));
        continue;
      }
      const file = read(heroModel);
      if (!file) throw new Error(`нет файла ${heroModel}`);
      const patch = patches[list[0].patch];
      patch.assets = [...(patch.assets ?? []), entryAt(heroModel, withIncludedModels(file, models))];
    } catch (err) {
      failed.push(`resident: ${models.join(', ')}: ${(err as Error)?.message || err}`);
    }
  }
  return failed;
}
