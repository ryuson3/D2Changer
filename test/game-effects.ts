// Ethereal gems found in the game: a synthetic items_game with gems, a courier and a hero item. Only particles that
// a gem ("Ethereal: ...") creates and that exist in pak01 are offered; they go through the
// same effect machinery as the hand-made ones (id kept in a pick's key, the particle written into visuals).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createCosmetics } from '../src/cosmetics.ts';
import { buildVpk, entryAt } from '../src/vpk.ts';
import * as itemBuilder from '../src/item-builder.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-fx-'));
const game = path.join(root, 'game');
fs.mkdirSync(path.join(game, 'dota'), { recursive: true });

const NL = '\r\n';
const item = (id: string, fields: string) => `\t\t"${id}"${NL}\t\t{${NL}${fields}\t\t}${NL}`;
const f = (k: string, v: string) => `\t\t\t"${k}"\t\t"${v}"${NL}`;

const P = {
  animus: 'particles/econ/items/ethereal/burning_animus_ambient.vpcf',
  sunfire: 'particles/econ/items/ethereal/sunfire.vpcf',
  sunfire2: 'particles/econ/items/ethereal/sunfire_embers.vpcf',
  gone: 'particles/econ/items/ethereal/not_in_the_game.vpcf',
  glow: 'particles/econ/items/axe/axe_sword_glow.vpcf',
  amb: 'particles/econ/courier/cool/cool_ambient.vpcf',
  lava: 'particles/econ/courier/courier_trail_lava/courier_trail_lava.vpcf',
};
const mod = (p: string, extra = '') => `\t\t\t\t"asset_modifier"${NL}\t\t\t\t{${NL}\t\t\t\t\t"type"\t\t"particle_create"${NL}\t\t\t\t\t"modifier"\t\t"${p}"${NL}${extra}\t\t\t\t}${NL}`;
const visuals = (...mods: string[]) => `\t\t\t"visuals"${NL}\t\t\t{${NL}${mods.join('')}\t\t\t}${NL}`;
const attach = `\t\t\t\t\t"attach_type"\t\t"absorigin_follow"${NL}\t\t\t\t\t"control_points"${NL}\t\t\t\t\t{${NL}\t\t\t\t\t\t"0"\t\t"SetParticleControl 0 0 0"${NL}\t\t\t\t\t}${NL}`;
const items = `"items_game"${NL}{${NL}\t"items"${NL}\t{${NL}`
  + item('8001', f('name', 'Ethereal: Burning Animus') + f('prefab', 'gem') + visuals(mod(P.animus, attach)))
  + item('8002', f('name', 'Ethereal: Sunfire') + f('prefab', 'gem') + visuals(mod(P.sunfire), mod(P.sunfire2)))
  // not in the game's files: left out
  + item('8003', f('name', 'Ethereal: Ghost') + f('prefab', 'gem') + visuals(mod(P.gone)))
  // the same particle again under another gem: once
  + item('8004', f('name', 'Ethereal: Sunfire Copy') + f('prefab', 'gem') + visuals(mod(P.sunfire)))
  // courier and hero items are not gems: none of their particles is offered
  + item('8005', f('name', 'Cool Courier') + f('prefab', 'courier') + f('item_slot', 'courier') + visuals(mod(P.amb)))
  + item('8006', f('name', 'Plain Sword') + f('prefab', 'wearable') + f('item_slot', 'weapon') + visuals(mod(P.glow)))
  // the hand-made Fire is not offered twice
  + item('8007', f('name', 'Ethereal: Lava') + f('prefab', 'gem') + visuals(mod(P.lava)))
  + Array.from({ length: 1200 }, (_, i) => item(String(20000 + i), f('name', `filler ${i}`))).join('')
  + `\t}${NL}}${NL}`;
fs.writeFileSync(path.join(game, 'dota', 'pak01_dir.vpk'), buildVpk([
  entryAt('scripts/items/items_game.txt', Buffer.from(items, 'latin1')),
  ...[P.animus, P.sunfire, P.sunfire2, P.glow, P.amb, P.lava].map((p) => entryAt(`${p}_c`, Buffer.from('PARTICLE'))),
]));

const c = createCosmetics({ gamePath: game, dataDir: path.join(root, 'data') });
const list = c.effects();
assert.equal(list[0].id, '', 'the "no effect" entry is first');
const built = ['fire', 'lightnings', 'frostbloom', 'snow', 'sand-storm', 'ghost', 'gold-glow', 'smoke', 'featherfall'];
assert.deepEqual(c.effects('courier').map((e) => e.id), ['', 'fire', 'lightnings', 'frostbloom', 'snow', 'sand-storm', 'ghost'].concat(list.slice(1 + built.length).map((e) => e.id)), 'the courier does not get the hero-only ones');
assert.deepEqual(list.slice(1, 1 + built.length).map((e) => e.id), built, 'the hand-made ones stay first');
const found = list.slice(1 + built.length);
assert.deepEqual(found.map((e) => e.name), ['Burning Animus', 'Sunfire', 'Sunfire (Sunfire Embers)'],
  'only gems, without the "Ethereal: " prefix; not the missing, duplicate, courier, hero or hand-made particle');
assert.ok(found.every((e) => /^g-[a-z0-9_]+-[0-9a-f]{6}$/.test(e.id)), found.map((e) => e.id).join(' '));

// the same effect machinery: the id stays in a pick's key, and the particle is written into the block
const flames = found.find((e) => e.name === 'Burning Animus')!;
assert.equal(itemBuilder.effectKey([flames.id, 'fire']), `fire,${flames.id}`);
const block = `"1"${NL}{${NL}\t"name"\t\t"Courier"${NL}}${NL}`;
const written = itemBuilder.withItemEffects(block, flames.id);
assert.ok(written.includes(P.animus));
assert.ok(written.includes('absorigin_follow') && written.includes('SetParticleControl 0 0 0'), 'the gem\'s own attach fields are written with it');

// the report says what was found (for when a game build offers none)
const report = fs.readFileSync(path.join(root, 'data', 'effects-report.txt'), 'utf8');
assert.match(report, /ethereal effects offered: 3/);
assert.match(report, /every item with "ethereal" in it/);
assert.match(report, /Ethereal: Ghost/);
console.log('GAME EFFECTS OK');
