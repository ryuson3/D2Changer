/* The particle effects the item builder can put on top of an item: the effect's id, its name in
 * the picker, and the particle the game creates for it. What a pick then writes is
 * src/item-builder.ts, which callers import this through.
 *
 * Written by h6rd (https://github.com/h6rd) in #117, developed further with TheFleece
 * (https://github.com/TheFleece).
 * Copyright (C) 2026 h6rd
 * Copyright (C) 2026 TheFleece
 * SPDX-License-Identifier: GPL-3.0-or-later
 * The additional terms in NOTICE apply: whoever carries this code keeps both names here and in
 * the credits of the program it goes into.
 */
import { t } from './i18n.ts';

/** An effect the builder can add to an item: a particle it creates, or an animation modifier (`type: 'activity'`, with its `asset`).
 * `heroOnly`: offered on hero items only, not on the courier. `hero`: offered on that hero's items only (his id, as the window knows it);
 * `heroes`: the same for a gem that more than one hero wears (`hero` is then the first of them).
 * `kinetic`: a Kinetic Gem; the window lists these in a section of their own, apart from the effects. */
export type ItemEffect = { id: string; name: string; type: string; modifier: string; asset?: string; heroOnly?: boolean; hero?: string; heroes?: string[]; kinetic?: boolean; parts?: EffectPart[] };

/** One asset_modifier an effect writes. A Kinetic Gem is an entry of items_game's `asset_modifiers` table and carries several
 * (Bladekeeper's Omnislash: two particles and the ability's picture), so an effect may list them in `parts`; without it the
 * effect's own type / asset / modifier is its one part. */
export type EffectPart = { type: string; asset?: string; modifier: string };

/** The asset_modifier entries one effect writes. */
export function effectParts(effect: ItemEffect): EffectPart[] {
  return effect.parts?.length ? effect.parts : [{ type: effect.type, ...(effect.asset ? { asset: effect.asset } : {}), modifier: effect.modifier }];
}

/** Whether an effect swaps a file of the game for another (a particle, an ability's picture): the file is then copied under
 * the plain path (src/item-builder-assets.ts), so the entry has to be in the visuals before those are read. */
export function swapsFiles(effect: ItemEffect): boolean {
  return effectParts(effect).some((p) => p.type === 'ability_icon' || p.type === 'particle');
}

/** Every effect the builder offers, in the order the picker lists them. */
export const ITEM_EFFECTS: ItemEffect[] = [
  {
    id: 'fire',
    name: 'Огонь',
    type: 'particle_create',
    modifier: 'particles/econ/courier/courier_trail_lava/courier_trail_lava.vpcf',
  },
  {
    id: 'lightnings',
    name: 'Молнии',
    type: 'particle_create',
    modifier: 'particles/econ/courier/courier_platinum_roshan/platinum_roshan_ambient.vpcf',
  },
  {
    id: 'frostbloom',
    name: 'Иней',
    type: 'particle_create',
    modifier: 'particles/econ/seasonal/seasonal_ambient_silver.vpcf',
  },
  {
    id: 'snow',
    name: 'Снег',
    type: 'particle_create',
    modifier: 'particles/econ/seasonal/seasonal_ambient_snow.vpcf',
  },
  {
    id: 'sand-storm',
    name: 'Песчаная буря',
    type: 'particle_create',
    modifier: 'particles/econ/courier/courier_roshan_desert_sands/baby_roshan_desert_sands_ambient.vpcf',
  },
  {
    id: 'ghost',
    name: 'Призрак',
    type: 'particle_create',
    modifier: 'particles/econ/courier/courier_f2p/courier_f2p_10th_anniversary_ambient.vpcf',
  },
  {
    id: 'gold-glow',
    name: 'Gold Glow',
    type: 'particle_create',
    modifier: 'particles/econ/seasonal/new_bloom/seasonal_ambient_gold_glow.vpcf',
    heroOnly: true,
  },
  {
    id: 'smoke',
    name: 'Smoke',
    type: 'particle_create',
    modifier: 'particles/econ/seasonal/new_bloom/seasonal_ambient_smoke.vpcf',
    heroOnly: true,
  },
  {
    id: 'featherfall',
    name: 'Featherfall',
    type: 'particle_create',
    modifier: 'particles/econ/seasonal/crownfall/seasonal_ambient_screeauk.vpcf',
    heroOnly: true,
  },
  // Kinetic Gem: Fireborn Assault (Juggernaut). A kinetic gem is not a particle but an animation modifier:
  // items_game.txt keeps it in its `asset_modifiers` table as name "odachi", type "activity", asset "ALL".
  {
    id: 'kinetic-fireborn-assault',
    name: 'Kinetic: Fireborn Assault',
    type: 'activity',
    asset: 'ALL',
    modifier: 'odachi',
    heroOnly: true,
    hero: 'juggernaut',
    kinetic: true,
  },
  // Bladekeeper's Blade Dance / Bladefury / Omnislash / Healing Ward (Juggernaut): Kinetic Gems out of items_game's `asset_modifiers`
  // (entries 87, 84, 83 and 85). Each swaps the ability's particles for the Bladekeeper's and its picture for the Bladekeeper's.
  // The table's own `apply_when_equipped_in_ability_effects_slot` is left out: the files go under the plain paths (item-builder-assets.ts),
  // which no slot decides.
  {
    id: 'kinetic-bladekeeper-blade-dance',
    name: "Kinetic: Bladekeeper's Blade Dance",
    type: 'particle',
    asset: 'particles/units/heroes/hero_juggernaut/jugg_crit_blur.vpcf',
    modifier: 'particles/econ/items/juggernaut/bladekeeper_critical_strike/_dc_juggernaut_crit_blur.vpcf',
    parts: [
      { type: 'particle', asset: 'particles/units/heroes/hero_juggernaut/jugg_crit_blur.vpcf', modifier: 'particles/econ/items/juggernaut/bladekeeper_critical_strike/_dc_juggernaut_crit_blur.vpcf' },
      { type: 'ability_icon', asset: 'juggernaut_blade_dance', modifier: 'juggernaut/bladekeeper/juggernaut_blade_dance' },
    ],
    heroOnly: true,
    hero: 'juggernaut',
    kinetic: true,
  },
  {
    id: 'kinetic-bladekeeper-bladefury',
    name: "Kinetic: Bladekeeper's Bladefury",
    type: 'particle',
    asset: 'particles/units/heroes/hero_juggernaut/juggernaut_blade_fury.vpcf',
    modifier: 'particles/econ/items/juggernaut/bladekeeper_bladefury/_dc_juggernaut_blade_fury.vpcf',
    parts: [
      { type: 'particle', asset: 'particles/units/heroes/hero_juggernaut/juggernaut_blade_fury.vpcf', modifier: 'particles/econ/items/juggernaut/bladekeeper_bladefury/_dc_juggernaut_blade_fury.vpcf' },
      { type: 'ability_icon', asset: 'juggernaut_blade_fury', modifier: 'juggernaut/bladekeeper/juggernaut_blade_fury' },
    ],
    heroOnly: true,
    hero: 'juggernaut',
    kinetic: true,
  },
  {
    id: 'kinetic-bladekeeper-omnislash',
    name: "Kinetic: Bladekeeper's Omnislash",
    type: 'particle',
    asset: 'particles/units/heroes/hero_juggernaut/juggernaut_omni_slash_trail.vpcf',
    modifier: 'particles/econ/items/juggernaut/bladekeeper_omnislash/_dc_juggernaut_omni_slash_trail.vpcf',
    parts: [
      { type: 'particle', asset: 'particles/units/heroes/hero_juggernaut/juggernaut_omni_slash_trail.vpcf', modifier: 'particles/econ/items/juggernaut/bladekeeper_omnislash/_dc_juggernaut_omni_slash_trail.vpcf' },
      { type: 'particle', asset: 'particles/units/heroes/hero_juggernaut/juggernaut_omni_slash_tgt.vpcf', modifier: 'particles/econ/items/juggernaut/bladekeeper_omnislash/_dc_juggernaut_omni_slash_tgt.vpcf' },
      { type: 'ability_icon', asset: 'juggernaut_omni_slash', modifier: 'juggernaut/bladekeeper/juggernaut_omni_slash' },
    ],
    heroOnly: true,
    hero: 'juggernaut',
    kinetic: true,
  },
  {
    id: 'kinetic-bladekeeper-healing-ward',
    name: "Kinetic: Bladekeeper's Healing Ward",
    type: 'particle',
    asset: 'particles/units/heroes/hero_juggernaut/juggernaut_healing_ward.vpcf',
    modifier: 'particles/econ/items/juggernaut/bladekeeper_healing_ward/juggernaut_healing_ward_dc.vpcf',
    parts: [
      { type: 'particle', asset: 'particles/units/heroes/hero_juggernaut/juggernaut_healing_ward.vpcf', modifier: 'particles/econ/items/juggernaut/bladekeeper_healing_ward/juggernaut_healing_ward_dc.vpcf' },
      { type: 'ability_icon', asset: 'juggernaut_healing_ward', modifier: 'juggernaut/bladekeeper/juggernaut_healing_ward' },
    ],
    heroOnly: true,
    hero: 'juggernaut',
    kinetic: true,
  },
];

/** The effect variants the synthetic cosmetics/items picker can apply. `more`: the Kinetic Gems made from the game's own table (src/item-kinetics.ts). */
export function itemEffects(scope: 'hero' | 'courier' = 'hero', more: ItemEffect[] = []): { id: string; name: string; heroOnly?: boolean; hero?: string; heroes?: string[]; kinetic?: boolean }[] {
  const all = [...ITEM_EFFECTS, ...more.filter((m) => !ITEM_EFFECTS.some((e) => e.id === m.id))];
  const list = scope === 'courier' ? all.filter((e) => !e.heroOnly) : all;
  return [{ id: '', name: t('Без эффекта') }, ...list.map(({ id, name, heroOnly, hero, heroes, kinetic }) => ({ id, name: t(name), ...(heroOnly ? { heroOnly: true } : {}), ...(hero ? { hero } : {}), ...(heroes ? { heroes } : {}), ...(kinetic ? { kinetic: true } : {}) }))];
}

/** Whether an effect key (as effectKey writes it) carries an effect that is for hero items only. */
export function hasHeroOnlyEffect(key: string): boolean {
  const ids = new Set(String(key || '').split(',').map((x) => x.trim().toLowerCase()));
  // the Kinetic Gems made from the game's table (src/item-kinetics.ts) are all for heroes
  return ITEM_EFFECTS.some((e) => e.heroOnly && ids.has(e.id)) || [...ids].some((id) => id.startsWith('kinetic-'));
}
