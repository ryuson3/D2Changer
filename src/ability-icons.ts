// Ability icons: which picture a hero's ability shows, chosen from the ones the game already has.
//
// Where the variants come from: a paid item can swap an ability's picture. Its `visuals` block has an
// asset_modifier of type "ability_icon" (asset = the ability, modifier = the picture it shows), and the
// picture sits in the game's own pak01 as panorama/images/spellicons/<name>_png.vtex_c. The item
// builder (item-builder-assets.ts) already copies that picture when the item is worn. Here the same
// pictures are offered on their own: the plain one, the golden Immortal one, a red one... without
// wearing the item. A pick puts the variant's file under the ability's plain path in our pak.
//
// Nothing is drawn or converted: the files are Valve's own, copied byte for byte.
import path from 'node:path';
import { sharedVpkIndex, heroDisplayName } from './vpk.ts';
import { listItems, eachChild, blockBounds, toUtf8 } from './schema.ts';
import { itemHeroes } from './item-builder-slots.ts';
import { normalizeAssetPath } from './item-builder-assets.ts';
import type { AssetCopy } from './item-builder-slots.ts';
import { iconOnlyGems } from './item-kinetics.ts';

/** One picture an ability can show. `icon` is the file name under spellicons, without the extension. */
export interface IconVariant { icon: string; label: string }
export interface AbilityIcons { ability: string; name: string; variants: IconVariant[] }
export interface HeroIcons { hero: string; name: string; abilities: AbilityIcons[] }

/** The path of a spell picture inside pak01 (compiled). */
export const spellPath = (name: string): string => `panorama/images/spellicons/${normalizeAssetPath(name)}_png.vtex_c`;

const canonicalHero = (hero: string): string => {
  const clean = hero.toLowerCase().replace(/^npc_dota_hero_/, '');
  return clean === 'io' ? 'wisp' : clean;
};

/** "antimage_blink" for hero "antimage" -> "Blink". */
function prettyAbility(ability: string, hero: string): string {
  let n = ability;
  if (n.startsWith(hero + '_')) n = n.slice(hero.length + 1);
  return n.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || ability;
}

/**
 * Every ability that has more than one picture in this build of the game, by hero. The plain picture is
 * always the first variant (icon = the ability's own name); the others come from the items that swap it,
 * and only those whose file really is in pak01 are listed.
 */
export function abilityIconCatalog(
  gamePath: string,
  text: string,
  log: (msg: string) => void = () => {},
  /** the title of a gem's localization key, when the game's language file is at hand */
  titleOf: (key: string) => string | undefined = () => undefined,
): HeroIcons[] {
  const ix = sharedVpkIndex(path.join(gamePath, 'dota', 'pak01_dir.vpk'));
  const has = (name: string) => ix.has(spellPath(name)) || ix.has(spellPath(name).toLowerCase());
  // hero -> ability -> icon -> item names
  const found = new Map<string, Map<string, Map<string, Set<string>>>>();
  // what the build says about itself, for the log: which picture-like swaps exist, and which were left out and why
  const iconTypes = new Map<string, number>();
  const dropped: string[] = [];
  for (const item of listItems(text)) {
    if (!item.hasVisuals) continue;
    const swaps: { ability: string; icon: string }[] = [];
    eachChild(text, blockBounds(text, item.start), (c) => {
      if (!c.isBlock || c.key.toLowerCase() !== 'visuals') return;
      eachChild(text, c.body, (m) => {
        if (!m.isBlock || !/^asset_modifier\d*$/i.test(m.key)) return;
        const f = new Map<string, string>();
        eachChild(text, m.body, (x) => { if (!x.isBlock) f.set(x.key.toLowerCase(), x.value); });
        const type = (f.get('type') || '').toLowerCase();
        if (/icon/.test(type)) iconTypes.set(type, (iconTypes.get(type) || 0) + 1);
        if (type === 'ability_icon' && f.get('asset') && f.get('modifier')) {
          swaps.push({ ability: normalizeAssetPath(f.get('asset')), icon: normalizeAssetPath(f.get('modifier')) });
        }
      });
    });
    if (!swaps.length) continue;
    const heroes = itemHeroes(text, item).map(canonicalHero);
    if (!heroes.length) { dropped.push(`item without a hero: ${toUtf8(item.name)} (${swaps.map((x) => x.icon).join(', ')})`); continue; }
    const label = toUtf8(item.name);
    for (const hero of heroes) {
      const byAbility = found.get(hero) || new Map();
      found.set(hero, byAbility);
      for (const s of swaps) {
        if (s.icon === s.ability) continue;
        const byIcon = byAbility.get(s.ability) || new Map();
        byAbility.set(s.ability, byIcon);
        (byIcon.get(s.icon) || byIcon.set(s.icon, new Set()).get(s.icon)!).add(label);
      }
    }
  }
  // the Kinetic Gems that only change pictures ("Surgical Precision Hook"): each picture is one more variant of its ability. The
  // hero is the one the ability's name begins with (`pudge_meat_hook`).
  const heroIds = [...new Set(listItems(text).filter((i) => i.prefab === 'default_item').flatMap((i) => itemHeroes(text, i)).map(canonicalHero))];
  for (const gem of iconOnlyGems(text)) {
    const label = (gem.loc && titleOf(gem.loc)) || gem.name.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    for (const p of gem.parts) {
      if (!p.asset) continue;
      const ability = normalizeAssetPath(p.asset);
      const icon = normalizeAssetPath(p.modifier);
      if (icon === ability) continue;
      const hero = heroIds.filter((h) => ability.startsWith(`${h}_`)).sort((a, b) => b.length - a.length)[0];
      if (!hero) { dropped.push(`gem ${gem.name}: no hero for ${ability}`); continue; }
      const byAbility = found.get(hero) || new Map();
      found.set(hero, byAbility);
      const byIcon = byAbility.get(ability) || new Map();
      byAbility.set(ability, byIcon);
      (byIcon.get(icon) || byIcon.set(icon, new Set()).get(icon)!).add(label);
    }
  }
  const out: HeroIcons[] = [];
  for (const [hero, byAbility] of found) {
    const abilities: AbilityIcons[] = [];
    for (const [ability, byIcon] of byAbility) {
      if (!has(ability)) { dropped.push(`${hero}: ${ability} has no picture of its own at ${spellPath(ability)}; its ${byIcon.size} variants are not offered`); continue; }
      const variants: IconVariant[] = [{ icon: ability, label: '' }];
      for (const [icon, items] of byIcon) {
        if (has(icon)) variants.push({ icon, label: [...items].slice(0, 2).join(', ') });
        else dropped.push(`${hero}: ${ability} -> ${icon} not offered, ${spellPath(icon)} is not in pak01 (${[...items].slice(0, 2).join(', ')})`);
      }
      if (variants.length > 1) abilities.push({ ability, name: prettyAbility(ability, hero), variants });
    }
    if (abilities.length) out.push({ hero, name: heroDisplayName(hero), abilities: abilities.sort((a, b) => a.ability.localeCompare(b.ability)) });
  }
  log(`ability icons: swap types seen: ${[...iconTypes].map(([t, n]) => `${t}=${n}`).join(', ') || 'none'}; ${out.reduce((n, h) => n + h.abilities.length, 0)} abilities offered, ${dropped.length} variants left out`);
  for (const line of dropped.slice(0, 80)) log(`ability icons: ${line}`);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** What a set of picks asks of the game's files: each chosen picture copied under its ability's own path. */
export function iconCopies(picks: Record<string, string>): AssetCopy[] {
  return Object.entries(picks)
    .filter(([ability, icon]) => icon && icon !== ability)
    .map(([ability, icon]) => ({ from: spellPath(icon), to: spellPath(ability), optional: true }));
}
