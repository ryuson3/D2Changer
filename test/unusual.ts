// The game's unusual effects: read from the table, named from dota_english, offered when the particle is in
// the game and the effect starts at the model; a pick resolves to a particle_create on the item.
import assert from 'node:assert/strict';
import { unusualEffects, offeredUnusual, effectNames, unusualItemEffect } from '../src/item-unusual.ts';
import { effectParticles, effectKey, withItemEffects } from '../src/item-builder.ts';
import { hasHeroOnlyEffect } from '../src/item-builder-effects.ts';

const NL = '\r\n';
const fx = (id: number, system: string, attach = 'follow_origin') =>
  `\t\t"${id}"${NL}\t\t{${NL}\t\t\t"system"\t\t"${system}"${NL}\t\t\t"attach_type"\t\t"${attach}"${NL}\t\t}${NL}`;
const text = `"items_game"${NL}{${NL}\t"attribute_controlled_attached_particles"${NL}\t{${NL}`
  + fx(4, 'particles/econ/courier/courier_flame/flame.vpcf')
  + fx(5, 'particles/econ/courier/eyes.vpcf', 'customorigin')
  + fx(6, 'particles/econ/courier/missing.vpcf')
  + fx(7, 'particles/econ/courier/unnamed.vpcf')
  + fx(8, 'particles/econ/courier/courier_trail_lava/courier_trail_lava.vpcf')
  + fx(9, 'particles/econ/courier/sunfire.vpcf')
  + `\t}${NL}}${NL}`;

assert.deepEqual(unusualEffects(text).map((e) => e.id), [4, 5, 6, 7, 8, 9]);
const names = effectNames(`"lang"\n{\n"Tokens"\n{\n"Attrib_Particle4"\t"Ethereal Flame"\n"Attrib_Particle5"\t"Eye Glow"\n"Attrib_Particle6"\t"Gone"\n"Attrib_Particle8"\t"Lava"\n"Attrib_Particle9"\t"Sunfire"\n}\n}`);
const inGame = new Set(['particles/econ/courier/courier_flame/flame.vpcf_c', 'particles/econ/courier/eyes.vpcf_c', 'particles/econ/courier/unnamed.vpcf_c',
  'particles/econ/courier/courier_trail_lava/courier_trail_lava.vpcf_c', 'particles/econ/courier/sunfire.vpcf_c']);
const own = new Set(['particles/econ/courier/courier_trail_lava/courier_trail_lava.vpcf']);
const offered = offeredUnusual(text, names, (p) => inGame.has(p), own);
// 5: starts on a named point; 6: not in the game; 7: no name; 8: the builder's own Fire already
assert.deepEqual(offered.map((e) => [e.id, e.name]), [['unusual-4', 'Ethereal Flame'], ['unusual-9', 'Sunfire']]);
assert.ok(offered.every((e) => e.unusual && e.heroOnly));

assert.equal(unusualItemEffect(text, 'unusual-4')?.modifier, 'particles/econ/courier/courier_flame/flame.vpcf');
assert.equal(unusualItemEffect(text, 'unusual-77'), null);
// a pick with one: the preview gets its particle, the key keeps it, and it is for heroes only
assert.deepEqual(effectParticles('fire,unusual-4', text), ['particles/econ/courier/courier_trail_lava/courier_trail_lava.vpcf', 'particles/econ/courier/courier_flame/flame.vpcf']);
assert.equal(effectKey('unusual-4,fire'), 'fire,unusual-4');
assert.ok(hasHeroOnlyEffect('unusual-4'));
// the courier path does not take them (it has no table to read them from)
assert.throws(() => withItemEffects('"1"\r\n{\r\n}', 'unusual-4'));
console.log('unusual: ok');
