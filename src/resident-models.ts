/* A pick for a slot whose stock item has no model (Earthshaker's head, Bounty Hunter's arms) has no
 * stock path to put its model under, so its block names the paid item's model. The game wears a
 * model only once it is loaded, and a match loads what the server's item table names: after a
 * reconnect that model is not loaded, and the hero wears ERROR (src/item-builder.ts withoutFileSwaps).
 *
 * The game also loads everything a loaded file lists in its reference block (RERL), and the hero's
 * own model is loaded whenever the hero is. So the hero's model, as the mod carries it, lists the
 * pick's model among its references: it then comes with the hero, reconnect or not.
 */
import { withReferences } from './resource.ts';
import { entryAt, entryPath, type VpkEntry } from './vpk.ts';

/** A model to keep loaded: the patch it belongs to, the hero's compiled model path, and the model (.vmdl). */
export interface Resident { patch: number; heroModel: string; model: string }

/**
 * Give each hero's model its residents as references. A hero model one of the patches already
 * carries (an arcana's body under the hero's path) is changed where it is; otherwise the game's own
 * file goes into the resident's patch with the references added.
 * @param read  the game's own file of a path, or null
 * @returns what could not be done, for the report
 */
export function withResidentModels(patches: { assets?: VpkEntry[] | null }[], residents: Resident[], read: (path: string) => Buffer | null): string[] {
  const failed: string[] = [];
  const byHero = new Map<string, Resident[]>();
  for (const r of residents) {
    const key = r.heroModel.toLowerCase();
    byHero.set(key, [...(byHero.get(key) ?? []), r]);
  }
  for (const [heroModel, list] of byHero) {
    const models = [...new Set(list.map((r) => r.model.toLowerCase().replace(/\\/g, '/').replace(/_c$/, '')))];
    try {
      // the pak keeps the first file of a path it is given: that is the one to change
      const holder = patches.find((p) => p.assets?.some((en) => entryPath(en).toLowerCase() === heroModel));
      if (holder) {
        holder.assets = holder.assets!.map((en) => (entryPath(en).toLowerCase() === heroModel ? entryAt(heroModel, withReferences(en.data, models)) : en));
        continue;
      }
      const file = read(heroModel);
      if (!file) throw new Error(`нет файла ${heroModel}`);
      const patch = patches[list[0].patch];
      patch.assets = [...(patch.assets ?? []), entryAt(heroModel, withReferences(file, models))];
    } catch (err) {
      failed.push(`resident: ${models.join(', ')}: ${(err as Error)?.message || err}`);
    }
  }
  return failed;
}
