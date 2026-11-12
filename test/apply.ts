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
  + item('7001', f('name', 'Golden Blade') + f('prefab', 'wearable') + f('item_slot', 'weapon') + heroes('npc_dota_hero_antimage') + swap('antimage_blink', 'antimage_blink_gold'))
  + item('7002', f('name', 'Crimson Blade') + f('prefab', 'wearable') + f('item_slot', 'weapon') + heroes('npc_dota_hero_antimage') + swap('antimage_blink', 'antimage_blink_red'))
  // a swap whose picture is not in the game: not offered
  + item('7003', f('name', 'Ghost Blade') + f('prefab', 'wearable') + f('item_slot', 'weapon') + heroes('npc_dota_hero_antimage') + swap('antimage_blink', 'antimage_blink_missing'))
  + Array.from({ length: 1200 }, (_, i) => item(String(20000 + i), f('name', `filler ${i}`))).join('')
  + `\t}${NL}}${NL}`;

const sp = (n: string) => `panorama/images/spellicons/${n}_png.vtex_c`;
fs.writeFileSync(path.join(game, 'dota', 'pak01_dir.vpk'), buildVpk([
  entryAt('scripts/items/items_game.txt', Buffer.from(items, 'latin1')),
  entryAt(sp('antimage_blink'), Buffer.from('PLAIN')),
  entryAt(sp('antimage_blink_gold'), Buffer.from('GOLD')),
  entryAt(sp('antimage_blink_red'), Buffer.from('RED')),
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

// picks wait for apply(); heal() only puts back what was applied, never the picks made since
c.setAbilityIcon('antimage_blink', 'antimage_blink_gold');
assert.equal(c.state().pending, true);
assert.equal(builtPak(), null);
c.apply();
assert.equal(iconIn(builtPak()!), 'GOLD');

c.setAbilityIcon('antimage_blink', 'antimage_blink_red');
assert.equal(c.state().pending, true);
fs.rmSync(builtPak()!, { force: true }); // as if a Dota update wiped the pak
const healed = c.heal();
assert.ok(healed.healed.includes('schema'), JSON.stringify(healed));
assert.equal(iconIn(builtPak()!), 'GOLD', 'heal rebuilds the applied look, not the pending pick');
assert.equal(c.state().pending, true, 'the red pick is still waiting');
c.apply();
assert.equal(iconIn(builtPak()!), 'RED');
assert.equal(c.state().pending, false);

// choosing the same thing as what is built is not a change
c.setAbilityIcon('antimage_blink', 'antimage_blink_gold');
c.setAbilityIcon('antimage_blink', 'antimage_blink_red');
assert.equal(c.state().pending, false);

// a state file from before the apply button (no `applied`, but built) reads as nothing pending
const file = path.join(root, 'data', 'cosmetics.json');
const old = JSON.parse(fs.readFileSync(file, 'utf8')); delete old.applied;
fs.writeFileSync(file, JSON.stringify(old));
assert.equal(createCosmetics({ gamePath: game, dataDir: path.join(root, 'data') }).state().pending, false);

// a pak built by an older builder is pending again: the same picks now build other files
const stale = JSON.parse(fs.readFileSync(file, 'utf8')); delete stale.rev;
fs.writeFileSync(file, JSON.stringify(stale));
const again = createCosmetics({ gamePath: game, dataDir: path.join(root, 'data') });
assert.equal(again.state().pending, true, 'built before this revision');
again.apply();
assert.equal(again.state().pending, false, 'and built again');

console.log('APPLY OK');
