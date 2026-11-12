// Kinetic Gems: a gem is several asset_modifier entries (particles and the ability's picture); picking one writes them all
// into the item's visuals and lists the files to copy under the plain paths.
import assert from 'node:assert/strict';
import * as itemBuilder from '../src/item-builder.ts';
import { ITEM_EFFECTS, effectParts } from '../src/item-builder-effects.ts';

const NL = '\r\n';
const item = (id: string, fields: string) => `\t\t"${id}"${NL}\t\t{${NL}${fields}\t\t}${NL}`;
const f = (k: string, v: string) => `\t\t\t"${k}"\t\t"${v}"${NL}`;
const heroes = `\t\t\t"used_by_heroes"${NL}\t\t\t{${NL}\t\t\t\t"npc_dota_hero_juggernaut"\t\t"1"${NL}\t\t\t}${NL}`;
const text = `"items_game"${NL}{${NL}\t"items"${NL}\t{${NL}`
  + item('6', f('name', "Juggernaut's Mask") + f('prefab', 'default_item') + f('item_slot', 'head') + f('model_player', 'models/heroes/juggernaut/jugg_mask.vmdl') + heroes)
  + item('7079', f('name', 'Sigil Mask of the Bladekeeper') + f('prefab', 'wearable') + f('item_slot', 'head') + f('model_player', 'models/items/juggernaut/dc_headupdate/dc_headupdate.vmdl') + heroes
    + `\t\t\t"visuals"${NL}\t\t\t{${NL}\t\t\t\t"asset_modifier0"${NL}\t\t\t\t{${NL}\t\t\t\t\t"type"\t\t"particle_create"${NL}\t\t\t\t\t"modifier"\t\t"particles/econ/items/juggernaut/bladekeeper_headglow/dc_juggernaut_bladekeeper_head.vpcf"${NL}\t\t\t\t}${NL}\t\t\t}${NL}`)
  + Array.from({ length: 1200 }, (_, i) => item(String(20000 + i), f('name', `filler ${i}`))).join('')
  + `\t}${NL}}${NL}`;

const gems = ITEM_EFFECTS.filter((e) => e.kinetic && e.hero === 'juggernaut');
assert.ok(gems.length >= 5, 'Fireborn Assault and the four Bladekeeper\'s');

const omni = itemBuilder.itemEffectPatch(text, 7079, ['kinetic-bladekeeper-omnislash']);
const types = (b: string) => [...b.matchAll(/"type"\s+"(\w+)"/g)].map((m) => m[1]);
console.log(omni.block.slice(omni.block.indexOf('"visuals"')));
assert.deepEqual(types(omni.block).filter((t) => t !== 'particle_create'), ['particle', 'particle', 'ability_icon']);
const copies = omni.assetCopies.map((c) => ('to' in c ? `${c.from} -> ${c.to}` : ''));
assert.ok(copies.includes('particles/econ/items/juggernaut/bladekeeper_omnislash/_dc_juggernaut_omni_slash_trail.vpcf -> particles/units/heroes/hero_juggernaut/juggernaut_omni_slash_trail.vpcf'), copies.join('\n'));
assert.ok(copies.includes('particles/econ/items/juggernaut/bladekeeper_omnislash/_dc_juggernaut_omni_slash_tgt.vpcf -> particles/units/heroes/hero_juggernaut/juggernaut_omni_slash_tgt.vpcf'));
assert.ok(copies.includes('panorama/images/spellicons/juggernaut/bladekeeper/juggernaut_omni_slash_png.vtex_c -> panorama/images/spellicons/juggernaut_omni_slash_png.vtex_c'));

for (const id of ['kinetic-bladekeeper-blade-dance', 'kinetic-bladekeeper-bladefury', 'kinetic-bladekeeper-healing-ward']) {
  const r = itemBuilder.itemEffectPatch(text, 7079, [id]);
  assert.deepEqual(types(r.block).filter((t) => t !== 'particle_create'), ['particle', 'ability_icon'], id);
  assert.equal(r.assetCopies.filter((c) => 'to' in c && /bladekeeper|juggernaut_/.test(c.from)).length >= 2, true, id);
}
// two gems at once, and the same one twice: each entry once
const both = itemBuilder.itemEffectPatch(text, 7079, ['kinetic-bladekeeper-bladefury', 'kinetic-bladekeeper-omnislash', 'kinetic-bladekeeper-bladefury']);
assert.equal(types(both.block).filter((t) => t === 'ability_icon').length, 2);
assert.equal(effectParts(ITEM_EFFECTS.find((e) => e.id === 'fire')!).length, 1);
console.log('KINETICS OK');
