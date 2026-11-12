// «Удалить модификации»: our pak and patch go, other tools' files stay. On a synthetic Dota tree.
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

const ru = path.join(game, 'dota_russian');
fs.mkdirSync(ru, { recursive: true });
fs.writeFileSync(path.join(ru, 'gameinfo.gi'), 'VALVE-GI');
fs.writeFileSync(path.join(ru, 'pak64_dir.vpk'), 'someone-else');
fs.writeFileSync(path.join(ru, 'pak02_dir.vpk.moff'), 'someone-else-too');
const branchPath = path.join(game, 'dota', 'gameinfo_branchspecific.gi');
const branchBefore = fs.readFileSync(branchPath);

c.pick('weather', '556');
c.apply();
assert.ok(fs.existsSync(path.join(ru, 'pak99_dir.vpk')), 'our pak was built');
assert.notDeepEqual(fs.readFileSync(branchPath), branchBefore, 'the game was patched');

const r = c.removeAll();
assert.ok(!fs.existsSync(path.join(ru, 'pak99_dir.vpk')), 'our pak is gone');
assert.deepEqual(fs.readFileSync(branchPath), branchBefore, 'gameinfo_branchspecific.gi is back byte for byte');
assert.equal(fs.readFileSync(path.join(ru, 'pak64_dir.vpk'), 'utf8'), 'someone-else', 'a foreign pak is untouched');
assert.ok(fs.existsSync(path.join(ru, 'pak02_dir.vpk.moff')) && fs.existsSync(path.join(ru, 'gameinfo.gi')));
assert.deepEqual(fs.readFileSync(path.join(ru, 'pak01_dir.vpk')), VOICE, "Valve's voice pack is untouched");
assert.deepEqual(r.left.sort(), ['dota_russian\\pak01_dir.vpk', 'dota_russian\\pak02_dir.vpk.moff', 'dota_russian\\pak64_dir.vpk'], 'the foreign files are reported');
assert.ok(r.removed.some((x) => x.endsWith('pak99_dir.vpk')));
assert.deepEqual(c.state().picks, {}, 'the picks are cleared');
assert.ok(!c.state().pending && !c.state().deployed);
assert.ok(c.presets().some((p) => p.auto), 'what was worn is kept in the automatic preset');
assert.deepEqual(c.removeAll().removed, [], 'nothing left to remove the second time');
console.log('REMOVE MODS OK');
