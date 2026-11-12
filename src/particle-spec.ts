/* The particle systems of the hero preview, read out of the game's files: which systems a worn item
 * brings, and each system's tree with its children, as src/particle-def.ts turns it into what the
 * window plays.
 *
 * Which systems: an item's `particle_create` asset modifiers for its chosen style, the ones a model
 * lists in its own key values (particle_cfg_list), and the particles of the effects picked on top.
 *
 * Ported from Dota 2 Mod Manager (github.com/dota2modmanager/dota2-mod-manager, src/particle-spec.ts
 * and src/model-particles.ts), GPL-3.0-or-later.
 * Copyright (C) 2026 TheFleece
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { readKv3, numberOf, type Kv3Block, type Kv3Node } from './kv3.ts';
import { resourceBlocks } from './resource.ts';

/** A KV3 value as plain JSON. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A system with its children. */
export interface ParticleDef { path: string; tree: { [k: string]: Json }; children: ParticleDef[]; delay?: number }

export function kvJson(kv: Kv3Block, n: Kv3Node | undefined): Json {
  if (!n) return null;
  switch (n.kind) {
    case 'object': return Object.fromEntries([...n.members].map(([k, v]) => [k, kvJson(kv, v)]));
    case 'array': return n.items.map((x) => kvJson(kv, x));
    case 'number': return numberOf(kv, n);
    case 'string': return n.value;
    case 'other': return n.type === 2 ? !!n.value : n.type === 13 ? true : n.type === 14 ? false : null;
    default: return null;
  }
}

/** The DATA tree of a compiled resource, or null for one the reader cannot take. */
export function dataTree(file: Buffer | null): { [k: string]: Json } | null {
  try {
    const d = file ? resourceBlocks(file).find((b) => b.name === 'DATA') : undefined;
    if (!file || !d) return null;
    const kv = readKv3(file.subarray(d.at, d.at + d.size));
    const j = kvJson(kv, kv.root);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

const compiled = (p: string) => p.toLowerCase().replace(/\\/g, '/').replace(/\.vpcf$/, '.vpcf_c');

/** A system and its children, at most `budget` systems in all. */
export function particleDef(read: (path: string) => Buffer | null, path: string, budget = { left: 128 }, depth = 0): ParticleDef | null {
  if (budget.left <= 0 || depth > 12) return null;
  const tree = dataTree(read(compiled(path)));
  if (!tree) return null;
  budget.left -= 1;
  const children: ParticleDef[] = [];
  for (const c of (Array.isArray(tree.m_Children) ? tree.m_Children : []) as { [k: string]: Json }[]) {
    const ref = typeof c?.m_ChildRef === 'string' ? c.m_ChildRef : '';
    // an end-cap child plays only as the effect is stopped
    if (!ref || c.m_bDisableChild === true || c.m_bEndCap === true) continue;
    const child = particleDef(read, ref, budget, depth + 1);
    if (child) children.push({ ...child, ...(typeof c.m_flDelay === 'number' ? { delay: Math.max(0, c.m_flDelay) } : {}) });
  }
  return { path, tree, children };
}

/** The particle_create systems an item block brings in style `style` (0: its first). */
export function itemParticles(block: string, style = 0): string[] {
  const out: string[] = [];
  for (const m of block.matchAll(/"asset_modifier\d*"\s*\{([^{}]*)\}/gi)) {
    const body = m[1];
    const field = (k: string) => new RegExp(`"${k}"\\s+"([^"]*)"`, 'i').exec(body)?.[1];
    if ((field('type') || '').toLowerCase() !== 'particle_create') continue;
    if (String(Number(field('style') || 0)) !== String(style)) continue;
    if (field('dire_only') === '1' || field('flying_courier_only') === '1' || field('required_arcana_level')) continue;
    const p = field('modifier');
    if (p && /^particles\/[\w/.-]+\.vpcf$/i.test(p)) out.push(p.toLowerCase());
  }
  return out;
}

const LIST = /(^|[\s{,])particle_cfg_list\s*=\s*\[[\s\S]*?\n?\s*\]\s*,?/;

/** The ambient systems a model lists in its own key values. */
export function modelParticles(model: Buffer | null): string[] {
  const tree = dataTree(model);
  const info = tree?.m_modelInfo;
  const text = info && typeof info === 'object' && !Array.isArray(info) ? info.m_keyValueText : null;
  if (typeof text !== 'string') return [];
  const list = LIST.exec(text)?.[0] ?? '';
  return [...list.matchAll(/\{([^{}]*)\}/g)].flatMap(([, row]) => {
    const path = /\bname\s*=\s*(?:resource\s*:\s*)?"(particles\/[\w/.-]+\.vpcf)"/i.exec(row)?.[1];
    return path ? [path.toLowerCase()] : [];
  });
}
