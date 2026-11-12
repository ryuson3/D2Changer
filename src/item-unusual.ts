/* The game's unusual and ethereal effects on any hero item: Ethereal Flame, Sunfire, the Champion's
 * Auras. An owned courier's effect is a number the Game Coordinator sends; here the item builder writes
 * the effect's particle into the item's visuals as a `particle_create`, the modifier the builder's own
 * effects use (src/item-builder-effects.ts). What each number draws is read out of items_game's
 * "attribute_controlled_attached_particles" section, and the names players know ("Ethereal Flame")
 * out of the game's dota_english.txt (Attrib_Particle<number>).
 *
 * A `particle_create` gives the particle its place at the model, not the control points an effect
 * hangs on named attachments. Effects whose origin is such a point (eye glows) have nowhere to start
 * from, so they are not offered.
 *
 * An effect rides in the pick's effect string as `unusual-<number>`, beside the builder's own and the
 * style (src/item-builder.ts effectKey).
 *
 * Ported from Dota 2 Mod Manager (github.com/dota2modmanager/dota2-mod-manager, src/unusual-effects.ts
 * and src/item-builder-unusual.ts), GPL-3.0-or-later.
 * Copyright (C) 2026 TheFleece
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { blockBounds, eachChild } from './schema-kv.ts';
import type { ItemEffect } from './item-builder-effects.ts';

/** One effect the table knows. */
export interface UnusualEffect { id: number; system: string; attachType: string }

/** The token of a game effect in a pick's effect string. */
export const UNUSUAL = /^unusual-(\d+)$/;

/** Every effect in the table, in its order. */
export function unusualEffects(text: string): UnusualEffect[] {
  const at = /\n\t"attribute_controlled_attached_particles"\s*\n/.exec(text);
  if (!at) return [];
  const out: UnusualEffect[] = [];
  eachChild(text, blockBounds(text, at.index + at[0].length - 1), (c) => {
    if (!c.isBlock || !/^\d+$/.test(c.key)) return;
    const effect: UnusualEffect = { id: Number(c.key), system: '', attachType: '' };
    eachChild(text, c.body, (f) => {
      if (f.isBlock) return;
      if (f.key === 'system') effect.system = f.value;
      else if (f.key === 'attach_type') effect.attachType = f.value;
    });
    if (effect.system) out.push(effect);
  });
  return out;
}

let cache: { text: string; effects: UnusualEffect[] } | null = null;
/** The table's effects, read once per table. */
export const effectsOf = (text: string): UnusualEffect[] => {
  if (cache?.text !== text) cache = { text, effects: unusualEffects(text) };
  return cache.effects;
};

/** Attrib_Particle<id> names out of dota_english.txt's text, by id. */
export function effectNames(english: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const m of english.matchAll(/"Attrib_Particle(\d+)"\s+"([^"\n]*)"/gi)) if (m[2].trim()) names.set(Number(m[1]), m[2].trim());
  return names;
}

/**
 * The effects the picker offers: those the game names, that start at the model rather than on a named point,
 * whose particle is in the game's files, and that the builder does not offer already under a name of its own.
 */
export function offeredUnusual(text: string, names: Map<number, string>, has: (path: string) => boolean, own: Set<string>): ItemEffect[] {
  const seen = new Set<string>();
  return effectsOf(text)
    .filter((e) => names.has(e.id) && !/customorigin/i.test(e.attachType) && /\.vpcf$/i.test(e.system)
      && !own.has(e.system.toLowerCase()) && has(`${e.system.toLowerCase()}_c`))
    .sort((a, b) => a.id - b.id)
    .filter((e) => { const k = names.get(e.id)!.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((e) => ({ id: `unusual-${e.id}`, name: names.get(e.id)!, type: 'particle_create', modifier: e.system.toLowerCase(), heroOnly: true, unusual: true }));
}

/** The effect a token names, as the builder appends one; null when the table has no such number. */
export function unusualItemEffect(text: string, token: string): ItemEffect | null {
  const n = Number(UNUSUAL.exec(token)?.[1]);
  const effect = Number.isFinite(n) ? effectsOf(text).find((e) => e.id === n && e.system) : undefined;
  return effect ? { id: token, name: token, type: 'particle_create', modifier: effect.system.toLowerCase(), heroOnly: true, unusual: true } : null;
}
