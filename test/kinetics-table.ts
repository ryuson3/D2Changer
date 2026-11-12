// Kinetic Gems out of the game's own `asset_modifiers` table: entries, ids, the hero each is offered to, a pick of one.
import assert from 'node:assert/strict';
import * as itemBuilder from '../src/item-builder.ts';
import { assetModifiers, kineticEffects, kineticById, iconOnlyGems } from '../src/item-kinetics.ts';

const NL = '\r\n';
const item = (id: string, fields: string) => `\t\t"${id}"${NL}\t\t{${NL}${fields}\t\t}${NL}`;
const f = (k: string, v: string) => `\t\t\t"${k}"\t\t"${v}"${NL}`;
const heroes = (...h: string[]) => `\t\t\t"used_by_heroes"${NL}\t\t\t{${NL}${h.map((x) => `\t\t\t\t"npc_dota_hero_${x}"\t\t"1"${NL}`).join('')}\t\t\t}${NL}`;
const mod = (n: string, type: string, asset: string, modifier: string) => `\t\t\t"${n}"${NL}\t\t\t{${NL}${f('type', type)}${f('asset', asset)}${f('modifier', modifier)}\t\t\t}${NL}`;
const entry = (id: string, name: string, loc: string, ...mods: string[]) => `\t\t"${id}"${NL}\t\t{${NL}${f('name', name)}${f('loc_key', `#${loc}`)}${mods.join('')}\t\t}${NL}`;

const text = `"items_game"${NL}{${NL}\t"items"${NL}\t{${NL}`
  + item('6', f('name', "Juggernaut's Mask") + f('prefab', 'default_item') + f('item_slot', 'head') + heroes('juggernaut'))
  + item('11', f('name', "Pudge's Hook Arm") + f('prefab', 'default_item') + f('item_slot', 'weapon') + heroes('pudge'))
  // a paid item that carries the gem's name outside an activity modifier: how a gem no item switches on gets its hero
  + item('7010', f('name', 'Pauldron Perch') + f('prefab', 'wearable') + f('item_slot', 'shoulder') + heroes('pudge') + f('socket_gem', 'hook_crow'))
  + item('9', f('name', "Disruptor's Hat") + f('prefab', 'default_item') + f('item_slot', 'head') + heroes('disruptor'))
  // a paid sword whose visuals switch the "odachi" animation on: that is how the animation's hero is known
  + item('7001', f('name', 'Odachi Sword') + f('prefab', 'wearable') + f('item_slot', 'head') + heroes('juggernaut')
    + `\t\t\t"visuals"${NL}\t\t\t{${NL}${mod('asset_modifier0', 'activity', 'ALL', 'odachi')}\t\t\t}${NL}`)
  + item('7002', f('name', 'Plain Wearable') + f('prefab', 'wearable') + f('item_slot', 'head') + heroes('juggernaut'))
  + Array.from({ length: 1200 }, (_, i) => item(String(20000 + i), f('name', `filler ${i}`))).join('')
  + `\t}${NL}\t"asset_modifiers"${NL}\t{${NL}`
  + entry('3', 'odachi', 'DOTA_Anim_Mod_Odachi', mod('asset_modifier0', 'activity', 'ALL', 'odachi'))
  + entry('87', 'dc_bladekeeper_crit', 'DOTA_Asset_Mod_DC_Bladekeeper_Crit',
    mod('asset_modifier0', 'particle', 'particles/units/heroes/hero_juggernaut/jugg_crit_blur.vpcf', 'particles/econ/items/juggernaut/bladekeeper_critical_strike/_dc_juggernaut_crit_blur.vpcf'),
    mod('asset_modifier1', 'ability_icon', 'juggernaut_blade_dance', 'juggernaut/bladekeeper/juggernaut_blade_dance'))
  + entry('139', 'resistive_pinfold_kinetic_field_icon', 'DOTA_Asset_Mod_Resistive_Pinfold_Kinetic_Field_Icon',
    mod('asset_modifier0', 'ability_icon', 'disruptor_kinetic_field', 'disruptor/resistive_pinfold/disruptor_kinetic_field'))
  // two entries with one name, and one whose hero nobody can tell
  + entry('61', 'forgemaster_shockwave', 'DOTA_Asset_Mod_A', mod('asset_modifier0', 'ability_icon', 'disruptor_static_storm', 'x/a'))
  + entry('64', 'forgemaster_shockwave', 'DOTA_Asset_Mod_B', mod('asset_modifier0', 'ability_icon', 'disruptor_thunder_strike', 'x/b'))
  // Pudge's hook gems: animations only; one is told by the item that carries its name, the other by its own name
  + entry('201', 'crows_feet', 'DOTA_Anim_Mod_Crows_Feet', mod('asset_modifier0', 'activity', 'ALL', 'hook_crow'))
  + entry('202', 'pudge_trappers_treachery', 'DOTA_Anim_Mod_Trappers_Treachery',
    mod('asset_modifier0', 'activity', 'ALL', 'trapper_spawn'), mod('asset_modifier1', 'activity', 'ALL', 'trapper_run'),
    mod('asset_modifier2', 'activity', 'ALL', 'trapper_attack'))
  // an animation and a particle in one gem, the particle not under the hero's own folder
  + entry('203', 'mixed_gem', 'DOTA_Anim_Mod_Mixed', mod('asset_modifier0', 'activity', 'ALL', 'mixed_anim'),
    mod('asset_modifier1', 'particle', 'particles/units/heroes/hero_disruptor/x.vpcf', 'particles/econ/items/disruptor/x.vpcf'))
  + entry('204', 'ftp_dendi_back', 'DOTA_Anim_Mod_ftp_dendi_back', mod('asset_modifier0', 'activity', 'ALL', 'ftp_dendi_back'))
  + entry('111', 'trapper', 'DOTA_Anim_Mod_Promo_Trapper_Weapon', mod('0', 'activity', 'ALL', 'trapper'))
  + entry('205', 'pudge_hook_icon', 'DOTA_Asset_Mod_Pudge_Hook_Icon', mod('0', 'ability_icon', 'pudge_meat_hook', 'pudge/x/pudge_meat_hook'))
  + entry('1', 'nohero_gem', 'DOTA_Anim_Mod_NoHero', mod('asset_modifier0', 'activity', 'ALL', 'nohero_gem'))
  + `\t}${NL}}${NL}`;

assert.equal(assetModifiers(text).length, 12);
const gems = kineticEffects(text, (k) => ({ DOTA_Anim_Mod_Odachi: 'Fireborn Assault' } as Record<string, string>)[k]);
const byId = new Map(gems.map((g) => [g.id, g]));

// the hand-written ones keep their ids and are not made twice
assert.ok(!byId.has('kinetic-fireborn-assault') && !byId.has('kinetic-bladekeeper-blade-dance'));
// picture-only gems are not kinetics any more (the ability-icon window has them), whatever their hero
assert.ok(!byId.has('kinetic-resistive-pinfold-kinetic-field-icon'));
assert.ok(!byId.has('kinetic-forgemaster-shockwave') && !byId.has('kinetic-forgemaster-shockwave-64'));
// an animation no item switches on has no hero to be offered to: left out
assert.ok(!byId.has('kinetic-nohero-gem'));
// Pudge's animation gems are offered to Pudge, by the item that carries the name and by the gem's own name
assert.deepEqual(byId.get('kinetic-crows-feet')?.heroes ?? [byId.get('kinetic-crows-feet')?.hero], ['pudge']);
assert.equal(byId.get('kinetic-pudge-trappers-treachery')?.hero, 'pudge');
assert.equal(byId.get('kinetic-pudge-trappers-treachery')?.parts?.length, 3);
assert.equal(byId.get('kinetic-ftp-dendi-back')?.hero, 'pudge');
assert.equal(byId.get('kinetic-trapper')?.hero, 'pudge');
// a gem that only changes a picture is no kinetic: the ability-icon window offers it
assert.equal(byId.get('kinetic-pudge-hook-icon'), undefined);
assert.equal(iconOnlyGems(text).some((g) => g.name === 'pudge_hook_icon'), true);
// a gem of an animation and a particle is told by its particle
assert.equal(byId.get('kinetic-mixed-gem')?.hero, 'disruptor');
// everything made is a kinetic, for heroes only
assert.ok(gems.every((g) => g.kinetic && g.heroOnly && g.hero));
assert.equal(kineticById(text, 'kinetic-mixed-gem')?.id, 'kinetic-mixed-gem');
// a pick saved when picture-only gems were still kinetics keeps resolving (it is just no longer offered)
assert.equal(kineticById(text, 'kinetic-pudge-hook-icon')?.id, 'kinetic-pudge-hook-icon');
assert.equal(kineticById(text, 'kinetic-nope'), null);

// a pick of a made gem: its entry in the visuals and the file copied under the plain path
const r = itemBuilder.itemEffectPatch(text, 7002, ['kinetic-mixed-gem']);
assert.ok(r.block.length > 0);
assert.match(r.block, /"type"\s+"particle"/);

// the courier never takes a gem
assert.equal(itemBuilder.hasHeroOnlyEffect('fire,kinetic-anything'), true);
assert.throws(() => itemBuilder.itemEffectPatch(text, 7002, ['kinetic-nope']), /kinetic-nope/);
console.log('KINETICS TABLE OK');
