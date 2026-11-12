/* An item's particle swaps: a hero's own are copied onto the plain path, the ones everybody plays are not. */
import assert from 'node:assert/strict';
import { isSharedParticle, itemAssets } from '../src/item-builder-assets.ts';

assert.equal(isSharedParticle('particles/items_fx/blademail.vpcf'), true);
assert.equal(isSharedParticle('Particles\\Items2_FX\\radiance_owner.vpcf'), true);
assert.equal(isSharedParticle('particles/msg_fx/msg_deny.vpcf'), true);
assert.equal(isSharedParticle('particles/generic_gameplay/illusion_created.vpcf'), true);
assert.equal(isSharedParticle('particles/status_fx/status_effect_illusion.vpcf'), true);
assert.equal(isSharedParticle('particles/units/heroes/hero_spectre/spectre_dispersion.vpcf'), false);
assert.equal(isSharedParticle('particles/econ/items/spectre/spectre_arcana/spectre_arcana_ambient_shoulder.vpcf'), false);

const swap = (asset: string, modifier: string) =>
  `"asset_modifier"\r\n{\r\n"type" "particle"\r\n"asset" "${asset}"\r\n"modifier" "${modifier}"\r\n}\r\n`;
const visuals = '"visuals"\r\n{\r\n'
  + swap('particles/units/heroes/hero_spectre/spectre_dispersion.vpcf', 'particles/econ/items/spectre/spectre_arcana/spectre_arcana_dispersion.vpcf')
  + swap('particles/items_fx/blademail.vpcf', 'particles/econ/items/spectre/spectre_arcana/spectre_arcana_blademail.vpcf')
  + swap('particles/generic_gameplay/illusion_created.vpcf', 'particles/econ/items/spectre/spectre_arcana/spectre_arcana_illusion_created.vpcf')
  + '}';
const text = '"items_game"\r\n{\r\n"items"\r\n{\r\n}\r\n}\r\n';
const copies = itemAssets(text, visuals, ['npc_dota_hero_spectre']).assetCopies.filter((c) => 'to' in c).map((c) => (c as { to: string }).to);
assert.deepEqual(copies, ['particles/units/heroes/hero_spectre/spectre_dispersion.vpcf']);
console.log('shared-particles: ok');
