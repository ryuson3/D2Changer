/* Kinetic Gems out of the game's own table.
 *
 * items_game.txt keeps every Kinetic Gem in its `asset_modifiers` table: an entry is a name (`odachi`,
 * `dc_bladekeeper_omnislash`), the localization key of its title and one or more parts, each an
 * asset_modifier of its own: an animation (`activity`), a particle swap (`particle`) or the picture of an
 * ability (`ability_icon`). The table says nothing about the hero a gem is for. That is read from what
 * the parts name: the ability's picture and the stock particle begin with the hero (`life_stealer_rage`,
 * `particles/units/heroes/hero_necrolyte/...`), and an animation is the one the hero's paid items switch on.
 *
 * The gems are made here from the table of the player's own game, so one that Valve adds shows up with the
 * next update. src/item-builder-effects.ts lists the ones that were written by hand first; those keep their ids
 * (a saved pick names them), and a gem of that list is not made a second time.
 */
import path from 'node:path';
import fs from 'node:fs';
import { listItems, blockBounds, eachChild } from './schema.ts';
import { sharedVpkIndex } from './vpk.ts';
import { itemHeroes, canonicalHeroId } from './item-builder-slots.ts';
import { ITEM_EFFECTS, effectParts, type ItemEffect, type EffectPart } from './item-builder-effects.ts';

/** An entry of the `asset_modifiers` table. `loc` is its title's key without the `#`. */
export interface AssetModifier { id: string; name: string; loc: string; parts: EffectPart[] }

/** The table's entries, in the order it lists them; none if this build of the game has no such table. */
export function assetModifiers(text: string): AssetModifier[] {
  const at = text.search(/^[ \t]*"asset_modifiers"[ \t]*\r?$/m);
  if (at < 0) return [];
  const out: AssetModifier[] = [];
  eachChild(text, blockBounds(text, at), (entry) => {
    if (!entry.isBlock) return;
    let name = '';
    let loc = '';
    const parts: EffectPart[] = [];
    eachChild(text, entry.body, (c) => {
      if (!c.isBlock) {
        const key = c.key.toLowerCase();
        if (key === 'name') name = c.value;
        else if (key === 'loc_key') loc = c.value.replace(/^#/, '');
        return;
      }
      // a part: "asset_modifier0" in the table's own spelling, a bare number in the older entries
      const f = new Map<string, string>();
      eachChild(text, c.body, (x) => { if (!x.isBlock) f.set(x.key.toLowerCase(), x.value); });
      const type = (f.get('type') || '').toLowerCase();
      const modifier = f.get('modifier');
      if (!modifier || !['activity', 'particle', 'ability_icon'].includes(type)) return;
      const asset = f.get('asset');
      parts.push({ type, ...(asset ? { asset } : {}), modifier });
    });
    if (name && parts.length) out.push({ id: entry.key, name, loc, parts });
  });
  return out;
}

/** The gems that only change the pictures of abilities (no animation, no particle): the ability-icon window offers these, not the Kinetics one. */
export function iconOnlyGems(text: string): AssetModifier[] {
  return assetModifiers(text).filter((e) => e.parts.every((p) => p.type === 'ability_icon'));
}

/** The hero an ability's picture or a stock particle belongs to, by what the hero's own names begin with. */
function heroOfParts(parts: EffectPart[], heroes: string[]): string | null {
  for (const p of parts) {
    const particle = /^particles\/units\/heroes\/hero_([a-z0-9_]+)\//i.exec(p.asset || '');
    if (p.type === 'particle' && particle && heroes.includes(particle[1].toLowerCase())) return particle[1].toLowerCase();
    const ability = (p.type === 'ability_icon' ? p.asset : '') || '';
    const hero = heroes.filter((h) => ability.toLowerCase().startsWith(`${h}_`)).sort((a, b) => b.length - a.length)[0];
    if (hero) return hero;
  }
  return null;
}

/** The hero a gem's own names (its name, its title key, the paths and modifiers of its parts) say: `pudge` in `pudge/crows_feet/...`. */
function heroInNames(names: string[], heroes: string[]): string | null {
  const hay = names.join(' ').toLowerCase();
  const hits = heroes.filter((h) => h.length >= 3 && new RegExp(`(?<![a-z0-9])${h}(?![a-z0-9])`).test(hay)).sort((a, b) => b.length - a.length);
  if (!hits.length) return null;
  return hits.every((h) => hits[0].includes(h)) ? hits[0] : null; // two different heroes: not told
}

/** For each animation name, the heroes whose items switch it on (an `activity` asset_modifier with that modifier). */
function animationHeroes(text: string, names: string[], strict = true): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!names.length) return out;
  const items = listItems(text);
  const starts = items.map((i) => i.start);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // strict: only an `activity` asset_modifier of an item names it; loose: the name quoted anywhere in an item (a gem that no
  // paid item switches on by its animation, like Pudge's hook animations, is still named by the item that carries it)
  const re = new RegExp(strict ? `"modifier"\\s+"(${escaped.join('|')})"` : `"#?(${escaped.join('|')})"`, 'g');
  const itemsEnd = items.length ? items[items.length - 1].end : 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > itemsEnd) break; // the table itself comes after the items
    // the item this text is in: the last one that starts before it
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= m.index) lo = mid; else hi = mid - 1; }
    const item = items[lo];
    if (!item || m.index >= item.end) continue;
    const block = text.slice(Math.max(item.start, m.index - 160), m.index);
    if (strict && !/"type"\s+"activity"/i.test(block)) continue; // the name also sits in particle paths and in other modifier types
    for (const hero of itemHeroes(text, item)) {
      const set = out.get(m[1]) || out.set(m[1], new Set()).get(m[1])!;
      set.add(canonicalHeroId(hero));
    }
  }
  return out;
}

/** "dc_bladekeeper_crit" -> "Dc Bladekeeper Crit": a title for a gem the localization does not name. */
const titleOf = (name: string): string => name.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** A kinetic's id: the id of the hand-written effect of the same gem when there is one, else made of its name. */
const KNOWN: Record<string, string> = {
  odachi: 'kinetic-fireborn-assault',
  dc_bladekeeper_omnislash: 'kinetic-bladekeeper-omnislash',
  dc_bladekeeper_bladefury: 'kinetic-bladekeeper-bladefury',
  dc_bladekeeper_crit: 'kinetic-bladekeeper-blade-dance',
  dc_bladekeeper_healing_ward: 'kinetic-bladekeeper-healing-ward',
};

/** Gems whose hero nothing in the table or the items tells (no item switches the animation on): Pudge's hook animations,
 * "Crow's Feet" (DOTA_Anim_Mod_ftp_dendi_back) and "Trapper's Treachery" (DOTA_Anim_Mod_Promo_Trapper_Weapon),
 * Phantom Lancer's "Serene Honor" (DOTA_Anim_Mod_Serene_Honor: one ACT_DOTA_LOADOUT animation, named by no item). */
const HERO_OF: Record<string, string[]> = {
  ftp_dendi_back: ['pudge'],
  trapper: ['pudge'],
  serene_honor: ['phantom_lancer'],
  // gems whose animation no paid item switches on (their hero is told by the gem's own title and the item it comes in)
  pyre: ['doom_bringer'],                      // Flames of the Pyre (Pyre)
  eyeoffetizu: ['doom_bringer'],               // Pits of Omoz (Eye of Omoz)
  f2p_doom: ['doom_bringer'],                  // Crown of Hells! (Crown of Gore)
  burning_fiend: ['doom_bringer'],             // Dominator's Stance (Burning Fiend)
  deadwinter_soul: ['lich'],                   // Deadwinter's Soul
  death_protest: ['necrolyte'],                // Twin Deaths' Haunting
  dizzying_punch: ['tusk'],                    // Dizzying Punch! (Snowball Stinger)
  wraith_spin: ['skeleton_king'],              // Wraith Spin (Shattered Destroyer)
  red_moon: ['lycan'],                         // Red Moon (a lone source; check it in game)
  turbulent_teleport: ['furion'],              // Turbulent Teleport (Savage Orchid)
  when_nature_attacks: ['furion'],             // When Nature Attacks
  dagger_twirl: ['queenofpain'],               // Allure of the Succubus (Tear of Agony)
  impatient_maiden: ['crystal_maiden'],        // Impatient Maiden (Blueheart Tails)
  glacier: ['crystal_maiden'],                 // Yulsaria's Glacier
  obeisance_of_the_keeper: ['keeper_of_the_light'], // Obeisance of the Keeper (Heaven Sent)
  twister: ['lina'],                           // Twister
  everlasting_array: ['lina'],                 // Everlasting Array (Everlasting Hair)
  triumphant_timelord: ['faceless_void'],      // Triumphant Timelord
  ss_fortune: ['storm_spirit'],                // Good Fortune Remnants
  es_prosperity: ['ember_spirit'],             // Prosperity Remnants
  swordonshoulder: ['dragon_knight'],          // The Knight's Repose (Ashtongue)
  fear: ['sven'],                              // Free to Fear (The Fearmaker)
  bot: ['tinker'],                             // Booties of Travel! (Mecha Boots of Travel Mk III)
  telebolt: ['rattletrap'],                    // Teleboltin'! (Telebolt Projektor)
  moth: ['death_prophet'],                     // Krobelus (Fluttering Mortis)
  windy: ['windrunner'],                       // Sylvan Cascade!
  fishstick: ['lion'],                         // Fish! (Fin King's Charm: told by the item)
  rampant: ['axe'],                            // Rampant Outrage (told by the item of that name)
  harlequin: ['rubick'],                       // Harlequin Animation (Wandering Harlequin: told by the items)
  moon_griffon: ['mirana'],                    // Moon Griffon (told by the item)
  // not found: iron ("Iron Tail!")
};

/** What a build of the table gave: the effects with the key of each one's title, which the caller's language file turns into a name. */
let cache: { text: string; list: { effect: ItemEffect; loc: string; iconOnly?: boolean }[]; orphans: AssetModifier[] } | null = null;

function madeFrom(text: string): { effect: ItemEffect; loc: string; iconOnly?: boolean }[] {
  if (cache && cache.text === text) return cache.list;
  const entries = assetModifiers(text);
  const have = new Set(ITEM_EFFECTS.map((e) => e.id));
  const heroes = [...new Set(listItems(text).filter((i) => i.prefab === 'default_item').flatMap((i) => itemHeroes(text, i)).map((h) => canonicalHeroId(h)))];
  const activityNames = [...new Set(entries.flatMap((e) => e.parts.filter((p) => p.type === 'activity').map((p) => p.modifier)))];
  const animated = animationHeroes(text, activityNames);
  const forEntry = new Map<AssetModifier, string[]>();
  const unresolved: AssetModifier[] = [];
  for (const entry of entries) {
    const fromActivity = [...new Set(entry.parts.filter((p) => p.type === 'activity').flatMap((p) => [...(animated.get(p.modifier) ?? [])]))].sort();
    const fromParts = heroOfParts(entry.parts, heroes);
    // an animation is the one the hero's items switch on; a particle or a picture names its hero; a gem with both (an animation
    // and a particle) is told by either one
    let list = HERO_OF[entry.name] ? [...HERO_OF[entry.name]] : entry.parts.every((p) => p.type === 'activity') ? fromActivity : fromParts ? [fromParts] : fromActivity;
    if (!list.length) {
      const named = heroInNames([entry.name, entry.loc, ...entry.parts.flatMap((p) => [p.asset || '', p.modifier])], heroes);
      if (named) list = [named];
    }
    forEntry.set(entry, list);
    if (!list.length) unresolved.push(entry);
  }
  // last: the items that carry the gem's own names (up to three heroes: a name that sits on many heroes' items is no help)
  if (unresolved.length) {
    // the gem's own names: its animation / particle names and the key of its title (an item of the game may carry the key: `#DOTA_Anim_Mod_Serene_Honor`)
    const loose = animationHeroes(text, [...new Set(unresolved.flatMap((e) => [...e.parts.map((p) => p.modifier), ...(e.loc ? [e.loc] : [])]))], false);
    for (const entry of unresolved) {
      const found = [...new Set([...entry.parts.map((p) => p.modifier), ...(entry.loc ? [entry.loc] : [])].flatMap((n) => [...(loose.get(n) ?? [])]))].sort();
      if (found.length && found.length <= 3) forEntry.set(entry, found);
    }
  }
  const used = new Set<string>();
  const orphans: AssetModifier[] = [];
  const list: { effect: ItemEffect; loc: string; iconOnly?: boolean }[] = [];
  for (const entry of entries) {
    let id = KNOWN[entry.name] || `kinetic-${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    if (have.has(id)) continue; // written by hand: ITEM_EFFECTS has it
    // two entries can share a name (Forge Master's Shockwave and Reverse Polarity): the second keeps the table's own number
    if (used.has(id)) id = `${id}-${entry.id}`;
    used.add(id);
    const forHero = forEntry.get(entry) ?? [];
    if (!forHero.length) { orphans.push(entry); continue; } // no hero to offer it to
    const first = entry.parts[0];
    list.push({
      loc: entry.loc,
      // a picture-only gem lives in the ability-icon window: it is not offered as a kinetic, but a pick saved before still resolves
      iconOnly: entry.parts.every((p) => p.type === 'ability_icon'),
      effect: {
        id,
        name: `Kinetic: ${titleOf(entry.name)}`,
        type: first.type,
        ...(first.asset ? { asset: first.asset } : {}),
        modifier: first.modifier,
        parts: entry.parts,
        heroOnly: true,
        hero: forHero[0],
        ...(forHero.length > 1 ? { heroes: forHero } : {}),
        kinetic: true,
      },
    });
  }
  cache = { text, list, orphans };
  return list;
}

/** The gems of the table that no hero could be found for (so they are offered to nobody): the tool tools/list-orphan-kinetics.ts prints them, to be named in HERO_OF. */
export function kineticOrphans(text: string): AssetModifier[] {
  madeFrom(text);
  return cache && cache.text === text ? cache.orphans : [];
}

/**
 * Every Kinetic Gem of this build of the game as an effect the item builder can put on a hero's item.
 * @param lang  the title of a localization key (`DOTA_Anim_Mod_Odachi` -> "Fireborn Assault"), when the game's language file is at hand
 */
export function kineticEffects(text: string, lang?: (key: string) => string | undefined): ItemEffect[] {
  return madeFrom(text).filter((m) => !m.iconOnly).map(({ effect, loc }) => {
    const title = lang && loc ? lang(loc) : undefined;
    return title ? { ...effect, name: `Kinetic: ${title}` } : effect;
  });
}

/** One kinetic by id, from this build of the game's table. */
export function kineticById(text: string, id: string): ItemEffect | null {
  return madeFrom(text).find((m) => m.effect.id === id)?.effect || null;
}

/* The titles of the gems, out of the game's own English language file: "DOTA_Anim_Mod_Odachi" is "Fireborn Assault". */
let titles: { key: string; map: Map<string, string> } | null = null;

function englishTitles(pak: string): Map<string, string> {
  const st = fs.statSync(pak);
  const key = `${pak}|${st.size}|${Math.floor(st.mtimeMs)}`;
  if (titles?.key === key) return titles.map;
  const map = new Map<string, string>();
  const file = sharedVpkIndex(pak).read('resource/localization/dota_english.txt');
  if (file) {
    const re = /"(DOTA_(?:Anim|Asset|Ability)_[^"]*)"\s+"([^"]*)"/gi;
    const body = file.toString('utf8');
    for (let m = re.exec(body); m; m = re.exec(body)) if (!map.has(m[1].toLowerCase())) map.set(m[1].toLowerCase(), m[2]);
  }
  titles = { key, map };
  return map;
}

/** The title of a gem's localization key (`DOTA_Asset_Mod_Surgical_Precision_Hook` -> "Surgical Precision Hook"), from the game's English file. */
export function gemTitles(gamePath: string): (key: string) => string | undefined {
  const map = englishTitles(path.join(gamePath, 'dota', 'pak01_dir.vpk'));
  return (key) => map.get(key.toLowerCase());
}

/**
 * The Kinetic Gems the window offers: the game's own, named as the game names them, and only those with something to
 * show in this build (an animation, or at least one of its particles or pictures is in the game's files).
 */
export function offeredKinetics(gamePath: string, text: string): ItemEffect[] {
  const pak = path.join(gamePath, 'dota', 'pak01_dir.vpk');
  const ix = sharedVpkIndex(pak);
  const map = englishTitles(pak);
  const has = (p: EffectPart): boolean => {
    if (p.type === 'activity') return true;
    const file = p.type === 'particle' ? `${p.modifier}_c` : `panorama/images/spellicons/${p.modifier}_png.vtex_c`;
    return ix.has(file.toLowerCase().replace(/\\/g, '/'));
  };
  // Terrorblade has no Kinetic Gems: the one the table names for him ("Horns of Inner Abysm") belongs to his arcana, which
  // brings it itself, so it is not offered as a gem to switch on. A pick saved earlier still resolves (kineticById).
  const noGems = (e: ItemEffect) => (e.heroes?.length ? e.heroes : [e.hero]).every((h) => h === 'terrorblade');
  return kineticEffects(text, (k) => map.get(k.toLowerCase())).filter((e) => !noGems(e) && effectParts(e).some(has));
}
