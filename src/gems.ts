/* The colours of the arcanas that take a Prismatic Gem, one per arcana: Terrorblade's and Techies'
 * can each have their own. Kept as { set: [r, g, b] } (the recolour set's name, src/recolor.ts).
 *
 * A state file or preset from before kept a single colour for every arcana: it is read as that
 * colour on each of them, so nothing changes for whoever picked one then.
 * Copyright (C) 2026 h6rd, TheFleece
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { blockBounds, eachChild } from './schema-kv.ts';
import { pngFromVtex } from './vtex.ts';

export type Rgb = [number, number, number];
export type Gems = Record<string, Rgb>;

/** The arcanas a gem colour can go on, by their recolour set. */
export const GEM_SETS = ['terrorblade-arcana', 'techies-arcana'] as const;

/** A colour from the window: three whole numbers 0-255, or null. */
export function validGem(c: unknown): Rgb | null {
  return Array.isArray(c) && c.length === 3 && c.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? [c[0], c[1], c[2]] : null;
}

/** The colours out of whatever a file holds; null when there are none. */
export function cleanGems(raw: unknown): Gems | null {
  const out: Gems = {};
  const one = validGem(raw);
  if (one) for (const set of GEM_SETS) out[set] = one;
  else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const set of GEM_SETS) { const c = validGem((raw as Record<string, unknown>)[set]); if (c) out[set] = c; }
  }
  return Object.keys(out).length ? out : null;
}

/** One Prismatic Gem colour, as the game names it; `picture`: its own socket picture, when the game ships one. */
export interface GemColor { key: string; name: string; rgb: Rgb; picture?: string }
/** The game's picture of a Prismatic Gem and the part of it the colour goes on, as data URLs. */
export interface GemArt { image: string; mask: string | null }

type Files = { has(p: string): boolean; read(p: string): Buffer | null };
const socketPicture = (ix: Files, name: string): string | null => {
  const path = `panorama/images/econ/sockets/${name}_png.vtex_c`;
  const png = ix.has(path) ? pngFromVtex(ix.read(path)) : null;
  return png ? `data:image/png;base64,${png.toString('base64')}` : null;
};

/** The shared Prismatic Gem artwork and its colour overlay, from the installed game; null when it is not there. */
export function prismaticGemArt(ix: Files): GemArt | null {
  const image = socketPicture(ix, 'gem_color');
  return image ? { image, mask: socketPicture(ix, 'gem_color_mask') } : null;
}

/** The gems with their own socket pictures, for the builds of the game that ship them next to the shared one. */
export function withGemPictures(gems: GemColor[], ix: Files): GemColor[] {
  return gems.map((gem) => {
    const picture = socketPicture(ix, `gem_color_${gem.key.replace(/^unusual_/, '')}`) ?? socketPicture(ix, `gem_color_${gem.key}`);
    return picture ? { ...gem, picture } : gem;
  });
}

/** "UnusualCreatorsLight" as "Creators Light"; digits stay one word: "International 2012". */
export function gemName(colorName: string): string {
  return colorName.replace(/^Unusual/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Z])/g, '$1 $2').trim();
}

const rgbOf = (hex: string): Rgb | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb : null;
};

/**
 * Every Prismatic Gem colour in the game's item table, in its order: its "colors" section keeps one block
 * per gem ("unusual_creators_light" with a color_name and a hex_color). Read from the player's own game,
 * so a gem Valve adds shows up by itself.
 * Ported from Dota 2 Mod Manager (github.com/dota2modmanager/dota2-mod-manager, src/gem-colors.ts).
 */
let colorCache: { text: string; gems: GemColor[] } | null = null;
export function gemColors(text: string): GemColor[] {
  if (colorCache?.text === text) return colorCache.gems;
  const gems: GemColor[] = [];
  const at = /\n\t"colors"\s*\n/.exec(text);
  if (at) {
    eachChild(text, blockBounds(text, at.index + at[0].length - 1), (c) => {
      if (!c.isBlock || !c.key.startsWith('unusual_')) return;
      let name = '';
      let rgb: Rgb | null = null;
      eachChild(text, c.body, (f) => {
        if (f.isBlock) return;
        if (f.key === 'color_name') name = gemName(f.value);
        if (f.key === 'hex_color') rgb = rgbOf(f.value);
      });
      if (name && rgb && !gems.some((g) => g.name === name)) gems.push({ key: c.key, name, rgb });
    });
  }
  colorCache = { text, gems };
  return gems;
}
