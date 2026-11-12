/* A check of the particle swaps an item makes, for when an effect looks wrong in the game.
 *
 * The builder puts an item's particle (the arcana's version of an effect) over the plain one's file, so
 * the game plays it where it plays the plain one. That is a copy of one file onto another path, and it
 * goes wrong in two ways that look like a broken effect:
 *  - the copied particle names, among its resources, the plain particle it now sits on (the arcana's
 *    effect is built on top of the plain one): it then names itself, and plays as nothing or as a mess;
 *  - it names a resource that is not in the game's files.
 * This reads what each copied particle names and says which of the two it is. It follows the names down the
 * children too (a particle names children, which name children): an effect that comes round to the plain
 * particle it sits on only at the third level plays just as badly, and so does a grandchild that is gone.
 *
 * Copyright (C) 2026 h6rd, TheFleece
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ParticleCopy { from: string; to: string }

export interface ParticleRow {
  from: string;
  to: string;
  /** the file is not in the game's files */
  missing: boolean;
  /** what the file names */
  refs: string[];
  /** names the very path it is put over: the plain particle it replaces */
  selfRef: boolean;
  /** names the plain particle of another swap of the same item, which is itself replaced */
  chained: string[];
  /** names a resource the game's files do not have */
  absent: string[];
  /** deeper down: a chain of particles that leads back to a path an item's copy has replaced (it names itself by way of its children); empty when none */
  loop: string[];
  /** deeper down: [particle, what it names] where the game's files do not have what it names (one level below the first is in `absent`) */
  deepAbsent: [string, string][];
}

const norm = (p: string) => String(p || '').toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '').replace(/_c$/, '');
const MAX_DEPTH = 8;

export function checkParticleCopies(
  copies: ParticleCopy[],
  io: { read(path: string): Buffer | null; has(path: string): boolean; refsOf(file: Buffer): string[] },
): ParticleRow[] {
  const targets = new Set(copies.map((c) => norm(c.to)));
  // what the game plays at a path: the copy's file where one is put over it, the path's own file otherwise
  const playedAt = new Map(copies.map((c) => [norm(c.to), norm(c.from)]));
  const here = (r: string) => io.has(norm(r)) || io.has(norm(r) + '_c');
  const refsCache = new Map<string, string[] | null>();
  const refsAt = (path: string): string[] | null => {
    if (!refsCache.has(path)) {
      const file = io.read(path + '_c');
      refsCache.set(path, file ? io.refsOf(file) : null);
    }
    return refsCache.get(path)!;
  };
  return copies.map((c) => {
    const file = io.read(norm(c.from) + '_c');
    if (!file) return { from: c.from, to: c.to, missing: true, refs: [], selfRef: false, chained: [], absent: [], loop: [], deepAbsent: [] };
    const refs = io.refsOf(file);

    // the whole tree of particles under this one, down the children, as the game would play it
    const loop: string[] = [];
    const deepAbsent: [string, string][] = [];
    const done = new Set<string>();
    const walk = (path: string, trail: string[]) => {
      if (loop.length || trail.length > MAX_DEPTH) return;
      const played = playedAt.get(path) || path;
      for (const r of refsAt(played) || []) {
        const child = norm(r);
        if (!/\.vpcf$/.test(child)) continue;
        if (trail.length >= 1 && child === norm(c.to)) { loop.push(...trail, child); return; }
        if (trail.includes(child)) continue;
        if (!here(child) && !playedAt.has(child)) { if (!deepAbsent.some(([a, b]) => a === played && b === child)) deepAbsent.push([played, child]); continue; }
        if (done.has(child)) continue;
        done.add(child);
        walk(child, [...trail, child]);
        if (loop.length) return;
      }
    };
    // the first level is reported on its own (selfRef, absent); the walk starts below it
    for (const r of refs) {
      const child = norm(r);
      if (!/\.vpcf$/.test(child) || child === norm(c.to) || !(here(child) || playedAt.has(child))) continue;
      if (done.has(child)) continue;
      done.add(child);
      walk(child, [norm(c.to), child]);
      if (loop.length) break;
    }
    return {
      from: c.from, to: c.to, missing: false, refs,
      selfRef: refs.some((r) => norm(r) === norm(c.to)),
      chained: refs.filter((r) => norm(r) !== norm(c.to) && targets.has(norm(r))),
      absent: refs.filter((r) => !here(r)),
      loop, deepAbsent,
    };
  });
}

/** Whether a row is worth a look. */
export const suspect = (r: ParticleRow) => r.missing || r.selfRef || r.chained.length > 0 || r.absent.length > 0 || r.loop.length > 0 || r.deepAbsent.length > 0;
