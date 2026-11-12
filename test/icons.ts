// Ability icons on a synthetic Dota tree: a hero whose ability has a gold and a red picture (two items swap
// it), a pick -> the variant's file under the ability's plain path -> pick another -> reset -> clean game.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createCosmetics } from '../src/cosmetics.ts';
import { buildVpk, entryAt, readVpkEntryFile } from '../src/vpk.ts';
import { fileHashes } from '../src/patcher-signatures.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-icons-'));
const game = path.join(root, 'game');
fs.mkdirSync(path.join(game, 'dota'), { recursive: true });
const binDir = path.join(game, 'bin', process.platform === 'linux' ? 'linuxsteamrt64' : 'win64');
fs.mkdirSync(binDir, { recursive: true });

const NL = '\r\n';
const item = (id: string, fields: string) => `\t\t"${id}"${NL}\t\t{${NL}${fields}\t\t}${NL}`;
const f = (k: string, v: string) => `\t\t\t"${k}"\t\t"${v}"${NL}`;
const heroes = (...h: string[]) => `\t\t\t"used_by_heroes"${NL}\t\t\t{${NL}${h.map((x) => `\t\t\t\t"${x}"\t\t"1"${NL}`).join('')}\t\t\t}${NL}`;
const swap = (ability: string, icon: string) => `\t\t\t"visuals"${NL}\t\t\t{${NL}\t\t\t\t"asset_modifier"${NL}\t\t\t\t{${NL}\t\t\t\t\t"type"\t\t"ability_icon"${NL}\t\t\t\t\t"asset"\t\t"${ability}"${NL}\t\t\t\t\t"modifier"\t\t"${icon}"${NL}\t\t\t\t}${NL}\t\t\t}${NL}`;

const items = `"items_game"${NL}{${NL}\t"items"${NL}\t{${NL}`
  + item('7000', f('name', 'Plain Blade') + f('prefab', 'default_item') + f('item_slot', 'weapon') + heroes('npc_dota_hero_antimage'))
  + item('7001', f('name', 'Golden Blade') + f('prefab', 'wearable') + f('item_slot', 'weapon') + heroes('npc_dota_hero_antimage') + swap('antimage_blink', 'antimage_blink_gold'))
  + item('7002', f('name', 'Crimson Blade') + f('prefab', 'wearable') + f('item_slot', 'weapon') + heroes('npc_dota_hero_antimage') + swap('antimage_blink', 'antimage_blink_red'))
  // a swap whose picture is not in the game: not offered
  + item('7003', f('name', 'Ghost Blade') + f('prefab', 'wearable') + f('item_slot', 'weapon') + heroes('npc_dota_hero_antimage') + swap('antimage_blink', 'antimage_blink_missing'))
  + Array.from({ length: 1200 }, (_, i) => item(String(20000 + i), f('name', `filler ${i}`))).join('')
  + `\t}${NL}`
  // the gems' table: a picture-only gem (one more picture of Blink), and one for a hero no item names (not offered)
  + `\t"asset_modifiers"${NL}\t{${NL}`
  + `\t\t"1"${NL}\t\t{${NL}${f('name', 'moon_blink_icon')}${f('loc_key', '#DOTA_Asset_Mod_Moon_Blink_Icon')}\t\t\t"0"${NL}\t\t\t{${NL}${f('type', 'ability_icon')}${f('asset', 'antimage_blink')}${f('modifier', 'antimage/moon/antimage_blink')}\t\t\t}${NL}\t\t}${NL}`
  + `\t\t"2"${NL}\t\t{${NL}${f('name', 'ghost_icon')}${f('loc_key', '#DOTA_Asset_Mod_Ghost_Icon')}\t\t\t"0"${NL}\t\t\t{${NL}${f('type', 'ability_icon')}${f('asset', 'nobody_spell')}${f('modifier', 'nobody/nobody_spell')}\t\t\t}${NL}\t\t}${NL}`
  + `\t}${NL}}${NL}`;

const sp = (n: string) => `panorama/images/spellicons/${n}_png.vtex_c`;
fs.writeFileSync(path.join(game, 'dota', 'pak01_dir.vpk'), buildVpk([
  entryAt('scripts/items/items_game.txt', Buffer.from(items, 'latin1')),
  entryAt(sp('antimage_blink'), Buffer.from('PLAIN')),
  entryAt(sp('antimage_blink_gold'), Buffer.from('GOLD')),
  entryAt(sp('antimage_blink_red'), Buffer.from('RED')),
  entryAt(sp('antimage/moon/antimage_blink'), Buffer.from('MOON')),
]));
const gi = `"GameInfo"${NL}{${NL}\tFileSystem${NL}\t{${NL}\t\tSearchPaths${NL}\t\t{${NL}\t\t\tGame\tdota${NL}\t\t\tMod\tdota${NL}\t\t\tGame\tcore${NL}\t\t}${NL}\t}${NL}}${NL}`;
const branch = `"GameInfo"${NL}{${NL}\tFileSystem${NL}\t{${NL}\t\tSteamAppId\t570${NL}\t}${NL}}${NL}`;
fs.writeFileSync(path.join(game, 'dota', 'gameinfo.gi'), gi);
fs.writeFileSync(path.join(game, 'dota', 'gameinfo_branchspecific.gi'), branch);
const { sha1, crc } = fileHashes(Buffer.from(branch, 'latin1'));
fs.writeFileSync(path.join(binDir, 'dota.signatures'), `dota2.exe~SHA1:AAAA;CRC:BBBB${NL}...\\..\\..\\dota\\gameinfo_branchspecific.gi~SHA1:${sha1};CRC:${crc}${NL}DIGEST:1234${NL}`);

const c = createCosmetics({ gamePath: game, dataDir: path.join(root, 'data') });
const builtPak = () => {
  const mod = fs.readdirSync(game).find((d) => d.startsWith('dota_') && fs.existsSync(path.join(game, d, 'pak99_dir.vpk')));
  return mod ? path.join(game, mod, 'pak99_dir.vpk') : null;
};
const iconIn = (p: string) => readVpkEntryFile(p, sp('antimage_blink'))?.data.toString();

// the catalog: the plain picture first, then the two that exist (the missing one is not offered)
const cat = c.abilityIcons();
assert.equal(cat.length, 1);
assert.equal(cat[0].hero, 'antimage');
const blink = cat[0].abilities.find((a) => a.ability === 'antimage_blink');
assert.ok(blink);
assert.deepEqual(blink.variants.map((v) => v.icon), ['antimage_blink', 'antimage_blink_gold', 'antimage_blink_red', 'antimage/moon/antimage_blink']);
// a picture-only Kinetic Gem is one more variant, named by its title made of its name; a gem of an unknown hero is left out
assert.equal(blink.variants[3].label, 'Moon Blink Icon');
assert.equal(blink.variants[1].label, 'Golden Blade');
assert.equal(blink.name, 'Blink');

// nothing picked: nothing of ours in the game
assert.equal(c.state().patched, false);
assert.equal(builtPak(), null);

// bad picks are refused and change nothing
assert.throws(() => c.setAbilityIcon('antimage_blink', 'antimage_blink_missing'), /не подходит/);
assert.throws(() => c.setAbilityIcon('no_such_ability', 'x'), /нет других иконок/);
assert.deepEqual(c.state().icons, {});

// the gold picture goes under the ability's plain path, byte for byte; the patch goes in
c.setAbilityIcon('antimage_blink', 'antimage_blink_gold');
// a pick alone touches nothing: it waits for «Применить косметику»
assert.equal(c.state().pending, true);
assert.equal(c.state().patched, false);
assert.equal(builtPak(), null);
const r = c.apply();
assert.ok(r.deployed, JSON.stringify(r));
assert.equal(c.state().pending, false);
assert.equal(c.state().patched, true);
assert.equal(iconIn(builtPak()!), 'GOLD');
assert.deepEqual(c.state().icons, { antimage_blink: 'antimage_blink_gold' });

// another one replaces it
c.setAbilityIcon('antimage_blink', 'antimage_blink_red');
assert.equal(iconIn(builtPak()!), 'GOLD', 'the built pak keeps the old picture until apply');
c.apply();
assert.equal(iconIn(builtPak()!), 'RED');

// it is listed as worn, with its name
const eq = c.equipped();
assert.equal(eq.abilityPicks.length, 1);
assert.equal(eq.abilityPicks[0].name, 'Blink');
assert.equal(eq.abilityPicks[0].label, 'Crimson Blade');

// it survives a restart of the module
assert.deepEqual(createCosmetics({ gamePath: game, dataDir: path.join(root, 'data') }).state().icons, { antimage_blink: 'antimage_blink_red' });

// the plain picture (or null) takes it off, and the game is as it was
c.setAbilityIcon('antimage_blink', null);
assert.deepEqual(c.state().icons, {});
assert.equal(c.state().pending, true);
c.apply();
assert.equal(c.state().pending, false);
assert.equal(builtPak(), null);
assert.equal(c.state().patched, false);

// "take everything off" clears icons too
c.setAbilityIcon('antimage_blink', 'antimage_blink_gold');
c.clearAll();
assert.deepEqual(c.state().icons, {});
assert.equal(builtPak(), null);
console.log('ICONS OK');
