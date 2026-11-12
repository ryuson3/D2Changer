/* The item builder: a hero's stock item built from one of its wearables, with an effect on top.
 *
 * For each hero and slot the free cosmetics offer that hero's wearables. Picking one rewrites its
 * block in items_game under the stock item's id, name and prefab=default_item, drops the styles
 * and unlocks a free base item cannot use, adds the chosen particle effect to its visuals, and
 * lists the model and particles to copy out of the game's pak01 under the stock paths, so the
 * game draws the wearable where the stock item was. An arcana that swaps the whole hero brings its
 * hero model too, under the plain hero's. src/schema-service.ts applies it along with
 * the rest of the free cosmetics; src/schema.ts reads and merges the table.
 *
 * What the builder offers (slots, sets, effects) is src/item-builder-slots.ts, re-exported here;
 * this file is what a pick writes.
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
import {
  findItem, itemFields, listItems, eachChild, blockBounds, stripKeyBlocks, inferredItemSlot,
  type SchemaItem,
} from './schema.ts';
import {
  canonicalItemSlot, isPersonaItem, itemHeroes, matchItemSlot,
} from './item-builder-slots.ts';
import { ITEM_EFFECTS, effectParts, swapsFiles, type ItemEffect } from './item-builder-effects.ts';
import { kineticById } from './item-kinetics.ts';
import { itemAssets, normalizeAssetPath, type ItemAssets } from './item-builder-assets.ts';
import { styleOf, withStyle } from './item-builder-styles.ts';

export { itemSlots, itemSlotsSteps, itemSets, itemOptions } from './item-builder-slots.ts';
export { itemEffects, hasHeroOnlyEffect } from './item-builder-effects.ts';
export { offeredKinetics } from './item-kinetics.ts';
export { itemHeroes as heroesOfItem } from './item-builder-slots.ts';
export { styleOf as styleOfKey } from './item-builder-styles.ts';
export { gameAssetEntries } from './item-builder-assets.ts';
export type { ItemSlot, ItemSet, AssetCopy } from './item-builder-slots.ts';

// ---------- reading the game's own schema ----------

function setScalarField(blockText: string, key: string, value: string): string {
  const body = blockBounds(blockText, 0);
  let hit = null as { start: number; end: number } | null;
  eachChild(blockText, body, (c) => {
    if (!hit && !c.isBlock && c.key.toLowerCase() === key.toLowerCase()) hit = c;
  });
  const line = `"${key}"\t\t"${value}"`;
  if (hit) return blockText.slice(0, hit.start) + line + blockText.slice(hit.end);
  const close = blockText.lastIndexOf('}');
  return close === -1 ? blockText : `${blockText.slice(0, close)}\r\n\t${line}\r\n${blockText.slice(close)}`;
}

function setVisualsBlock(blockText: string, visuals: string): string {
  const body = blockBounds(blockText, 0);
  let hit = null as { start: number; end: number } | null;
  eachChild(blockText, body, (c) => {
    if (!hit && c.isBlock && c.key.toLowerCase() === 'visuals') hit = c;
  });
  const clean = visuals.trim();
  if (hit) return blockText.slice(0, hit.start) + clean + blockText.slice(hit.end);
  const close = blockText.lastIndexOf('}');
  return close === -1 ? blockText : `${blockText.slice(0, close)}\r\n\t${clean}\r\n${blockText.slice(close)}`;
}

/** An effect by id: the ones listed in src/item-builder-effects.ts, and, given the game's table, its Kinetic Gems (src/item-kinetics.ts). */
function itemEffectById(effectId: unknown, text?: string): ItemEffect | null {
  const want = String(effectId || '').trim().toLowerCase();
  return ITEM_EFFECTS.find((e) => e.id === want) || (text && want.startsWith('kinetic-') ? kineticById(text, want) : null);
}

/**
 * The effects of one pick as one string: ids in the order ITEM_EFFECTS lists them, each once,
 * comma separated, '' for none. A pick carries several (the window says "you can pick several"),
 * and this is how a record stores them and how two picks are told apart, so "fire,snow" and
 * "snow,fire" are the same pick.
 *
 * A style other than the item's first goes last, as "style-2" (src/item-builder-styles.ts). It
 * rides in the same string so that a record, a preset and a shared link carry it as they carry the
 * effects, with nothing new to keep in step; the first style is no token at all, which keeps every
 * pick made before styles could be chosen the same pick.
 */
export function effectKey(effectIds: string | string[] | null | undefined): string {
  const ids = (Array.isArray(effectIds) ? effectIds : String(effectIds || '').split(','))
    .map((id) => String(id).trim().toLowerCase())
    .filter(Boolean);
  const want = new Set(ids.filter((id) => !/^style-\d+$/.test(id)));
  const known = ITEM_EFFECTS.map((e) => e.id).filter((id) => want.has(id));
  // an id nobody offers stays in, at the end, so the build can say which one it did not know
  const unknown = [...want].filter((id) => !known.includes(id)).sort();
  const style = styleOf(ids.join(','));
  return [...known, ...unknown, ...(style ? [`style-${style}`] : [])].join(',');
}

/** A visuals block without its `particle_create` entries (the item's own ambient particles). */
function withoutOwnParticles(visuals: string): string {
  const cut: { start: number; end: number }[] = [];
  eachChild(visuals, blockBounds(visuals, 0), (c) => {
    if (!c.isBlock || !/^asset_modifier\d*$/i.test(c.key)) return;
    let type = '';
    eachChild(visuals, c.body, (x) => { if (!x.isBlock && x.key.toLowerCase() === 'type') type = x.value.toLowerCase(); });
    if (type === 'particle_create') cut.push({ start: c.start, end: c.end });
  });
  let out = visuals;
  for (const r of cut.reverse()) out = out.slice(0, r.start) + out.slice(r.end);
  return out;
}

function setBlockId(blockText: string, id: string): string {
  return String(blockText).replace(/^\s*"\d+"/, `"${id}"`);
}


function itemBlock(text: string, item: { start: number; end: number }): string {
  return text.slice(item.start, item.end);
}

function itemVisuals(text: string, item: { start: number }): string | null {
  let visuals = null as string | null;
  eachChild(text, blockBounds(text, item.start), (c) => {
    if (c.isBlock && c.key.toLowerCase() === 'visuals') visuals = text.slice(c.start, c.end);
  });
  return visuals;
}

/**
 * The model swaps an item's visuals list: a model of another wearable -> the model to show in its place, as
 * normalizeAssetPath writes the first. An arcana carries these for the paid wearables that do not fit its body
 * (Queen of Pain's lists forty: a refit of each shoulders item), and the game applies one when both are worn.
 * A wearable the builder puts under a stock path is no longer named by it, so the pick takes the refit itself
 * (cosmetics.ts): without it the item stays the plain-body one and sinks into the arcana's.
 * @param style  the item's chosen style: an entry marked for another style is not its swap
 */
export function modelSwaps(baseText: string, itemId: string | number, style = 0): Map<string, string> {
  const out = new Map<string, string>();
  const source = findItem(baseText, itemId);
  const visuals = source ? itemVisuals(baseText, source) : null;
  if (!visuals) return out;
  eachChild(visuals, blockBounds(visuals, 0), (c) => {
    if (!c.isBlock || !/^asset_modifier\d*$/i.test(c.key)) return;
    const f = new Map<string, string>();
    eachChild(visuals, c.body, (x) => { if (!x.isBlock) f.set(x.key.toLowerCase(), x.value); });
    const at = f.get('style');
    if ((f.get('type') || '').toLowerCase() !== 'model' || !f.get('asset') || !f.get('modifier')) return;
    if (at !== undefined && at !== String(style)) return;
    const from = normalizeAssetPath(f.get('asset'));
    if (!out.has(from)) out.set(from, f.get('modifier')!);
  });
  return out;
}

function sameHeroes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}

/** The stock default_item that matches a wearable by slot and by the hero(es) that can equip it. */
export function defaultItemForWearable(text: string, sourceId: string | number): SchemaItem | null {
  const source = findItem(text, sourceId);
  if (!source) throw new Error(t('items_game: предмет {0} не найден', sourceId));
  const sourceFields = itemFields(text, source);
  const sourceLite = listItems(text).find((i) => i.id === source.id) || null;
  if (sourceLite && isPersonaItem(sourceLite)) return null;
  const sourceSlot = canonicalItemSlot(sourceFields.get('item_slot') || inferredItemSlot(sourceLite));
  if (!sourceSlot) return null;
  const sourceMatchSlot = matchItemSlot(sourceSlot);
  const sourceHeroes = itemHeroes(text, source);
  const exact = listItems(text)
    .filter((i) => i.id !== source.id && canonicalItemSlot(inferredItemSlot(i)) === sourceSlot && i.prefab === 'default_item' && !isPersonaItem(i))
    .map((i) => ({ item: i, heroes: itemHeroes(text, i) }))
    .filter((x) => sameHeroes(x.heroes, sourceHeroes))
    .map((x) => x.item)
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (exact.length) return exact[0];
  return listItems(text)
    .filter((i) => i.id !== source.id && matchItemSlot(inferredItemSlot(i)) === sourceMatchSlot && i.prefab === 'default_item' && !isPersonaItem(i))
    .map((i) => ({ item: i, heroes: itemHeroes(text, i) }))
    .filter((x) => sameHeroes(x.heroes, sourceHeroes))
    .map((x) => x.item)
    .sort((a, b) => Number(a.id) - Number(b.id))[0] || null;
}

/**
 * The visuals without the model swaps the built files already make: the hero's own model swapped
 * for an arcana's, and a stock item's model for another, where the pick puts that model under the
 * plain path, and a hero's other form swapped for the item's (hero_model_change) the same way.
 * Each left in names a model only the paid item loads.
 *
 * The game wears an item's model only once it is loaded, and what a match loads is what the
 * server's own item table names: the stock paths. Joining a match the client loaded the paid
 * models with the hero, so the swaps worked; after a reconnect it did not, and the console said
 * "Attempting to set nonresident model 'models/items/earthshaker/es_cosmic/es_cosmic_totem.vmdl'
 * for item Def 459", the totem an ERROR model and the rest the plain hero (2026-10-18). Under the
 * stock paths the same files are loaded either way.
 * @param heroes  the heroes whose own model the pick puts under their path
 * @param stock  the stock models the pick puts another model under, as normalizeAssetPath writes them
 */
function withoutFileSwaps(visuals: string, heroes: Set<string>, stock: Set<string>): string {
  const cut: { start: number; end: number }[] = [];
  eachChild(visuals, blockBounds(visuals, 0), (c) => {
    if (!c.isBlock || !/^asset_modifier\d*$/i.test(c.key)) return;
    const fields = new Map<string, string>();
    eachChild(visuals, c.body, (f) => { if (!f.isBlock) fields.set(f.key.toLowerCase(), f.value); });
    const type = (fields.get('type') || '').toLowerCase();
    const asset = fields.get('asset') || '';
    if ((type === 'entity_model' && heroes.has(asset.toLowerCase()))
      || ((type === 'model' || type === 'hero_model_change') && stock.has(normalizeAssetPath(asset)))) cut.push(c);
  });
  let out = visuals;
  for (const c of cut.reverse()) {
    let start = c.start;
    while (start > 0 && /[ \t\r\n]/.test(out[start - 1])) start--;
    out = out.slice(0, start) + out.slice(c.end);
  }
  return out;
}

/** An effect written into the visuals: each of its entries (a Kinetic Gem has several). */
function appendItemEffect(visuals: string, effect: ItemEffect): string {
  return effectParts(effect).reduce((out, part) => appendEffectPart(out, part), visuals);
}

function appendEffectPart(visuals: string, effect: { type: string; asset?: string; modifier: string }): string {
  const needle = String(effect.modifier || '').toLowerCase();
  const asset = effect.asset ? `\r\n\t"asset"\t\t"${effect.asset}"` : '';
  const block = `"asset_modifier"\r\n{\r\n\t"type"\t\t"${effect.type}"${asset}\r\n\t"modifier"\t\t"${effect.modifier}"\r\n}`;
  if (effect.type === 'activity') {
    // An animation modifier's name ("odachi") also sits inside the item's own particle paths, so a plain text search
    // would think it is there already: look at the asset_modifier entries themselves.
    let have = false;
    eachChild(visuals, blockBounds(visuals, 0), (c) => {
      if (!c.isBlock || !/^asset_modifier\d*$/i.test(c.key)) return;
      let type = '', modifier = '';
      eachChild(visuals, c.body, (x) => {
        const k = x.key.toLowerCase();
        if (!x.isBlock && k === 'type') type = x.value.toLowerCase();
        else if (!x.isBlock && k === 'modifier') modifier = x.value.toLowerCase();
      });
      if (type === 'activity' && modifier === needle) have = true;
    });
    if (have) return visuals;
    const end = visuals.lastIndexOf('}');
    if (end === -1) return visuals;
    return `${visuals.slice(0, end).replace(/\s*$/, '')}\r\n\t${block}\r\n${visuals.slice(end)}`;
  }
  if (needle && visuals.toLowerCase().includes(needle)) return visuals;
  // set from inside the walk, which is why they are widened by hand
  let after = null as number | null;
  let before = null as number | null;
  eachChild(visuals, blockBounds(visuals, 0), (c) => {
    if (!c.isBlock || c.key.toLowerCase() !== 'asset_modifier') return;
    const fields = new Map<string, string>();
    eachChild(visuals, c.body, (f) => { if (!f.isBlock) fields.set(f.key.toLowerCase(), f.value); });
    const type = (fields.get('type') || '').toLowerCase();
    if (type === 'particle_create') after = c.end;
    else if (after !== null && before === null) before = c.start;
  });
  const close = visuals.lastIndexOf('}');
  const at = before ?? after ?? close;
  if (at === -1) return visuals;
  const prefix = '\r\n\t';
  const suffix = before === null ? '\r\n' : '\r\n\t';
  return `${visuals.slice(0, at)}${prefix}${block}${suffix}${visuals.slice(at)}`;
}

/**
 * Effects on top of any item block: the same particles the hero items take, appended to the block's
 * visuals (made if it has none). Used for the free cosmetics that can carry effects (the courier).
 */
export function withItemEffects(block: string, effectIds: string | string[] | null | undefined): string {
  const effects = effectKey(effectIds).split(',').filter((id) => id && !/^style-\d+$/.test(id)).map((id) => {
    const effect = itemEffectById(id);
    if (!effect) throw new Error(t('items_game: эффект {0} не найден', id));
    return effect;
  });
  if (!effects.length) return block;
  let visuals = null as string | null;
  eachChild(block, blockBounds(block, 0), (c) => {
    if (c.isBlock && c.key.toLowerCase() === 'visuals') visuals = block.slice(c.start, c.end);
  });
  let out = visuals ?? '"visuals"\r\n{\r\n}';
  for (const effect of effects) out = appendItemEffect(out, effect);
  return setVisualsBlock(block, out);
}

/* Turn one paid wearable into the hero's stock item for that slot.
 *
 * The block stays the donor item almost verbatim: only the header is rewritten to the matching
 * default_item (id + name + prefab), styles/unlocks that cannot be used on a free base item are
 * dropped (the chosen style, if not the first, stays as the only one: src/item-builder-styles.ts),
 * and the chosen effect is inserted into visuals. assetCopies describe the stock-path overrides the
 * built VPK carries, and sounds and voices the soundevents it rewrites (src/item-sounds.ts).
 *
 * A model the VPK carries under a stock path is named by that path, not the paid item's: the stock
 * item's model_player, and no swap of the hero's model or of a stock model left in the visuals
 * (withoutFileSwaps says why). The particles keep the paid item's paths: the game loads a particle
 * when it is created, and a reconnect keeps them.
 */
export function itemEffectPatch(baseText: string, itemId: string | number, effectIds: string | string[] | null | undefined, avoid?: Set<string>): { id: string; block: string } & ItemAssets {
  const source = findItem(baseText, itemId);
  if (!source) throw new Error(t('items_game: предмет {0} не найден', itemId));
  const target = defaultItemForWearable(baseText, itemId);
  if (!target) throw new Error(t('items_game: default_item для предмета {0} не найден', itemId));
  const key = effectKey(effectIds);
  // several at once: the window offers them that way, and one unknown id refuses the whole pick
  const effects = key.split(',').filter((id) => id && !/^style-\d+$/.test(id)).map((id) => {
    const effect = itemEffectById(id, baseText);
    if (!effect) throw new Error(t('items_game: эффект {0} не найден', id));
    return effect;
  });

  const sourceFields = itemFields(baseText, source);
  const targetFields = itemFields(baseText, target);
  const styled = withStyle(itemVisuals(baseText, source) || '"visuals"\r\n{\r\n}', styleOf(key));
  let visuals = styled.visuals;
  // a kinetic gem that swaps an ability's particles or picture is written in before the assets are read, so the files are copied like the item's own
  for (const effect of effects) if (swapsFiles(effect)) visuals = appendItemEffect(visuals, effect);

  const assets = itemAssets(baseText, visuals, itemHeroes(baseText, source));
  // a gem's files that this build of the game does not have are left out, as its pictures are: one missing part does not fail the pick
  const gemFiles = new Set(effects.filter((e) => e.kinetic).flatMap((e) => effectParts(e).map((p) => normalizeAssetPath(p.modifier))));
  assets.assetCopies = assets.assetCopies.map((c) => ('to' in c && gemFiles.has(normalizeAssetPath(c.from)) ? { ...c, optional: true } : c));
  // a style with a model of its own wears that one in place of the item's
  const sourceModel = styled.model || sourceFields.get('model_player') || '';
  let targetModel = targetFields.get('model_player') || '';
  // a stock item with no model gives the game no wearable to hang the item's own particles on: they would play
  // at the hero's feet (Pangolier's musket glow, a second "gun" on the ground). The effects picked in the window stay.
  if (!targetModel && sourceModel) visuals = withoutOwnParticles(visuals);
  const underStock = !!sourceModel && !!targetModel && normalizeAssetPath(sourceModel) !== normalizeAssetPath(targetModel);
  if (underStock) assets.assetCopies.unshift({ from: sourceModel, to: targetModel });

  const copiedHeroes = new Set(assets.assetCopies.flatMap((c) => ('hero' in c ? [c.hero] : [])));
  const copiedStock = new Set(assets.assetCopies.flatMap((c) => ('to' in c ? [normalizeAssetPath(c.to)] : [])));
  visuals = withoutFileSwaps(visuals, copiedHeroes, copiedStock);
  visuals = stripKeyBlocks(visuals, 'unlock');
  if (!styled.applied) visuals = stripKeyBlocks(visuals, 'styles');
  for (const effect of effects) visuals = appendItemEffect(visuals, effect);

  let patched = setBlockId(itemBlock(baseText, source), target.id);
  patched = setScalarField(patched, 'name', targetFields.get('name') || target.name || target.id);
  patched = setScalarField(patched, 'prefab', 'default_item');
  // the stock path, which the pick's VPK fills with the item's model (withoutFileSwaps says why)
  if (underStock) patched = setScalarField(patched, 'model_player', targetModel);
  else if (styled.model) patched = setScalarField(patched, 'model_player', styled.model);
  patched = setVisualsBlock(patched, visuals);
  return { id: target.id, block: patched, ...assets };
}
