// A pick with no stock path for its model: the hero's model lists it as a reference, so the game
// loads it with the hero (src/resident-models.ts). A real compiled file stands in for the hero's model.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { withResidentModels } from '../src/resident-models.ts';
import { references } from '../src/resource.ts';
import { entryAt, entryPath, type VpkEntry } from '../src/vpk.ts';

const stock = fs.readFileSync(path.join(import.meta.dirname, '..', 'assets', 'ring-emblem', 'particles', 'ui_mouseactions', 'selected_ring.vpcf_c'));
const hero = 'models/heroes/bounty_hunter/bounty_hunter.vmdl_c';
const bracer = 'models/items/bounty_hunter/bracer/bracer.vmdl';
const had = references(stock);
const dataOf = (assets: VpkEntry[] | null | undefined, p: string) => assets?.find((en) => entryPath(en) === p)?.data;

// nothing carries the hero's model: the game's own goes into the pick's patch, with the reference added
{
  const patches: { assets?: VpkEntry[] }[] = [{ assets: [] }, { assets: [] }];
  const failed = withResidentModels(patches, [{ patch: 1, heroModel: hero, model: bracer }], (p) => (p === hero ? stock : null));
  assert.deepEqual(failed, []);
  assert.equal(patches[0].assets!.length, 0);
  const made = dataOf(patches[1].assets, hero);
  assert.ok(made, 'the hero model is staged');
  assert.deepEqual(references(made), [...had, bracer], 'what it named before, and the pick\'s model');
}

// an arcana already put a body under the hero's path: that file is the one changed, once for two picks
{
  const patches: { assets?: VpkEntry[] }[] = [{ assets: [entryAt(hero, stock)] }, { assets: [] }, { assets: [] }];
  const failed = withResidentModels(patches, [
    { patch: 1, heroModel: hero, model: bracer },
    { patch: 2, heroModel: hero, model: 'models/items/bounty_hunter/hat/hat.vmdl_c' },
    { patch: 2, heroModel: hero, model: bracer },
  ], () => { throw new Error('the game\'s file is not read'); });
  assert.deepEqual(failed, []);
  assert.deepEqual(references(dataOf(patches[0].assets, hero)!), [...had, bracer, 'models/items/bounty_hunter/hat/hat.vmdl']);
  assert.equal(patches[1].assets!.length + patches[2].assets!.length, 0);
}

// no such file in the game: said, and nothing staged
{
  const patches: { assets?: VpkEntry[] }[] = [{}];
  const failed = withResidentModels(patches, [{ patch: 0, heroModel: hero, model: bracer }], () => null);
  assert.equal(failed.length, 1);
  assert.ok(!patches[0].assets?.length);
}

console.log('resident-models: ok');
