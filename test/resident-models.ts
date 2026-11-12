// A pick with no stock path for its model: the hero's model lists it among the models it takes
// animations from, so the game loads it with the hero (src/resident-models.ts). A real compiled
// file stands in for the hero's model: a particle given the list of resources a model has.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { withResidentModels, withIncludedModels, includedModels, keepsLoaded, playsActivity } from '../src/resident-models.ts';
import { readKv3, type Kv3Node } from '../src/kv3.ts';
import { writeKv3 } from '../src/kv3-write.ts';
import { kvJson } from '../src/particle-spec.ts';
import { references, resourceBlock, withReferences } from '../src/resource.ts';
import { entryAt, entryPath, type VpkEntry } from '../src/vpk.ts';

const folder = path.join(import.meta.dirname, '..', 'assets', 'ring-emblem', 'particles', 'ui_mouseactions');
const particle = fs.readFileSync(path.join(folder, 'selected_ring.vpcf_c'));

/** The particle as a "model": with `key` naming one resource, written as the file writes a resource's name. */
function standIn(key: string, value: string, more: [string, Kv3Node][] = []): Buffer {
  const block = resourceBlock(particle, 'DATA');
  const kv = readKv3(block.data);
  assert.equal(kv.root.kind, 'object');
  const root = (kv.root as Extract<Kv3Node, { kind: 'object' }>).members;
  let flagged: Kv3Node | null = null;
  const find = (n: Kv3Node): void => {
    if (flagged) return;
    if (n.kind === 'string' && n.flag) { flagged = n; return; }
    if (n.kind === 'array') n.items.forEach(find);
    if (n.kind === 'object') n.members.forEach(find);
  };
  find(kv.root);
  const like: Kv3Node = flagged ?? { kind: 'string', value: '' };
  root.set(key, { kind: 'array', items: [{ ...like, value } as Kv3Node] });
  for (const [k, v] of more) root.set(k, v);
  return withReferences(block.replace(writeKv3(kv)), [value]);
}
const dataJson = (file: Buffer) => { const kv = readKv3(resourceBlock(file, 'DATA').data); return kvJson(kv, kv.root) as Record<string, unknown>; };

const heroFile = standIn('m_refMeshes', 'models/heroes/bane/bane.vmesh');
const hero = 'models/heroes/bane/bane.vmdl_c';
const arms = 'models/items/bane/arms/arms.vmdl';
const back = 'models/items/bane/back/back.vmdl';
const had = references(heroFile);
const dataOf = (assets: VpkEntry[] | null | undefined, p: string) => assets?.find((en) => entryPath(en) === p)?.data;

// the list is made when the model has none, and the rest of the model reads as it did
{
  assert.deepEqual(includedModels(heroFile), []);
  const made = withIncludedModels(heroFile, [arms, `${back}_c`]);
  assert.deepEqual(includedModels(made), [arms, back]);
  assert.deepEqual(references(made), [...had, arms, back]);
  assert.ok(keepsLoaded(made, arms) && keepsLoaded(made, `${back}_c`));
  assert.ok(!keepsLoaded(heroFile, arms));
  const { m_refAnimIncludeModels: _list, ...rest } = dataJson(made);
  assert.deepEqual(rest, dataJson(heroFile), 'nothing else changed');
  // a model that has the list keeps what was in it, and a model named twice is listed once
  const twice = withIncludedModels(made, [arms, 'models/items/bane/head/head.vmdl']);
  assert.deepEqual(includedModels(twice), [arms, back, 'models/items/bane/head/head.vmdl']);
  assert.throws(() => withIncludedModels(particle, [arms]), 'a file that names no resource of a model is refused');
}

// a model that plays an activity of its own is told apart from one that does not
{
  assert.equal(playsActivity(heroFile, () => null), false);
  const read = (p: string) => (p === 'models/items/bane/arms/arms.vagrp_c' ? standIn('m_list', 'x.vanim', [['m_activity', { kind: 'string', value: 'ACT_DOTA_IDLE' }]]) : null);
  assert.equal(playsActivity(withReferences(heroFile, ['models/items/bane/arms/arms.vagrp']), read), true, 'its animation group lists an activity');
  assert.equal(playsActivity(withReferences(heroFile, ['models/items/bane/arms/arms.vagrp']), () => null), false);
}

const game = (files: Record<string, Buffer>) => (p: string) => files[p] ?? null;

// nothing carries the hero's model: the game's own goes into the pick's patch, with the models listed
{
  const patches: { assets?: VpkEntry[] }[] = [{ assets: [] }, { assets: [] }];
  const failed = withResidentModels(patches, [{ patch: 1, heroModel: hero, model: arms }], game({ [hero]: heroFile, [`${arms}_c`]: heroFile }));
  assert.deepEqual(failed, []);
  assert.equal(patches[0].assets!.length, 0);
  assert.ok(keepsLoaded(dataOf(patches[1].assets, hero)!, arms), 'the hero model is staged with the pick\'s model');
}

// another pick already put a model under the hero's path: that file is the one changed, once for two picks
{
  const patches: { assets?: VpkEntry[] }[] = [{ assets: [entryAt(hero, heroFile)] }, { assets: [] }, { assets: [] }];
  const failed = withResidentModels(patches, [
    { patch: 1, heroModel: hero, model: arms },
    { patch: 2, heroModel: hero, model: `${back}_c` },
    { patch: 2, heroModel: hero, model: arms },
  ], game({ [`${arms}_c`]: heroFile, [`${back}_c`]: heroFile }));
  assert.deepEqual(failed, []);
  assert.deepEqual(includedModels(dataOf(patches[0].assets, hero)!), [arms, back]);
  assert.equal(patches[1].assets!.length + patches[2].assets!.length, 0);
}

// a model with animations of its own is left out and said; no such hero file in the game: said, nothing staged
{
  const animated = withReferences(heroFile, ['models/items/bane/arms/arms.vagrp']);
  const group = standIn('m_list', 'x.vanim', [['m_activity', { kind: 'string', value: 'ACT_DOTA_IDLE' }]]);
  const patches: { assets?: VpkEntry[] }[] = [{}];
  const failed = withResidentModels(patches, [{ patch: 0, heroModel: hero, model: arms }, { patch: 0, heroModel: hero, model: back }],
    game({ [hero]: heroFile, [`${arms}_c`]: animated, 'models/items/bane/arms/arms.vagrp_c': group, [`${back}_c`]: heroFile }));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /arms\.vmdl: у модели свои анимации/);
  assert.deepEqual(includedModels(dataOf(patches[0].assets, hero)!), [back]);
  const none: { assets?: VpkEntry[] }[] = [{}];
  assert.equal(withResidentModels(none, [{ patch: 0, heroModel: hero, model: back }], game({ [`${back}_c`]: heroFile })).length, 1);
  assert.ok(!none[0].assets?.length);
}

// the report says whether the pak's hero model keeps the pick's model
{
  const { buildApplyReport } = await import('../src/apply-report.ts');
  const trace = (linked: boolean) => ({
    source: 'arms', hero: 'bane', heroName: 'Bane', slotLabel: 'Arms', itemId: '28434', name: 'Arms', stockId: '614', stockName: null, borrowed: null, paths: [],
    resident: { heroModel: hero, model: arms, linked },
  });
  const res = { applied: [{ id: '614', source: 'arms' }], missing: [], conflicts: [], owners: { [hero]: 'head' }, dropped: [] } as never;
  const ok = buildApplyReport([trace(true)], res, (s) => s);
  assert.equal(ok.entries[0].problem, false, 'the hero model another pick carries, with the model listed in it, is no problem');
  assert.match(ok.text, /ссылка в модели героя: записана; модель героя в паке: да, от «head»/);
  assert.equal(buildApplyReport([trace(false)], res, (s) => s).entries[0].problem, true, 'not listed: a problem');
  assert.equal(buildApplyReport([trace(true)], { ...(res as object), owners: {} } as never, (s) => s).entries[0].problem, true, 'no hero model in the pak: a problem');
}

console.log('resident-models: ok');
