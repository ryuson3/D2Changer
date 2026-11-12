// Terrorblade's gem on a synthetic Dota tree (the colour plumbing; the recolour itself needs real particles)
// Hero items on a synthetic Dota tree: a hero with a stock item, a paid wearable with a model and a
// particle, a pick -> items_game block + files under the stock paths -> reset -> byte-exact restore.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createCosmetics } from '../src/cosmetics.ts';
import { buildVpk, entryAt, readVpkEntryFile } from '../src/vpk.ts';
import { signatureLine, fileHashes } from '../src/patcher-signatures.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-hero-'));
const game = path.join(root, 'game');
fs.mkdirSync(path.join(game, 'dota'), { recursive: true });
const binDir = path.join(game, 'bin', process.platform === 'linux' ? 'linuxsteamrt64' : 'win64');
fs.mkdirSync(binDir, { recursive: true });

const NL = '\r\n';
const item = (id: string, fields: string) => `\t\t"${id}"${NL}\t\t{${NL}${fields}\t\t}${NL}`;
const f = (k: string, v: string) => `\t\t\t"${k}"\t\t"${v}"${NL}`;
const heroes = (...h: string[]) => `\t\t\t"used_by_heroes"${NL}\t\t\t{${NL}${h.map((x) => `\t\t\t\t"${x}"\t\t"1"${NL}`).join('')}\t\t\t}${NL}`;

const items = `"items_game"${NL}{${NL}\t"items"${NL}\t{${NL}`
  // Terrorblade's stock hero base, and the arcana (5957) wearing over it, with a particle of the arcana's own
  + item('9101', f('name', "Default Terrorblade Base") + f('prefab', 'default_item') + f('item_slot', 'hero_base') + f('model_player', 'models/heroes/terrorblade/terrorblade.vmdl') + heroes('npc_dota_hero_terrorblade'))
  + item('5957', f('name', 'Fractal Horns of Inner Abysm') + f('prefab', 'wearable') + f('item_slot', 'hero_base') + f('model_player', 'models/heroes/terrorblade/horns_arcana.vmdl') + heroes('npc_dota_hero_terrorblade')
    + `\t\t\t"visuals"${NL}\t\t\t{${NL}`
    + `\t\t\t\t"asset_modifier"${NL}\t\t\t\t{${NL}\t\t\t\t\t"type"\t\t"particle"${NL}\t\t\t\t\t"asset"\t\t"particles/units/heroes/hero_terrorblade/terrorblade_ambient_eyes.vpcf"${NL}\t\t\t\t\t"modifier"\t\t"particles/econ/items/terrorblade/terrorblade_horns_arcana/terrorblade_ambient_eyes_arcana_horns.vpcf"${NL}\t\t\t\t}${NL}`
    + `\t\t\t}${NL}`)
  + Array.from({ length: 1200 }, (_, i) => item(String(20000 + i), f('name', `filler ${i}`))).join('')
  + `\t}${NL}}${NL}`;

const pak = path.join(game, 'dota', 'pak01_dir.vpk');
fs.writeFileSync(pak, buildVpk([
  entryAt('scripts/items/items_game.txt', Buffer.from(items, 'latin1')),
  entryAt('models/heroes/terrorblade/terrorblade.vmdl_c', Buffer.from('STOCK-MODEL')),
  entryAt('models/heroes/terrorblade/horns_arcana.vmdl_c', Buffer.from('ARCANA-MODEL')),
  entryAt('particles/units/heroes/hero_terrorblade/terrorblade_ambient_eyes.vpcf_c', Buffer.from('STOCK-PARTICLE')),
  // not a real particle: the recolour cannot read it, and the pick must still go in as it was
  entryAt('particles/econ/items/terrorblade/terrorblade_horns_arcana/terrorblade_ambient_eyes_arcana_horns.vpcf_c', Buffer.from('ARCANA-PARTICLE')),
]));

const gi = `"GameInfo"${NL}{${NL}\tFileSystem${NL}\t{${NL}\t\tSearchPaths${NL}\t\t{${NL}\t\t\tGame\tdota${NL}\t\t\tMod\tdota${NL}\t\t\tGame\tcore${NL}\t\t}${NL}\t}${NL}}${NL}`;
const branch = `"GameInfo"${NL}{${NL}\tFileSystem${NL}\t{${NL}\t\tSteamAppId\t570${NL}\t}${NL}}${NL}`;
fs.writeFileSync(path.join(game, 'dota', 'gameinfo.gi'), gi);
fs.writeFileSync(path.join(game, 'dota', 'gameinfo_branchspecific.gi'), branch);
const { sha1, crc } = fileHashes(Buffer.from(branch, 'latin1'));
const sigPath = path.join(binDir, 'dota.signatures');
fs.writeFileSync(sigPath, `dota2.exe~SHA1:AAAA;CRC:BBBB${NL}...\\..\\..\\dota\\gameinfo_branchspecific.gi~SHA1:${sha1};CRC:${crc}${NL}DIGEST:1234${NL}`);
void signatureLine;


const c = createCosmetics({ gamePath: game, dataDir: path.join(root, 'data') });
const slot = c.heroSlots('terrorblade').slots.find((x) => x.equipSlot === 'hero_base');
assert.ok(slot, 'hero_base slot exists');
assert.deepEqual(slot.options.map((o) => o.id), ['5957']);

assert.equal(c.state().gem, null);
assert.equal(c.state().patched, false);

// bad colours are refused, nothing is saved
for (const bad of [[1, 2], [1, 2, 300], [1.5, 2, 3], 'red', {}, undefined]) assert.throws(() => c.setGem(bad), /Не тот цвет/);
assert.equal(c.state().gem, null);

// a colour chosen before the arcana is worn is kept for it, and builds nothing
const kept = c.setGem([30, 120, 255]);
assert.deepEqual(c.state().gem, { 'terrorblade-arcana': [30, 120, 255] });
assert.equal(kept.applied, 0);
assert.equal(c.state().patched, false, 'nothing worn: the game is not touched');

// wearing the arcana with a gem builds; the unreadable particle goes in as it was, no crash
c.pickItem(slot.slot, '5957', []);
assert.equal(c.state().pending, true);
assert.equal(c.state().patched, false, 'a pick alone does not touch the game');
const r = c.apply();
assert.ok(r.deployed && r.applied === 1, JSON.stringify(r));
assert.equal(c.state().pending, false);
assert.equal(c.state().patched, true, 'the first pick puts the patch in');
const eq = c.equipped();
assert.equal(eq.heroItems.length, 1);
assert.equal(eq.heroItems[0].name, 'Fractal Horns of Inner Abysm');
assert.deepEqual(eq.heroItems[0].gem, [30, 120, 255]);
assert.deepEqual(c.state().gem, { 'terrorblade-arcana': [30, 120, 255] });
const mod = fs.readdirSync(game).find((d) => d.startsWith('dota_') && fs.existsSync(path.join(game, d, 'pak99_dir.vpk')));
assert.ok(mod, 'the pak is in the mod folder');
const built = path.join(game, mod, 'pak99_dir.vpk');
// the hero's own model path carries the arcana's model, the eye particle the arcana's (unreadable here, so as it was)
assert.equal(readVpkEntryFile(built, 'models/heroes/terrorblade/terrorblade.vmdl_c')?.data.toString(), 'ARCANA-MODEL');
assert.equal(readVpkEntryFile(built, 'particles/units/heroes/hero_terrorblade/terrorblade_ambient_eyes.vpcf_c')?.data.toString(), 'ARCANA-PARTICLE');

// a new colour rebuilds; null puts the arcana back as the game makes it
c.setGem([255, 60, 40]);
assert.deepEqual(c.state().gem, { 'terrorblade-arcana': [255, 60, 40] });
assert.equal(c.state().pending, true);
assert.ok(c.apply().deployed);
c.setGem(null);
assert.equal(c.state().gem, null);
assert.ok(c.apply().deployed);
assert.equal(c.state().pending, false);

// the colour survives a restart of the module (it is in the state file)
c.setGem([0, 200, 255]);
assert.deepEqual(createCosmetics({ gamePath: game, dataDir: path.join(root, 'data') }).state().gem, { 'terrorblade-arcana': [0, 200, 255] });

// each arcana keeps its own colour: Techies' does not change Terrorblade's
c.setGem([255, 175, 0], 'techies-arcana');
assert.deepEqual(c.state().gem, { 'terrorblade-arcana': [0, 200, 255], 'techies-arcana': [255, 175, 0] });
c.setGem(null, 'techies-arcana');
assert.deepEqual(c.state().gem, { 'terrorblade-arcana': [0, 200, 255] });
assert.throws(() => c.setGem([1, 2, 3], 'nobody'), /аркана/);
// a state file from before kept one colour for all: it is read as that colour on each arcana
const stateFile = path.join(root, 'data', 'cosmetics.json');
const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
fs.writeFileSync(stateFile, JSON.stringify({ ...saved, gem: [9, 8, 7] }));
assert.deepEqual(c.state().gem, { 'terrorblade-arcana': [9, 8, 7], 'techies-arcana': [9, 8, 7] });
c.setGem([0, 200, 255]);

// the game's Prismatic Gems, out of the table's "colors" section
import { gemColors } from '../src/gems.ts';
const table = `"items_game"\r\n{\r\n\t"colors"\r\n\t{\r\n\t\t"unusual_creators_light"\r\n\t\t{\r\n\t\t\t"color_name"\t\t"UnusualCreatorsLight"\r\n\t\t\t"hex_color"\t\t"#CCCCFF"\r\n\t\t}\r\n`
  + `\t\t"unusual_international_2012"\r\n\t\t{\r\n\t\t\t"color_name"\t\t"UnusualInternational2012"\r\n\t\t\t"hex_color"\t\t"#4B69FF"\r\n\t\t}\r\n\t\t"desc_common"\r\n\t\t{\r\n\t\t\t"color_name"\t\t"ItemRarityCommon"\r\n\t\t\t"hex_color"\t\t"#B0C3D9"\r\n\t\t}\r\n\t}\r\n}\r\n`;
assert.deepEqual(gemColors(table), [
  { key: 'unusual_creators_light', name: 'Creators Light', rgb: [204, 204, 255] },
  { key: 'unusual_international_2012', name: 'International 2012', rgb: [75, 105, 255] },
]);

// taking the arcana off takes the patch out again
c.pickItem(slot.slot, null);
assert.equal(c.state().patched, true, 'still in until apply');
c.apply();
assert.equal(c.state().patched, false);
assert.equal(c.equipped().heroItems.length, 0);
console.log('GEM OK');
