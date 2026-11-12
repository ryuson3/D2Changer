// Free cosmetics, as one small service: the slot picker, hero items and the patch they need.
//
// Built on the modules lifted from Dota 2 Mod Manager (GPL-3.0, see LICENSE and NOTICE):
//   patcher.ts  registers the extra content folder in gameinfo_branchspecific.gi and signs it;
//   schema.ts   rebuilds items_game.txt from the installed game and packs it as pak01_dir.vpk.
// This file is the glue and is written for this project: it keeps its own tiny state file, so it
// needs no library or settings object from the host app.
//
// What a "pick" is: every slot (weather, courier, ward, loading screen, announcer...) has a free
// base item every account owns. A pick copies the `visuals` block of another item of that slot
// onto the base item, so the game draws the picked look in place of the default one.
//
// Hero items ("Предметы") work the same way one level down: every hero has a stock default_item per
// equip slot, and a hero pick writes a wearable's block over it (src/item-builder.ts), together with
// the models, particles, sounds and portraits it needs under the plain paths of the game's files.
import { errorStockEntries } from './error-stock.ts';
import { emblemParticle, emblemModifiers, emblemAttackPatch, ringEmblemEntries } from './ring-emblem.ts';
import { attackEntriesFor, hasAttackEffect } from './emblem-attack.ts';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as patcher from './patcher.ts';
import * as schema from './schema.ts';
import * as itemBuilder from './item-builder.ts';
import { itemSlots, itemSets, type ItemSlot, type ItemSet } from './item-builder.ts';
import { soundEntries, type SoundSwap, type VoiceCue } from './item-sounds.ts';
import { portraitEntries } from './item-portraits.ts';
import type { PortraitSwap, SpriteSwap } from './item-builder-assets.ts';
import { heroDisplayName, entryAt, entryPath, sharedVpkIndex, type VpkEntry } from './vpk.ts';
import { RECOLOR_SETS, recolorFiles, recolorMaterial, recolorResource, type Rgb } from './recolor.ts';
import { validGem, cleanGems, gemColors, withGemPictures, prismaticGemArt, GEM_SETS, type Gems, type GemColor, type GemArt } from './gems.ts';
import { normalizeAssetPath, heroModelPath } from './item-builder-assets.ts';
import { withResidentModels, type Resident } from './resident-models.ts';
import { buildPreview, type PreviewModel, type PreviewScene } from './preview.ts';
import { itemParticles, entityModel, particleReplacements, heroLoadoutParticles } from './particle-spec.ts';
import { offeredUnusual, effectNames } from './item-unusual.ts';
import { ITEM_EFFECTS } from './item-builder-effects.ts';
import { modFolderName, ensureModFolder } from './modfolder.ts';
import { gemTitles } from './item-kinetics.ts';
import { findItem, readGameSchema } from './schema-items.ts';
import { isArcanaBlock } from './arcana-notes.ts';
import { abilityIconCatalog, iconCopies, type HeroIcons } from './ability-icons.ts';
import { buildApplyReport, EMPTY_REPORT, type ApplyReport, type PickTrace } from './apply-report.ts';
import { createPresets, cleanData, type PresetData } from './presets.ts';

export interface CosmeticsOptions {
  /** ...\dota 2 beta\game  (the folder that holds `dota` and `bin`) */
  gamePath: string;
  /** where this module keeps its backups and state file, e.g. app.getPath('userData') */
  dataDir: string;
}

export interface CosmeticSlotInfo {
  slot: string;
  /** the free base item of the slot */
  base: string;
  /** item id currently picked for the slot, or null */
  picked: string | null;
  options: { id: string; name: string; /** the emblem has an attack effect (its own in the item table, or a pack here) */ attack?: boolean }[];
}

export interface CosmeticsState {
  patched: boolean;
  signed: boolean;
  signable: boolean;
  outdated: boolean;
  foreign: string | null;
  deployed: boolean;
  /** picks made since the last «Применить косметику»: the game's files do not have them yet */
  pending: boolean;
  picks: Record<string, string>;
  /** hero item picks by builder slot id (item:<hero>:<slot>) */
  items: Record<string, HeroPick>;
  /** ability icon picks: ability name -> the picture (file name under spellicons) it shows */
  icons: Record<string, string>;
  /** effects on free-cosmetic slots that take them (the courier): slot -> effect ids as itemBuilder.effectKey writes them */
  fx: Record<string, string>;
  /** each gem arcana's colour (src/gems.ts), or null: the arcanas as the game's own files make them */
  gem: Gems | null;
}

/** A hero slot's pick: the wearable and its effects as itemBuilder.effectKey writes them. */
export interface HeroPick { itemId: string; effects: string }

export interface HeroSummary {
  id: string; name: string;
  /** equip slots the builder can dress for this hero */
  slots: number;
  /** slots with a pick on them */
  picked: number;
  /** sets the builder can put on in one go */
  sets: number;
}

export interface HeroSlotInfo extends Omit<ItemSlot, 'kind'> { picked: HeroPick | null }

/* Terrorblade's gem. The arcana is red because it comes with a gem (Reflection's Shade); a mod has no
 * gem, so the colour is written into the arcana's particles and materials instead (src/recolor.ts,
 * the same as the original's arcana window). It is applied while one of the arcana's items is worn. */
const GEM_SET = 'terrorblade-arcana';
/** the slot of the emblems (prefab "emblem"), which has no free base item */
const EMBLEM_SLOT = 'emblem';
/** the key in `fx` of the switch «эффект атаки эмблемы»: not an effect id, a flag (it is in the snapshot, so a change makes the build pending) */
/** free-cosmetic slots that can carry the builder's particle effects */
const FX_SLOTS = new Set(['courier']);
/** Fractal Horns of Inner Abysm and the second piece of the set (src/arcana-bases.ts) */
const GEM_ITEMS = new Set(['5957', '37161']);
/** Techies' Swine of the Sunken Galley takes a Prismatic Gem too (Explosive Burst by default) */
const TECHIES_GEM_SET = 'techies-arcana';
export const DEFAULT_GEM: Rgb = RECOLOR_SETS[GEM_SET].gem;
/** the game's table, read when the service starts: which Techies item is the arcana comes from it, not from a number here */
let gameText: (() => string) | null = null;
function isTechiesArcana(itemId: string): boolean {
  try {
    const text = gameText?.();
    const item = text ? findItem(text, itemId) : null;
    return !!item && isArcanaBlock(item.text);
  } catch { return false; }
}

/** A colour from the window: three whole numbers 0-255, or null. */
export { validGem };
/** The recolour set a worn pick brings its gem to, or null: it is no gem item. */
function gemSetOf(slotId: string, rec: HeroPick): string | null {
  const id = String(rec.itemId);
  if (slotId.startsWith('item:terrorblade:') && GEM_ITEMS.has(id)) return GEM_SET;
  if (slotId.startsWith('item:techies:') && isTechiesArcana(id)) return TECHIES_GEM_SET;
  return null;
}
const wearsGem = (slotId: string, rec: HeroPick) => gemSetOf(slotId, rec) !== null;

/** What a build is made from: the picks of every kind. The pak in the game always matches one of these (`applied`). */
interface Snap { picks: Record<string, string>; items: Record<string, HeroPick>; icons: Record<string, string>; fx: Record<string, string>; gem: Gems | null }

interface Saved {
  /** the mod folder the pak was last written into (dota_russian...) */ folder?: string | null;
  picks: Record<string, string>; items: Record<string, HeroPick>; icons?: Record<string, string>; fx?: Record<string, string>; gem?: Gems | null; stamp: string | null;
  /** the picks the pak in the game was last built from; the picks above can be ahead of it until «Применить косметику» */
  applied?: Snap;
}

/** The picks as a build sees them (a gem colour only counts while its arcana is worn). */
function snap(s: Pick<Saved, 'picks' | 'items' | 'icons' | 'fx' | 'gem'>): Snap {
  const items = s.items ?? {};
  const worn = new Set(Object.entries(items).map(([slotId, rec]) => gemSetOf(slotId, rec)));
  const kept = Object.entries(s.gem ?? {}).filter(([set]) => worn.has(set));
  return { picks: s.picks ?? {}, items, icons: s.icons ?? {}, fx: s.fx ?? {}, gem: kept.length ? Object.fromEntries(kept) : null };
}
const canon = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : val));
const sameSnap = (a: Snap, b: Snap) => canon(a) === canon(b);

export function isGameRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      return /dota2\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq dota2.exe', '/NH'], { encoding: 'utf8', windowsHide: true }));
    }
    execFileSync('pgrep', ['-x', 'dota2'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

export function createCosmetics({ gamePath, dataDir }: CosmeticsOptions) {
  gameText = () => readGameSchema(gamePath).text;
  const backupDir = path.join(dataDir, 'backups', 'patch');
  const stateFile = path.join(dataDir, 'cosmetics.json');

  function load(): Saved {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const cur = {
        picks: s.picks && typeof s.picks === 'object' ? s.picks : {},
        items: s.items && typeof s.items === 'object' ? s.items : {}, icons: s.icons && typeof s.icons === 'object' ? s.icons : {}, fx: s.fx && typeof s.fx === 'object' ? s.fx : {}, gem: cleanGems(s.gem),
      };
      // a state file from before the apply button: whatever was built then matches the picks (a stamp says something was built)
      const applied: Snap = s.applied && typeof s.applied === 'object'
        ? snap({ picks: s.applied.picks ?? {}, items: s.applied.items ?? {}, icons: s.applied.icons ?? {}, fx: s.applied.fx ?? {}, gem: cleanGems(s.applied.gem) })
        : s.stamp ? snap(cur) : snap({ picks: {}, items: {}, icons: {}, fx: {}, gem: null });
      return { ...cur, stamp: s.stamp ?? null, folder: s.folder ?? null, applied };
    } catch { return { picks: {}, items: {}, icons: {}, fx: {}, gem: null, stamp: null, applied: snap({ picks: {}, items: {}, icons: {}, fx: {}, gem: null }) }; }
  }
  function save(s: Saved): void {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s, null, 2));
    fs.renameSync(stateFile + '.tmp', stateFile);
  }
  /** The game's language folder, where the patch and the pak go: dota_russian, dota_koreana or dota_schinese. */
  const folder = (): string => modFolderName(gamePath);

  /* Earlier versions kept everything in game/dota_cosmetics, and a language change moves the target
   * folder. Whatever pak of ours is left in a folder that is no longer the target is removed; the
   * folders themselves are only dropped when nothing else is in them (schema.undeploy). */
  function cleanOldFolders(): void {
    const now = folder();
    const legacy = path.join(gamePath, 'dota_cosmetics');
    try {
      // only ever held our own pak (then named pak01_dir.vpk): anything else in it is not ours to delete
      if (fs.existsSync(legacy) && fs.readdirSync(legacy).every((f) => f.toLowerCase() === 'pak01_dir.vpk')) {
        fs.rmSync(legacy, { recursive: true, force: true });
      }
    } catch { /* left for the next start */ }
    const was = load().folder;
    if (was && was !== now) schema.undeploy({ gamePath, folder: was });
  }

  function guard(): void {
    if (isGameRunning()) throw new Error('Dota 2 запущена: закрой игру перед изменением файлов.');
  }

  /* A hero pick as built, kept for as long as the game's table is the one it was built from: the
   * files of one pick are read out of pak01 and a build of thirty would otherwise do it thirty times. */
  type BuiltPick = Awaited<ReturnType<typeof buildHeroPick>>;
  const built = new Map<string, BuiltPick>();
  let builtStamp: string | null = null;

  function buildHeroPick(baseText: string, rec: HeroPick, avoid?: Set<string>) {
    const made = itemBuilder.itemEffectPatch(baseText, rec.itemId, rec.effects, avoid);
    return { ...made, assets: itemBuilder.gameAssetEntries(gamePath, made.assetCopies) };
  }

  /** The pick with a model another worn item refits (itemBuilder.modelSwaps) put under its stock path in place of its own. */
  function refitPick(pick: BuiltPick, swaps: Map<string, string>, slotId: string, report: string[]): BuiltPick {
    const used: string[] = [];
    const assetCopies = pick.assetCopies.map((c) => {
      const to = 'to' in c ? swaps.get(normalizeAssetPath(c.from)) : undefined;
      if (!to || !('to' in c)) return c;
      used.push(`${c.from} -> ${to}`);
      return { ...c, from: to };
    });
    if (!used.length) return pick;
    try {
      const assets = itemBuilder.gameAssetEntries(gamePath, assetCopies);
      report.push(`${slotId}: refit ${used.join('; ')}`);
      return { ...pick, assetCopies, assets };
    } catch (err) {
      report.push(`${slotId}: refit not used (${(err as Error).message}): ${used.join('; ')}`); // not in the game's files: the plain model stays
      return pick;
    }
  }

  /* Valve's files of the set in one colour, kept for as long as the game and the colour are the same:
   * the recolour parses every particle of the set (seconds), and a rebuild happens on every pick. */
  let gemKept: { key: string; files: Map<string, Buffer>; failed: number } | null = null;
  const underAny = (p: string, prefixes: string[]) => prefixes.some((x) => p.startsWith(x));

  /**
   * The gem arcanas in their gems' colours, each in its own. The files the picks carry (the arcana's particles
   * copied under the hero's plain paths) are recoloured where they are, and the rest of the set
   * (particles and materials the arcana only names) is Valve's own file in the colour, returned
   * to go under every pick. `ownTo`: the paths a pick filled from the arcana's own particles.
   */
  function gemOverlay(sets: [string, Rgb][], stamp: string, patches: schema.SchemaPatch[], ownTo: Set<string>): { beneath: VpkEntry[]; failed: string[] } {
    const defs = sets.map(([x, color]) => ({ set: x, color, def: RECOLOR_SETS[x] }));
    const failed: string[] = [];
    const filled = new Set<string>();
    const hit = (p: string, d: { own: string[]; shared: string[]; materials: string[] }) => underAny(p, d.own) || underAny(p, d.shared) || underAny(p, d.materials);
    // the set a path belongs to: by its prefixes, or (a particle copied from the arcana) by the hero in its path
    const setFor = (p: string) => defs.find((x) => hit(p, x.def)) ?? (ownTo.has(p) ? (defs.find((x) => p.includes(x.set.split('-')[0])) ?? defs[0]) : undefined);
    for (const patch of patches) {
      if (!patch.assets) continue;
      patch.assets = patch.assets.map((en) => {
        const p = entryPath(en).toLowerCase();
        filled.add(p);
        const x = setFor(p);
        if (!x) return en;
        const own = ownTo.has(p) || underAny(p, x.def.own);
        const particle = p.endsWith('.vpcf_c') && (own || underAny(p, x.def.shared));
        const material = p.endsWith('.vmat_c') && underAny(p, x.def.materials);
        if (!particle && !material) return en;
        try {
          const r = particle ? recolorResource(en.data, x.color, { gem: x.def.gem, own, bake: true }) : recolorMaterial(en.data, x.color, { bake: true });
          return r.changed ? entryAt(p, r.file) : en;
        } catch { return en; }
      });
    }
    const key = `${stamp}|${sets.map(([x, c]) => `${x}:${c.join(',')}`).join('+')}`;
    if (gemKept?.key !== key) {
      const files = new Map<string, Buffer>();
      let bad = 0;
      for (const { set, color } of defs) {
        const r = recolorFiles({ pak01: path.join(gamePath, 'dota', 'pak01_dir.vpk'), set, target: color, bake: true });
        for (const [p, data] of r.files) files.set(p, data);
        bad += r.failed.length;
        if (!r.files.size) failed.push(`gem: набор ${set} ничего не перекрасил (проверь пути в src/recolor.ts)`);
      }
      gemKept = { key, files, failed: bad };
    }
    if (gemKept.failed) failed.push(`gem: ${gemKept.failed} файлов остались в своём цвете`);
    return { beneath: [...gemKept.files].filter(([p]) => !filled.has(p.toLowerCase())).map(([p, data]) => entryAt(p, data)), failed };
  }

  /**
   * Rebuild the schema pak from the game's own table + the picks (or remove it). Only «Применить косметику»
   * (apply) builds from the current picks; `from` is for putting back what was built before (heal).
   */
  function rebuild(from?: Snap): { deployed: boolean; applied: number; missing: string[]; failed: string[]; report: ApplyReport } {
    const cur = load();
    const s: Saved = from ? { ...cur, ...from } : cur;
    const appliedNow = from ? cur.applied : snap(cur);
    const base = schema.readGameSchema(gamePath);
    if (builtStamp !== base.stamp) { built.clear(); builtStamp = base.stamp; }
    const patches: schema.SchemaPatch[] = [];
    const failed: string[] = [];
    const fxOf = (slot: string) => (FX_SLOTS.has(slot) ? s.fx?.[slot] || '' : '');
    let ringEffect: string | null = null;
    let attackPackFiles: VpkEntry[] = [];
    const slotIds = new Set([...Object.keys(s.picks), ...Object.keys(s.fx ?? {}).filter((k) => FX_SLOTS.has(k) && s.fx?.[k])]);
    for (const slot of slotIds) {
      const itemId = s.picks[slot];
      if (slot === EMBLEM_SLOT) {
        // An emblem is not put in the table as a default item (that went to every account with an empty slot:
        // bots and enemies). Its particle is hung on the selection ring, which each client draws for itself.
        if (itemId) {
          try {
            const fx = emblemParticle(base.text, itemId);
            if (!fx) failed.push(`${slot}: у этой эмблемы нет частицы`);
            else ringEffect = fx;
            // the emblem's own attack effect, when it has a pack: its particle files go into the pak while the emblem is worn
            const emblemName = schema.listItems(base.text).find((i) => i.id === String(itemId))?.name;
            if (emblemName) attackPackFiles = attackEntriesFor(schema.toUtf8(emblemName), path.join(gamePath, 'dota', 'pak01_dir.vpk')) ?? [];
            // the attack effect has no file to put under a path: the game takes it from the emblem worn in the slot
            const block = emblemAttackPatch(base.text, itemId);
            if (block) patches.push({ id: String(itemId), block, source: `${slot}:${itemId}:attack` });
          } catch (err) { failed.push(`${slot}: ${(err as Error)?.message || err}`); }
        }
        continue;
      }
      const target = schema.baseItemFor(base.text, slot);
      if (!target) continue; // Valve removed the slot: the pick just drops out
      try {
        // no pick but effects: the free item itself, with the effects on top of its own look
        let block = itemId ? schema.baseItemPatch(base.text, target.id, itemId) : schema.findItem(base.text, target.id)!.text;
        const fx = fxOf(slot);
        if (fx) block = itemBuilder.withItemEffects(block, fx);
        patches.push({ id: target.id, block, source: `${slot}:${itemId ?? 'default'}` });
      } catch (err) {
        // the donor item is gone from this build, or an effect is not known
        if (fxOf(slot)) failed.push(`${slot}: ${(err as Error)?.message || err}`);
      }
    }

    // hero items: each pick built once, then the sounds, voices and portraits of all of them
    const heroPatches: schema.SchemaPatch[] = [];
    const sounds: SoundSwap[] = [], voices: VoiceCue[] = [], portraits: PortraitSwap[] = [], sprites: SpriteSwap[] = [];
    const ownTo = new Set<string>();
    const gemOwn = [GEM_SET, TECHIES_GEM_SET].flatMap((x) => RECOLOR_SETS[x].own);
    // a pick for a slot whose stock item has no model borrows another stock item's path: not one that is
    // worn itself, and not one another such pick has taken
    const offered = builderOffer().slots;
    try { writeStockReport(base.text, [...new Set(Object.keys(s.items).flatMap((id) => offered.find((x) => x.slot === id)?.heroIds ?? []))]); } catch { /* only a help */ }
    // for the report after the build: what each hero pick went under (src/apply-report.ts)
    const traces: PickTrace[] = [];
    const stockById = Object.keys(s.items).length ? new Map(schema.listItems(base.text).map((i) => [i.id, i])) : new Map<string, schema.SchemaItem>();
    const stockName = (id?: string): string | null => { const n = id ? stockById.get(id)?.name : undefined; return n ? schema.toUtf8(n) : null; };
    const traceOf = (slotId: string, rec: HeroPick, stockId: string): PickTrace => {
      const sl = offered.find((x) => x.slot === slotId);
      const hero = sl?.heroIds[0] ?? slotId.split(':')[1] ?? '';
      return {
        source: slotId, hero, heroName: heroDisplayName(hero), slotLabel: sl?.slotLabel ?? slotId,
        itemId: String(rec.itemId), name: sl?.options.find((o) => o.id === String(rec.itemId))?.name ?? null,
        stockId, stockName: stockName(stockId), borrowed: null, paths: [],
      };
    };
    const sourceLabel = (src: string): string => {
      if (src === 'beneath') return 'общие файлы (иконки, эмблема, гем, заглушка ERROR)';
      const sl = offered.find((x) => x.slot === src);
      return sl ? `${sl.heroLabel} · ${sl.slotLabel}` : src;
    };
    // what each worn item says another worn item's model is to be: an arcana's refits of paid wearables to its body
    const swapsOf = new Map<string, Map<string, string>>();
    for (const [slotId, rec] of Object.entries(s.items)) {
      try {
        const swaps = itemBuilder.modelSwaps(base.text, rec.itemId, itemBuilder.styleOfKey(itemBuilder.effectKey(rec.effects)));
        if (swaps.size) swapsOf.set(slotId, swaps);
      } catch { /* the wearable is gone: its own pick reports it */ }
    }
    const refitLines: string[] = [];
    const residents: Resident[] = [];
    for (const [slotId, rec] of Object.entries(s.items)) {
      const avoid = undefined;
      const key = `${rec.itemId}|${itemBuilder.effectKey(rec.effects)}${avoid ? `|${[...avoid].sort().join(',')}` : ''}`;
      try {
        let pick = built.get(key);
        if (!pick) { pick = buildHeroPick(base.text, rec, avoid); built.set(key, pick); }
        // another worn item of the hero refits this one's model (the arcana's body): its refit goes under the stock path
        const mine = new Set(offered.find((x) => x.slot === slotId)?.heroIds ?? []);
        const swaps = new Map<string, string>();
        for (const [other, m] of swapsOf) {
          if (other === slotId || !(offered.find((x) => x.slot === other)?.heroIds ?? []).some((h) => mine.has(h))) continue;
          for (const [from, to] of m) if (!swaps.has(from)) swaps.set(from, to);
        }
        if (swaps.size) pick = refitPick(pick, swaps, slotId, refitLines);
        heroPatches.push({ id: pick.id, block: pick.block, assets: pick.assets, source: slotId });
        // a model with no stock path under it stays loaded through the hero's own model (src/resident-models.ts)
        if (pick.resident) {
          const ix = sharedVpkIndex(path.join(gamePath, 'dota', 'pak01_dir.vpk'));
          for (const h of mine) {
            try { residents.push({ patch: heroPatches.length - 1, heroModel: `${normalizeAssetPath(heroModelPath(ix, `npc_dota_hero_${h}`))}_c`, model: pick.resident }); }
            catch { /* a hero with no model of its own in the script */ }
          }
        }
        const trace = traceOf(slotId, rec, pick.id);
        trace.paths = pick.assetCopies.flatMap((c) => {
          if (!('to' in c)) return [];
          const to = normalizeAssetPath(c.to).toLowerCase();
          return [to.endsWith('_c') ? to : `${to}_c`];
        });
        traces.push(trace);
        for (const copy of pick.assetCopies) {
          if (!('to' in copy)) continue;
          const to = normalizeAssetPath(copy.to);
          if (underAny(normalizeAssetPath(copy.from), gemOwn)) ownTo.add(to.endsWith('_c') ? to : `${to}_c`);
        }
        sounds.push(...pick.sounds); voices.push(...pick.voices);
        portraits.push(...pick.portraits); sprites.push(...pick.sprites);
      } catch (err) {
        // the wearable is gone from this build, or the builder refuses it: the rest still goes in
        failed.push(`${slotId}: ${(err as Error)?.message || err}`);
        traces.push({ ...traceOf(slotId, rec, offered.find((x) => x.slot === slotId)?.targetId ?? ''), error: String((err as Error)?.message || err) });
      }
    }
    if (swapsOf.size) {
      // what was refitted, for when a wearable still sits wrong on an arcana's body
      try {
        const lines = [...[...swapsOf].map(([slotId, m]) => `${slotId}: lists ${m.size} model swaps`), '', ...(refitLines.length ? refitLines : ['no worn item was refitted: none of the swaps names a worn item\'s model'])];
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'refit-report.txt'), lines.join('\n'));
      } catch { /* only a help */ }
    }
    if (residents.length) {
      const ix = sharedVpkIndex(path.join(gamePath, 'dota', 'pak01_dir.vpk'));
      failed.push(...withResidentModels(heroPatches, residents, (p) => ix.read(p)));
    }
    if (heroPatches.length) {
      // Two picks rewrite the same soundevents file, portrait settings and sprite sheet, and the
      // pak keeps the first file of a path it is given: so they go into one copy, ahead of the rest.
      const first = heroPatches[0];
      let soundFiles: VpkEntry[] = [], portraitFiles: VpkEntry[] = [];
      try { soundFiles = soundEntries(gamePath, sounds, voices); }
      catch (err) { failed.push(`sounds: ${(err as Error)?.message || err}`); }
      try { portraitFiles = portraitEntries(gamePath, portraits, sprites); }
      catch (err) { failed.push(`portraits: ${(err as Error)?.message || err}`); }
      first.assets = [...soundFiles, ...portraitFiles, ...(first.assets || [])];
      patches.push(...heroPatches);
    }
    let beneath: VpkEntry[] = [];
    const gemSets = [...new Set(Object.entries(s.items).map(([slotId, rec]) => gemSetOf(slotId, rec)).filter((x): x is string => !!x))]
      .filter((x) => s.gem?.[x]);
    if (gemSets.length) {
      try {
        const g = gemOverlay(gemSets.map((x) => [x, s.gem![x]] as [string, Rgb]), base.stamp, heroPatches, ownTo);
        beneath = g.beneath;
        failed.push(...g.failed);
      } catch (err) { failed.push(`gem: ${(err as Error)?.message || err}`); }
    }

    // ability icons: Valve's own pictures under the abilities' plain paths. They go first, so they win over
    // the same ability's picture that a worn item brings; with no item patch at all they ride beneath.
    const icons = s.icons ?? {};
    let iconFiles: VpkEntry[] = [];
    try { iconFiles = itemBuilder.gameAssetEntries(gamePath, iconCopies(icons)); }
    catch (err) { failed.push(`icons: ${(err as Error)?.message || err}`); }
    if (iconFiles.length) {
      if (patches.length) patches[0].assets = [...iconFiles, ...(patches[0].assets || [])];
      else beneath = [...beneath, ...iconFiles];
    }

    // the emblem: the selection ring with its particle, under the plain path (only the player's own client draws it)
    let ringFiles: VpkEntry[] = [];
    if (ringEffect) {
      try { ringFiles = ringEmblemEntries(ringEffect); }
      catch (err) { failed.push(`emblem: ${(err as Error)?.message || err}`); }
    }
    if (ringFiles.length) beneath = [...beneath, ...ringFiles];
    if (attackPackFiles.length) beneath = [...beneath, ...attackPackFiles];

    // a worn pick on a slot with no stock model shows as ERROR after a reconnect: make that invisible
    if (Object.keys(s.items).some((id) => offered.find((x) => x.slot === id)?.bare)) {
      try { beneath = [...beneath, ...errorStockEntries()]; }
      catch (err) { failed.push(`error-stock: ${(err as Error)?.message || err}`); }
    }

    cleanOldFolders();
    if (!patches.length && !iconFiles.length && !ringFiles.length && !attackPackFiles.length) {
      // nothing worn: the game's files go back as they were
      schema.undeploy({ gamePath, folder: folder() });
      if (patcher.state(gamePath, folder()).patched) patcher.revert({ gamePath, folder: folder(), backupDir });
      save({ ...cur, stamp: null, folder: null, applied: appliedNow });
      return { deployed: false, applied: 0, missing: [], failed, report: EMPTY_REPORT };
    }
    ensurePatch();
    const res = schema.deploy({ gamePath, folder: folder(), patches, base, beneath });
    save({ ...cur, stamp: base.stamp, folder: folder() , applied: appliedNow });
    const report = buildApplyReport(traces, res, sourceLabel, base.stamp);
    if (traces.length) {
      try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, 'apply-report.txt'), report.text); } catch { /* only a help */ }
    }
    return { deployed: true, applied: res.applied.length, missing: res.missing, failed, report };
  }

  /** A pick only changes the saved choices: no file of the game is touched until apply(). */
  function staged() {
    return { deployed: schema.isDeployed(gamePath, folder()), applied: 0, missing: [] as string[], failed: [] as string[], report: EMPTY_REPORT };
  }

  /** «Применить косметику»: build the pak from everything picked so far (or take it out when nothing is worn). */
  function apply() {
    guard();
    return rebuild();
  }

  /** Put the patch (gameinfo line + signature) in, or repair it after a Dota update. Idempotent. */
  function ensurePatch(): boolean {
    ensureModFolder(gamePath, folder());
    const st = patcher.state(gamePath, folder());
    if (st.patched && !st.outdated && !(st.signable && !st.signed)) return false;
    patcher.apply({ gamePath, folder: folder(), backupDir });
    return true;
  }

  /** Slots that have a free base item and something to put on it, read from the installed game. */
  function slots(): CosmeticSlotInfo[] {
    const { text } = schema.readGameSchema(gamePath);
    const picks = load().picks;
    const out: CosmeticSlotInfo[] = [];
    const seen = new Set<string>();
    for (const base of schema.listItems(text).filter((i) => i.baseitem)) {
      const slot = base.slot || base.prefab || '';
      if (!slot || seen.has(slot)) continue;
      seen.add(slot);
      const options = schema.cosmeticOptions(text, slot);
      if (options.length) out.push({ slot, base: base.id, picked: picks[slot] ?? null, options });
    }
    return out;
  }

  /** stock-report.txt in the data folder: every stock item of the heroes that wear something, with its slot and model. */
  function writeStockReport(text: string, heroIds: string[]): void {
    const all = schema.listItems(text);
    const lines: string[] = [`stamp ${schema.readGameSchema(gamePath).stamp}`, ''];
    for (const hero of heroIds) {
      const mine = all.filter((i) => i.prefab === 'default_item' && itemHeroesOf(text, i).includes(`npc_dota_hero_${hero}`) || (i.prefab === 'default_item' && itemHeroesOf(text, i).includes(hero)));
      lines.push(`== ${hero}: ${mine.length} stock items ==`);
      for (const i of mine.slice(0, 80)) {
        const f = schema.itemFields(text, i);
        lines.push(`#${i.id} slot=${f.get('item_slot') ?? '(none)'} model=${i.model || '(none)'} name=${schema.toUtf8(i.name)} heroes=${itemHeroesOf(text, i).join(',')}`);
      }
      lines.push('');
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'stock-report.txt'), lines.join('\n'));
  }
  const itemHeroesOf = (text: string, i: { start: number }) => itemBuilder.heroesOfItem(text, i);

  /** emblems-report.txt in the data folder: how emblems and their slot-mates are written in this game's table. */
  function writeEmblemReport(text: string, slotIds: string[]): void {
    const all = schema.listItems(text);
    const lines: string[] = [`stamp ${schema.readGameSchema(gamePath).stamp}`, `slots with emblems: ${slotIds.join(', ') || '(none)'}`, ''];
    const dump = (i: (typeof all)[number]) => {
      const f = schema.itemFields(text, i);
      return `#${i.id} baseitem=${i.baseitem} visuals=${i.hasVisuals} | ${[...f].filter(([k]) => k !== 'image_inventory' || true).map(([k, v]) => `${k}=${schema.toUtf8(v)}`).join('; ')}`;
    };
    const emblemItems = all.filter((i) => /emblem/.test(schema.itemSearchText(i)));
    lines.push(`== items mentioning emblem (${emblemItems.length}) ==`);
    for (const i of emblemItems.slice(0, 60)) {
      lines.push(dump(i));
      for (const m of emblemModifiers(text, i.id)) lines.push(`    ${m}`);
    }
    for (const slot of slotIds) {
      const mates = all.filter((i) => (i.slot || i.prefab) === slot);
      lines.push('', `== all ${mates.length} items of slot/prefab "${slot}" (first 40; base items first) ==`);
      for (const i of [...mates].sort((a, b) => Number(b.baseitem) - Number(a.baseitem)).slice(0, 40)) lines.push(dump(i));
    }
    const defaults = all.filter((i) => i.baseitem && /emblem|diretide|badge|tribute/.test(schema.itemSearchText(i)));
    lines.push('', `== base items mentioning emblem/diretide/badge/tribute (${defaults.length}) ==`);
    for (const i of defaults.slice(0, 20)) lines.push(dump(i));
    // the attack particles the game itself ships (particles/econ/attack/attack_modifier_*): the items table does not link them to emblems
    try {
      const ix = sharedVpkIndex(path.join(gamePath, 'dota', 'pak01_dir.vpk'));
      const atk = [...ix.paths()].filter((x) => /^particles\/econ\/attack\/attack_modifier/i.test(x)).sort();
      lines.push('', `== game attack-modifier particles (${atk.length}) ==`, ...atk);
    } catch { /* the report is only a help */ }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'emblems-report.txt'), lines.join('\n'));
  }

  /** Emblems (Diretide and the like): found by name in the installed game, grouped by the slot they sit in.
   *  `base` is the slot's free item; without one there is nothing to put the look on. */
  function emblems(): CosmeticSlotInfo[] {
    const { text } = schema.readGameSchema(gamePath);
    const picks = load().picks;
    const groups = new Map<string, { id: string; name: string; attack: boolean }[]>();
    for (const i of schema.listItems(text)) {
      if (i.baseitem || !i.hasVisuals || !i.name) continue;
      if (!/emblem/.test(schema.itemSearchText(i))) continue;
      if (!emblemParticle(text, i.id)) continue; // nothing to hang on the ring
      const slot = i.slot || i.prefab || '';
      if (!slot) continue;
      const list = groups.get(slot) ?? [];
      list.push({ id: i.id, name: schema.toUtf8(i.name), attack: hasAttackEffect(schema.toUtf8(i.name)) || !!emblemAttackPatch(text, i.id) });
      groups.set(slot, list);
    }
    try { writeEmblemReport(text, [...groups.keys()]); } catch { /* the report is only a help */ }
    return [...groups].map(([slot, options]) => ({
      slot, base: schema.baseItemFor(text, slot)?.id ?? (slot === EMBLEM_SLOT ? 'self' : ''), picked: picks[slot] ?? null,
      options: options.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }

  /**
   * Put an emblem on its slot, or clear it with null. Refuses when the slot has no free base item.
   * One emblem at a time: the game draws every emblem slot's particle on the same selection ring, so a second one
   * would fight the first — picking one takes every other emblem slot's pick off.
   */
  function pickEmblem(slot: string, itemId: string | null) {
    const groups = emblems();
    const group = groups.find((g) => g.slot === slot);
    if (!group) throw new Error('Эмблемы не найдены в этой версии игры.');
    if (itemId !== null && !group.base) throw new Error('У этого слота нет бесплатного базового предмета: заменить нечего.');
    if (itemId !== null && !group.options.some((o) => o.id === String(itemId))) throw new Error('Эта эмблема не подходит к слоту.');
    const out = pick(slot, itemId);
    if (itemId === null) return out;
    const s = load();
    const picks = { ...s.picks };
    let cleared = false;
    for (const g of groups) if (g.slot !== slot && picks[g.slot] !== undefined) { delete picks[g.slot]; cleared = true; }
    if (!cleared) return out;
    save({ ...s, picks });
    return staged();
  }

  /** Effects on a free-cosmetic slot that takes them (the courier); an empty list takes them off. */
  function setSlotFx(slot: string, effectIds: string | string[]) {
    if (!FX_SLOTS.has(slot)) throw new Error('На этот слот эффекты не вешаются.');
    if (itemBuilder.hasHeroOnlyEffect(itemBuilder.effectKey(effectIds))) throw new Error('Эти эффекты только для героев, на курьера они не вешаются.');
    const s = load();
    const key = itemBuilder.effectKey(effectIds);
    const fx = { ...(s.fx ?? {}) };
    if (key) fx[slot] = key; else delete fx[slot];
    save({ ...s, fx });
    return staged();
  }

  /** Put an item on a slot, or clear the slot with null. */
  function pick(slot: string, itemId: string | null) {
    const s = load();
    const picks = { ...s.picks };
    // effects belong to the item they were put on: another item (or the default) starts without them
    const fx = { ...(s.fx ?? {}) };
    if (FX_SLOTS.has(slot) && (itemId === null ? picks[slot] !== undefined : picks[slot] !== String(itemId))) delete fx[slot];
    if (itemId === null) delete picks[slot]; else picks[slot] = String(itemId);
    save({ ...s, picks, fx });
    return staged();
  }

  /** An item (or the default, with null) and its effects on a slot that takes them, in one write. */
  function pickFx(slot: string, itemId: string | null, effectIds: string | string[]) {
    if (!FX_SLOTS.has(slot)) throw new Error('На этот слот эффекты не вешаются.');
    if (itemBuilder.hasHeroOnlyEffect(itemBuilder.effectKey(effectIds))) throw new Error('Эти эффекты только для героев, на курьера они не вешаются.');
    const s = load();
    const picks = { ...s.picks };
    if (itemId === null) delete picks[slot]; else picks[slot] = String(itemId);
    const key = itemBuilder.effectKey(effectIds);
    const fx = { ...(s.fx ?? {}) };
    if (key) fx[slot] = key; else delete fx[slot];
    save({ ...s, picks, fx });
    return staged();
  }

  // ---------- hero items ----------

  /* What the builder offers, read once per game build: itemSlots walks all 26 000 items (~0.5 s). */
  let offer: { stamp: string; slots: ItemSlot[]; sets: ItemSet[] } | null = null;
  function builderOffer() {
    const base = schema.readGameSchema(gamePath);
    if (!offer || offer.stamp !== base.stamp) {
      const slots = itemSlots(base.text);
      offer = { stamp: base.stamp, slots, sets: itemSets(base.text, slots) };
    }
    return offer;
  }

  const heroOf = (id: string) => (slot: { heroIds: string[] }) => slot.heroIds.includes(id);

  /** Every hero the builder can dress, for the grid: how many slots it has, how many carry a pick, how many sets fit. */
  function heroes(): HeroSummary[] {
    const { slots, sets } = builderOffer();
    const items = load().items;
    const byHero = new Map<string, HeroSummary>();
    for (const slot of slots) {
      for (const id of slot.heroIds) {
        const h = byHero.get(id) || { id, name: heroDisplayName(id), slots: 0, picked: 0, sets: 0 };
        h.slots++;
        if (items[slot.slot]) h.picked++;
        byHero.set(id, h);
      }
    }
    for (const set of sets) for (const id of set.heroIds) { const h = byHero.get(id); if (h) h.sets++; }
    return [...byHero.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One hero's slots with their wearables, and the sets that fit it. */
  function heroSlots(heroId: string): { slots: HeroSlotInfo[]; sets: ItemSet[]; gems: GemColor[]; gemArt: GemArt | null } {
    const { slots, sets } = builderOffer();
    const items = load().items;
    // the game's Prismatic Gems and their picture, for the arcanas that take a gem colour
    let gems: GemColor[] = [];
    let gemArt: GemArt | null = null;
    if (heroId === 'terrorblade' || heroId === 'techies') {
      try {
        const ix = sharedVpkIndex(path.join(gamePath, 'dota', 'pak01_dir.vpk'));
        gems = withGemPictures(gemColors(schema.readGameSchema(gamePath).text), ix);
        gemArt = prismaticGemArt(ix);
      } catch { /* the window keeps its own colours */ }
    }
    return {
      slots: slots.filter(heroOf(heroId)).map(({ kind: _kind, ...slot }) => ({ ...slot, picked: items[slot.slot] ?? null })),
      sets: sets.filter(heroOf(heroId)),
      gems, gemArt,
    };
  }

  /**
   * The hero as it will look: its own model, and for every slot the item picked there, or the stock item
   * when nothing is (src/preview.ts). What the game would show, apart from lighting and effects.
   */
  async function heroPreview(heroId: string): Promise<PreviewScene & { hero: string; name: string }> {
    const base = schema.readGameSchema(gamePath);
    const ix = sharedVpkIndex(path.join(gamePath, 'dota', 'pak01_dir.vpk'));
    const all = schema.listItems(base.text);
    const byId = new Map(all.map((i) => [i.id, i]));
    const npc = `npc_dota_hero_${heroId}`;
    const stockBody = heroModelPath(ix, npc);
    const models: PreviewModel[] = [{ label: heroDisplayName(heroId), model: stockBody }];
    // What a worn item changes of the hero himself: an arcana puts him in its own body and swaps some of
    // his systems for its own, and an item with no model of its own (or the body itself) plays its systems on him.
    let body = normalizeAssetPath(stockBody);
    const bodyFx: string[] = [];
    const replacements = new Map<string, string>();
    const wear = (i: { start: number; end: number }, effects?: string) => {
      const block = base.text.slice(i.start, i.end), style = itemBuilder.styleOfKey(itemBuilder.effectKey(effects));
      const swap = entityModel(block, npc, style);
      if (swap && ix.has(`${swap}_c`)) body = swap;
      for (const [from, to] of particleReplacements(block, style)) replacements.set(from, to);
    };
    const put = (m: PreviewModel): void => { models.push(m); };
    // what the hero wears when nothing is picked: its stock items; a pick takes the place of the stock item of its slot
    const picked = new Map(heroSlots(heroId).slots.filter((x) => x.picked).map((x) => [x.targetId, x]));
    const nameOf = (i: { name: string }, slotLabel: string, id?: string, slot?: HeroSlotInfo) =>
      `${slotLabel} · ${slot?.options.find((o) => o.id === id)?.name ?? schema.toUtf8(i.name)}`;
    // what the item brings in its chosen style, and the effects picked on top of it
    const particlesOf = (i: { start: number; end: number }, effects?: string) =>
      [...itemParticles(base.text.slice(i.start, i.end), itemBuilder.styleOfKey(itemBuilder.effectKey(effects))), ...itemBuilder.effectParticles(effects, base.text)];
    for (const st of all.filter((i) => i.prefab === 'default_item' && itemBuilder.heroesOfItem(base.text, i).includes(`npc_dota_hero_${heroId}`))) {
      const slot = picked.get(st.id);
      picked.delete(st.id);
      // persona items belong to a different model of the whole hero: not drawn on this one, and no note about it
      const slotText = `${slot?.equipSlot ?? ''} ${slot?.slotLabel ?? ''} ${schema.itemFields(base.text, st).get('item_slot') ?? ''}`;
      // and the hero's own head (Luna's body_head): the hero's model has it already, drawn twice it gives two faces
      if (/persona/i.test(slotText) || /(^|\s)body_head(\s|$)/i.test(slotText)) continue;
      const worn = slot?.picked ? byId.get(String(slot.picked.itemId)) : undefined;
      const item = worn ?? st;
      const stockLabel = `${slot?.slotLabel ?? schema.itemFields(base.text, st).get('item_slot') ?? ''} · ${schema.toUtf8(st.name)}`;
      if (worn) wear(worn, slot!.picked!.effects);
      if (item.model) put({ label: nameOf(item, slot?.slotLabel ?? schema.itemFields(base.text, st).get('item_slot') ?? '', slot?.picked?.itemId, slot), model: item.model, fallback: worn && st.model ? { label: stockLabel, model: st.model } : undefined, particles: particlesOf(item, slot?.picked?.effects) });
      else if (worn) bodyFx.push(...particlesOf(worn, slot!.picked!.effects));
    }
    const persona: string[] = [];
    for (const slot of picked.values()) {          // a pick in a slot that has no stock item of its own
      // a persona is a different model of the whole hero, with its own items: drawn next to the hero it would stand inside him
      if (/persona/i.test(`${slot.equipSlot} ${slot.slotLabel}`)) { persona.push(slot.slotLabel); continue; }
      const worn = byId.get(String(slot.picked!.itemId));
      if (worn) wear(worn, slot.picked!.effects);
      if (worn?.model) put({ label: nameOf(worn, slot.slotLabel, slot.picked!.itemId, slot), model: worn.model, particles: particlesOf(worn, slot.picked!.effects) });
      else if (worn) bodyFx.push(...particlesOf(worn, slot.picked!.effects));
    }
    // an item whose model is the body it swaps in is the hero, not something he wears
    for (let k = models.length - 1; k > 0; k--) {
      if (normalizeAssetPath(models[k].model) !== body) continue;
      bodyFx.push(...(models[k].particles ?? []));
      models.splice(k, 1);
    }
    let heroFx: string[] = [];
    try { heroFx = heroLoadoutParticles(ix.read(`scripts/npc/heroes/${npc}.txt`)?.toString('latin1') ?? ''); } catch { /* a script with no portrait block */ }
    models[0] = { ...models[0], model: body, particles: [...new Set([...bodyFx, ...heroFx])],
      ...(body !== normalizeAssetPath(stockBody) ? { fallback: { label: models[0].label, model: stockBody } } : {}) };
    // A gem colour chosen for a worn arcana: its particles as the build makes them (gemOverlay), so the preview
    // shows the colour that goes into the game. With none chosen the files are left as they are, as in the build.
    const gems = load().gem ?? {};
    const tints = heroSlots(heroId).slots.flatMap((x) => {
      const set = x.picked ? gemSetOf(x.slot, x.picked) : null;
      return set && gems[set] ? [{ color: gems[set], def: RECOLOR_SETS[set] }] : [];
    });
    const tint = tints.length ? (p: string, file: Buffer) => {
      for (const x of tints) {
        const own = underAny(p, x.def.own);
        if (own || underAny(p, x.def.shared)) return recolorResource(file, x.color, { gem: x.def.gem, own, bake: true }).file;
      }
      return file;
    } : undefined;
    const scene = await buildPreview(ix, models, replacements, tint);
    if (persona.length) scene.notes.push(`Персона (${persona.join(', ')}) заменяет героя целиком и в превью пока не показывается`);
    return { ...scene, hero: heroId, name: heroDisplayName(heroId) };
  }

  /** The effects that can go on top of a pick ('' is none). */
  function effects(scope: 'hero' | 'courier' = 'hero') {
    if (scope === 'courier') return itemBuilder.itemEffects(scope);
    // the Kinetic Gems and the unusual effects are read from the game's own table, so they follow its updates
    let gems: Parameters<typeof itemBuilder.itemEffects>[1] = [];
    try { gems = itemBuilder.offeredKinetics(gamePath, schema.readGameSchema(gamePath).text); } catch { /* no game to read: the listed ones only */ }
    let unusual: Parameters<typeof itemBuilder.itemEffects>[1] = [];
    try { unusual = gameUnusual(); } catch { /* none */ }
    return itemBuilder.itemEffects(scope, [...gems, ...unusual]);
  }

  /** The game's unusual effects the picker offers, named as the game names them in English. */
  function gameUnusual() {
    const pak = path.join(gamePath, 'dota', 'pak01_dir.vpk');
    const ix = sharedVpkIndex(pak);
    const english = ix.read('resource/localization/dota_english.txt');
    const names = english ? effectNames(english.toString('utf8')) : new Map<number, string>();
    const own = new Set(ITEM_EFFECTS.map((e) => e.modifier.toLowerCase()));
    return offeredUnusual(schema.readGameSchema(gamePath).text, names, (p) => ix.has(p), own);
  }

  /** Put a wearable on a hero's slot, with effects, or clear the slot with null. */
  function pickItem(slotId: string, itemId: string | null, effectIds: string | string[] = []) {
    const s = load();
    const slot = builderOffer().slots.find((x) => x.slot === slotId);
    if (!slot) throw new Error(`Слот ${slotId} не найден в этой версии игры.`);
    const items = { ...s.items };
    if (itemId === null) delete items[slotId];
    else {
      if (!slot.options.some((o) => o.id === String(itemId))) throw new Error('Этот предмет не подходит к слоту.');
      items[slotId] = { itemId: String(itemId), effects: itemBuilder.effectKey(effectIds) };
    }
    save({ ...s, items });
    return staged();
  }

  /** Put every piece of a set that has a slot on the hero, in one write. */
  function pickSet(setId: string) {
    const s = load();
    const set = builderOffer().sets.find((x) => x.id === String(setId));
    if (!set) throw new Error('Набор не найден в этой версии игры.');
    const items = { ...s.items };
    for (const piece of set.pieces) if (piece.fits) items[piece.slot] = { itemId: piece.itemId, effects: '' };
    save({ ...s, items });
    return staged();
  }

  /** Take every pick off one hero (the stock items come back). */
  function resetHero(heroId: string) {
    const s = load();
    const ids = new Set(builderOffer().slots.filter(heroOf(heroId)).map((x) => x.slot));
    const items = Object.fromEntries(Object.entries(s.items).filter(([slot]) => !ids.has(slot)));
    save({ ...s, items });
    return staged();
  }

  /** One arcana's gem in a colour, or null for that arcana as the game makes it; the other arcana keeps its own. */
  function setGem(color: unknown, set: unknown = GEM_SET) {
    const s = load();
    const which = String(set);
    if (!(GEM_SETS as readonly string[]).includes(which)) throw new Error('Не та аркана для гема.');
    const gem = color === null ? null : validGem(color);
    if (color !== null && !gem) throw new Error('Не тот цвет: нужны три числа от 0 до 255.');
    const next: Gems = { ...(s.gem ?? {}) };
    if (gem) next[which] = gem; else delete next[which];
    save({ ...s, gem: Object.keys(next).length ? next : null });
    return staged();
  }

  /** Take everything off at once: free cosmetics and every hero's items. The gem colour is kept for next time. */
  function clearAll() {
    const s = load();
    autoKeep(s, 'Автосохранение: перед «Снять все»');
    save({ ...s, picks: {}, items: {}, icons: {}, fx: {} });
    return staged();
  }

  /** What stands in the mod folder besides our own files: Valve's gameinfo.gi, the workshop folder, and other tools' paks. */
  function foreignInFolder(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((n) => !/^(gameinfo\.gi|workshop)$/i.test(n) && n.toLowerCase() !== schema.SCHEMA_VPK);
    } catch { return []; }
  }

  /**
   * «Удалить модификации»: everything this app put into the game goes - the pak (pak99_dir.vpk), the pak
   * of older versions (game/dota_cosmetics), the gameinfo patch and its line in dota.signatures - and
   * the picks are cleared. Files that are not ours (other tools' paks, Valve's gameinfo.gi, workshop)
   * are never touched; they are reported back so the player sees what was left. What was worn goes to
   * the automatic preset first.
   */
  function removeAll() {
    guard();
    const s = load();
    autoKeep(s, 'Автосохранение: перед «Удалить модификации»');
    const removed: string[] = [];
    const folders = [...new Set([folder(), s.folder].filter((f): f is string => !!f))];
    for (const f of folders) if (fs.existsSync(path.join(gamePath, f, schema.SCHEMA_VPK))) removed.push(`${f}\\${schema.SCHEMA_VPK}`);
    if (fs.existsSync(path.join(gamePath, 'dota_cosmetics'))) removed.push('dota_cosmetics');
    cleanOldFolders();
    for (const f of folders) schema.undeploy({ gamePath, folder: f });
    const st = patcher.state(gamePath, folder());
    if (st.patched || st.signed) {
      patcher.revert({ gamePath, folder: folder(), backupDir });
      removed.push('gameinfo_branchspecific.gi', 'dota.signatures');
    }
    save({ ...s, picks: {}, items: {}, icons: {}, fx: {}, stamp: null, folder: null, applied: snap({ picks: {}, items: {}, icons: {}, fx: {}, gem: null }) });
    const left = folders.flatMap((f) => foreignInFolder(path.join(gamePath, f)).map((n) => `${f}\\${n}`));
    return { removed, left };
  }

  // ---------- presets ----------

  const presetStore = createPresets(dataDir);
  /** Everything worn, as a preset keeps it (the gem colour only while a gem item is worn). */
  const wornData = (s: Saved): PresetData => cleanData(snap(s));

  /** A failed copy must never stop the change it guards. */
  function autoKeep(s: Saved, label: string): void {
    try { presetStore.saveAuto(wornData(s), label); } catch { /* only a safety net */ }
  }

  function presets() { return presetStore.list(); }

  /** Keep what is worn now under a name (the same name again updates that preset). */
  function presetSave(name: unknown) {
    presetStore.save(name, wornData(load()));
    return presets();
  }

  /** Put a preset on in place of what is worn. What was worn goes to the automatic preset first. No file is touched until apply(). */
  function presetLoad(id: string) {
    const p = presetStore.get(String(id));
    if (!p) throw new Error('Пресет не найден.');
    const s = load();
    autoKeep(s, 'Автосохранение: перед сменой пресета');
    save({ ...s, picks: p.data.picks, items: p.data.items, icons: p.data.icons, fx: p.data.fx, gem: p.data.gem ?? s.gem ?? null });
    return staged();
  }

  function presetDelete(id: string) {
    presetStore.remove(String(id));
    return presets();
  }

  // ---------- ability icons ----------

  let iconCatalog: { stamp: string; heroes: HeroIcons[] } | null = null;
  /** Every hero's abilities that have more than one picture in this build (read once per build of the game). */
  function abilityIcons(): HeroIcons[] {
    const base = schema.readGameSchema(gamePath);
    if (!iconCatalog || iconCatalog.stamp !== base.stamp) iconCatalog = { stamp: base.stamp, heroes: abilityIconCatalog(gamePath, base.text, () => {}, gemTitles(gamePath)) };
    return iconCatalog.heroes;
  }

  /** Make an ability show one of its pictures, or null for its own. */
  function setAbilityIcon(ability: string, icon: string | null) {
    const s = load();
    const a = String(ability);
    const found = abilityIcons().flatMap((h) => h.abilities).find((x) => x.ability === a);
    if (!found) throw new Error('Для этой способности нет других иконок в этой версии игры.');
    const icons = { ...(s.icons ?? {}) };
    if (icon === null || icon === a) delete icons[a];
    else {
      if (!found.variants.some((v) => v.icon === String(icon))) throw new Error('Эта иконка не подходит к способности.');
      icons[a] = String(icon);
    }
    save({ ...s, icons });
    return staged();
  }

  /** After a Dota update: put the patch back and rebuild the table. Safe to call on every start. */
  function heal(): { healed: string[] } {
    const s = load();
    const was = s.applied!; // what the game was last built from: picks made since stay unbuilt until apply()
    const healed: string[] = [];
    // nothing built: nothing of ours in the game, nothing to repair
    if (!Object.keys(was.picks).length && !Object.keys(was.items).length && !Object.keys(was.icons).length && !Object.keys(was.fx).length) return { healed };
    guard();
    if (ensurePatch()) healed.push('patch');
    if (s.stamp !== schema.readGameSchema(gamePath).stamp || !schema.isDeployed(gamePath, folder())) {
      rebuild(was);
      healed.push('schema');
    }
    return { healed };
  }

  /** Everything worn now, named, for the "Надето" window: free cosmetics, hero items by hero, the gem. */
  function equipped() {
    const s = load();
    const base = schema.readGameSchema(gamePath);
    const free = Object.entries(s.picks).map(([slot, itemId]) => ({
      slot, itemId: String(itemId),
      name: schema.cosmeticOptions(base.text, slot).find((o) => o.id === String(itemId))?.name ?? null,
    }));
    const offered = builderOffer().slots;
    const heroItems = Object.entries(s.items).map(([slotId, rec]) => {
      const sl = offered.find((x) => x.slot === slotId);
      const opt = sl?.options.find((o) => o.id === String(rec.itemId));
      const hero = sl?.heroIds[0] ?? slotId.split(':')[1] ?? '';
      return {
        slot: slotId, hero, heroName: heroDisplayName(hero), slotLabel: sl?.slotLabel ?? slotId, icon: sl?.icon ?? 'auto_awesome',
        itemId: String(rec.itemId), name: opt?.name ?? null, effects: rec.effects,
        styled: !!(opt && opt.styles && opt.styles.length > 1),
        gem: wearsGem(slotId, rec) ? s.gem?.[gemSetOf(slotId, rec)!] : undefined,
      };
    }).sort((a, b) => a.heroName.localeCompare(b.heroName) || a.slotLabel.localeCompare(b.slotLabel));
    const catalog = Object.keys(s.icons ?? {}).length ? abilityIcons() : [];
    const abilityPicks = Object.entries(s.icons ?? {}).map(([ability, icon]) => {
      const hero = catalog.find((h) => h.abilities.some((a) => a.ability === ability));
      const ab = hero?.abilities.find((a) => a.ability === ability);
      return { ability, icon, name: ab?.name ?? ability, hero: hero?.hero ?? '', heroName: hero?.name ?? '', label: ab?.variants.find((v) => v.icon === icon)?.label ?? '' };
    }).sort((a, b) => a.heroName.localeCompare(b.heroName) || a.name.localeCompare(b.name));
    return { free, heroItems, abilityPicks };
  }

  function state(): CosmeticsState {
    const s = load();
    const st = patcher.state(gamePath, folder());
    return {
      patched: st.patched, signed: st.signed, signable: st.signable,
      outdated: st.outdated, foreign: st.foreign, deployed: schema.isDeployed(gamePath, folder()), pending: !sameSnap(snap(s), s.applied!), picks: s.picks, items: s.items, icons: s.icons ?? {}, fx: s.fx ?? {}, gem: s.gem ?? null,
    };
  }

  return { abilityIcons, setAbilityIcon, clearAll, apply, equipped, slots, emblems, pickEmblem, setSlotFx, pickFx, pick, heal, state, rebuild, heroes, heroSlots, effects, pickItem, pickSet, resetHero, setGem, heroPreview, presets, presetSave, presetLoad, presetDelete, removeAll };
}
