// Presets: saved sets of picks. The store alone, then through createCosmetics on a synthetic Dota tree.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createCosmetics } from '../src/cosmetics.ts';
import { buildVpk, entryAt } from '../src/vpk.ts';
import { signatureLine, fileHashes } from '../src/patcher-signatures.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-'));
const game = path.join(root, 'game');
fs.mkdirSync(path.join(game, 'dota'), { recursive: true });
fs.mkdirSync(path.join(game, 'bin', process.platform === 'linux' ? 'linuxsteamrt64' : 'win64'), { recursive: true });

const items = `"items_game"\r\n{\r\n\t"items"\r\n\t{\r\n` +
`\t\t"555"\r\n\t\t{\r\n\t\t\t"name"\t"Default Weather"\r\n\t\t\t"prefab"\t"weather"\r\n\t\t\t"baseitem"\t"1"\r\n\t\t\t"visuals"\r\n\t\t\t{\r\n\t\t\t\t"particle"\t"default.vpcf"\r\n\t\t\t}\r\n\t\t}\r\n` +
`\t\t"556"\r\n\t\t{\r\n\t\t\t"name"\t"Snow"\r\n\t\t\t"prefab"\t"weather"\r\n\t\t\t"visuals"\r\n\t\t\t{\r\n\t\t\t\t"particle"\t"snow.vpcf"\r\n\t\t\t\t"unlock"\r\n\t\t\t\t{\r\n\t\t\t\t\t"x"\t"1"\r\n\t\t\t\t}\r\n\t\t\t}\r\n\t\t}\r\n` +
Array.from({ length: 1200 }, (_, i) => `\t\t"${1000 + i}"\r\n\t\t{\r\n\t\t\t"name"\t"filler ${i}"\r\n\t\t}\r\n`).join('') + `\t}\r\n}\r\n`;
fs.writeFileSync(path.join(game, 'dota', 'pak01_dir.vpk'), buildVpk([entryAt('scripts/items/items_game.txt', Buffer.from(items, 'latin1'))]));

const gi = `"GameInfo"\r\n{\r\n\tFileSystem\r\n\t{\r\n\t\tSearchPaths\r\n\t\t{\r\n\t\t\tGame\tdota\r\n\t\t\tMod\tdota\r\n\t\t\tGame\tcore\r\n\t\t}\r\n\t}\r\n}\r\n`;
const branch = `"GameInfo"\r\n{\r\n\tFileSystem\r\n\t{\r\n\t\tSteamAppId\t570\r\n\t}\r\n}\r\n`;
fs.writeFileSync(path.join(game, 'dota', 'gameinfo.gi'), gi);
fs.writeFileSync(path.join(game, 'dota', 'gameinfo_branchspecific.gi'), branch);
const { sha1, crc } = fileHashes(Buffer.from(branch, 'latin1'));
const sigPath = path.join(game, 'bin', process.platform === 'linux' ? 'linuxsteamrt64' : 'win64', 'dota.signatures');
const sigOrig = `dota2.exe~SHA1:AAAA;CRC:BBBB\r\n...\\..\\..\\dota\\gameinfo_branchspecific.gi~SHA1:${sha1};CRC:${crc}\r\nDIGEST:1234\r\n`;
fs.writeFileSync(sigPath, sigOrig);

const data = path.join(root, 'data');
// the player has Valve's Russian voice pack (named pak01_dir.vpk) and a leftover from older versions
fs.mkdirSync(path.join(game, 'dota_russian'), { recursive: true });
const VOICE = Buffer.from('VALVE-VOICE-PACK');
fs.writeFileSync(path.join(game, 'dota_russian', 'pak01_dir.vpk'), VOICE);
fs.mkdirSync(path.join(game, 'dota_cosmetics'), { recursive: true });
fs.writeFileSync(path.join(game, 'dota_cosmetics', 'pak01_dir.vpk'), 'old-ours');
const c = createCosmetics({ gamePath: game, dataDir: data });
// ---- the module alone ----
import { createPresets, cleanData } from '../src/presets.ts';
const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-'));
const ps = createPresets(pdir);
const wear = (n: string) => cleanData({ picks: { weather: n }, items: { 'item:pangolier:offhand': { itemId: '9208', effects: '' } }, gem: [1, 2, 3] });
assert.throws(() => ps.save('  ', wear('556')), /название/);
assert.throws(() => ps.save('x', cleanData({})), /ничего не надето/);
ps.save('Pango', wear('556'));
ps.save('pango', wear('557')); // same name (any case) updates the same preset
assert.equal(ps.list().length, 1);
assert.equal(ps.get(ps.list()[0].id)!.data.picks.weather, '557');
ps.saveAuto(wear('1'), 'auto'); ps.saveAuto(wear('2'), 'auto');
assert.equal(ps.list().filter((p) => p.auto).length, 1, 'one automatic slot');
assert.ok(ps.list()[0].auto, 'automatic copy listed first');
fs.writeFileSync(path.join(pdir, 'presets.json'), '{broken');
assert.deepEqual(ps.list(), [], 'a damaged file reads as empty');
assert.deepEqual(cleanData({ picks: { a: 1, b: {} }, items: { x: { itemId: 5 }, y: 7 }, gem: [300, 0, 0] }),
  { picks: { a: '1' }, items: { x: { itemId: '5', effects: '' } }, icons: {}, fx: {}, gem: null });

// ---- through the cosmetics ----
c.pick('weather', '556');
c.presetSave('Снег');
c.clearAll();
assert.deepEqual(c.state().picks, {}, 'everything taken off');
assert.ok(c.presets().some((p) => p.auto), 'clearing kept an automatic copy');
const auto = c.presets().find((p) => p.auto)!;
c.presetLoad(auto.id);
assert.equal(c.state().picks.weather, '556', 'the automatic copy brings it back');
c.pick('weather', null);
const mine = c.presets().find((p) => p.name === 'Снег')!;
c.presetLoad(mine.id);
assert.equal(c.state().picks.weather, '556', 'the named preset is put on');
assert.ok(c.state().pending, 'nothing is built until apply');
assert.throws(() => c.presetLoad('nope'), /не найден/);
c.presetDelete(mine.id);
assert.ok(!c.presets().some((p) => p.id === mine.id));
console.log('PRESETS OK');
