/* The particle swap check, with a stand-in for the game's files. */
import assert from 'node:assert/strict';
import { checkParticleCopies, suspect } from '../src/particle-check.ts';

const files: Record<string, string[]> = {
  'particles/arcana/fine.vpcf_c': ['particles/arcana/child.vpcf'],
  'particles/arcana/wraps.vpcf_c': ['particles/units/hero/plain.vpcf', 'particles/arcana/child.vpcf'], // built on the plain one
  'particles/arcana/chain.vpcf_c': ['particles/units/hero/other_plain.vpcf'],
  'particles/arcana/lost.vpcf_c': ['particles/arcana/not_in_game.vpcf'],
  // the plain particle named only by a grandchild: arcana -> a -> b -> the plain particle it sits on
  'particles/arcana/deep.vpcf_c': ['particles/arcana/deep_a.vpcf'],
  'particles/arcana/deep_a.vpcf_c': ['particles/arcana/deep_b.vpcf'],
  'particles/arcana/deep_b.vpcf_c': ['particles/units/hero/deep_plain.vpcf'],
  // a grandchild that is not in the game
  'particles/arcana/hole.vpcf_c': ['particles/arcana/hole_a.vpcf'],
  'particles/arcana/hole_a.vpcf_c': ['particles/arcana/hole_gone.vpcf'],
};
const have = new Set(['particles/arcana/child.vpcf_c', 'particles/units/hero/plain.vpcf_c', 'particles/units/hero/other_plain.vpcf_c',
  'particles/arcana/deep_a.vpcf_c', 'particles/arcana/deep_b.vpcf_c', 'particles/units/hero/deep_plain.vpcf_c', 'particles/arcana/hole_a.vpcf_c']);
const io = {
  read: (p: string) => (files[p] ? Buffer.from(p) : null),
  has: (p: string) => have.has(p),
  refsOf: (f: Buffer) => files[f.toString()] || [],
};
const rows = checkParticleCopies([
  { from: 'particles/arcana/fine.vpcf', to: 'particles/units/hero/a.vpcf' },
  { from: 'Particles/Arcana/Wraps.vpcf', to: 'particles/units/hero/plain.vpcf' },
  { from: 'particles/arcana/chain.vpcf', to: 'particles/units/hero/b.vpcf' },
  { from: 'particles/arcana/lost.vpcf', to: 'particles/units/hero/c.vpcf' },
  { from: 'particles/arcana/gone.vpcf', to: 'particles/units/hero/d.vpcf' },
  // a plain particle that another copy puts something over
  { from: 'particles/arcana/fine.vpcf', to: 'particles/units/hero/other_plain.vpcf' },
  { from: 'particles/arcana/deep.vpcf', to: 'particles/units/hero/deep_plain.vpcf' },
  { from: 'particles/arcana/hole.vpcf', to: 'particles/units/hero/e.vpcf' },
], io);
assert.equal(suspect(rows[0]), false);
assert.equal(rows[1].selfRef, true); assert.equal(suspect(rows[1]), true);
assert.deepEqual(rows[2].chained, ['particles/units/hero/other_plain.vpcf']); assert.equal(suspect(rows[2]), true);
assert.deepEqual(rows[3].absent, ['particles/arcana/not_in_game.vpcf']);
assert.equal(rows[4].missing, true); assert.equal(suspect(rows[4]), true);
assert.equal(rows[0].loop.length, 0); assert.equal(rows[0].deepAbsent.length, 0);
assert.equal(rows[6].selfRef, false); assert.ok(rows[6].loop.length > 0); assert.equal(suspect(rows[6]), true);
assert.deepEqual(rows[7].deepAbsent, [['particles/arcana/hole_a.vpcf', 'particles/arcana/hole_gone.vpcf']]); assert.equal(suspect(rows[7]), true);
console.log('particle-check: ok');
