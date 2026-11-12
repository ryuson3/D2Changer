// The preview's particles: which systems an item brings, a system read out of a real compiled file
// (the ring emblem the app carries), and the spec the window plays.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { itemParticles, particleDef, entityModel, particleReplacements, heroLoadoutParticles } from '../src/particle-spec.ts';
import { particleSpec, specTextures, range, vec } from '../src/particle-def.ts';
import { effectParticles } from '../src/item-builder.ts';

const block = `"1"
{
	"visuals"
	{
		"asset_modifier0" { "type" "particle_create" "modifier" "particles/a.vpcf" }
		"asset_modifier1" { "type" "particle_create" "modifier" "particles/b.vpcf" "style" "1" }
		"asset_modifier2" { "type" "particle" "asset" "particles/x.vpcf" "modifier" "particles/y.vpcf" }
		"asset_modifier3" { "type" "particle_create" "modifier" "particles/dire.vpcf" "dire_only" "1" }
	}
}`;
assert.deepEqual(itemParticles(block), ['particles/a.vpcf']);
assert.deepEqual(itemParticles(block, 1), ['particles/b.vpcf']);

// a picked effect brings its particle; an unknown id brings none
assert.deepEqual(effectParticles('fire,nope'), ['particles/econ/courier/courier_trail_lava/courier_trail_lava.vpcf']);

assert.deepEqual(range(5, 1), [5, 5]);
assert.deepEqual(range({ m_nType: 'PF_TYPE_LITERAL', m_flLiteralValue: 3 }, 1), [3, 3]);
assert.deepEqual(range({ m_nType: 'PF_TYPE_RANDOM_UNIFORM', m_flRandomMin: 2, m_flRandomMax: 4 }, 1), [2, 4]);
assert.deepEqual(vec({ m_nType: 'PVEC_TYPE_LITERAL', m_vLiteralValue: [1, 2, 3] }), [1, 2, 3]);

const root = path.join(import.meta.dirname, '..', 'assets', 'ring-emblem');
const read = (p: string) => { const f = path.join(root, p); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
const def = particleDef(read, 'particles/ui_mouseactions/selected_ring.vpcf');
assert.ok(def, 'the ring reads');
assert.equal(def.children.length, 0, 'its children are not in the folder, so none');
const spec = particleSpec(def);
assert.equal(spec.burst, 24);
assert.deepEqual(spec.life, [1, 1]);
assert.equal(spec.radius[0], 6);
assert.ok(spec.mortal, 'a decay kills its particles');
// its one renderer is a rope lying on the ground: not drawn as sprites
assert.equal(spec.draw, 'none');
assert.equal(specTextures(spec).size, 0);
assert.ok(spec.cps.some(([n]) => n === 4), 'the control point it sets itself');
assert.doesNotThrow(() => structuredClone(spec), 'the spec crosses to the window');

// an arcana: the body it puts the hero in, the systems it swaps, and the hero's own loadout systems
const arcana = `"5957"
{
	"visuals"
	{
		"asset_modifier0" { "type" "entity_model" "asset" "npc_dota_hero_terrorblade" "modifier" "models/heroes/terrorblade/terrorblade_arcana.vmdl" }
		"asset_modifier1" { "type" "entity_model" "asset" "npc_dota_terrorblade_illusion" "modifier" "models/other.vmdl" }
		"asset_modifier2" { "type" "particle" "asset" "particles/units/heroes/hero_terrorblade/terrorblade_ambient_sword.vpcf" "modifier" "particles/econ/items/terrorblade/arcana/sword.vpcf" }
		"asset_modifier3" { "type" "particle" "asset" "particles/a.vpcf" "modifier" "particles/b.vpcf" "style" "1" }
	}
}`;
assert.equal(entityModel(arcana, 'npc_dota_hero_terrorblade'), 'models/heroes/terrorblade/terrorblade_arcana.vmdl');
assert.equal(entityModel(block, 'npc_dota_hero_terrorblade'), null);
assert.deepEqual([...particleReplacements(arcana)], [['particles/units/heroes/hero_terrorblade/terrorblade_ambient_sword.vpcf', 'particles/econ/items/terrorblade/arcana/sword.vpcf']]);
assert.equal(particleReplacements(arcana, 1).get('particles/a.vpcf'), 'particles/b.vpcf');
const script = `"DOTAHeroes" { "npc_dota_hero_terrorblade" { "Model" "models/x.vmdl" "RenderablePortrait" { "Particles" {
	"particles/units/heroes/hero_terrorblade/terrorblade_loadout.vpcf" "loadout"
	"particles/other.vpcf" "portrait"
	"particles/block.vpcf" { "0" { "type" "follow_origin" } }
} } } }`;
assert.deepEqual(heroLoadoutParticles(script), ['particles/units/heroes/hero_terrorblade/terrorblade_loadout.vpcf', 'particles/block.vpcf']);
assert.deepEqual(heroLoadoutParticles('"x" { }'), []);

console.log('particles: ok');
