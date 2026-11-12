// Presets: a named copy of everything worn (free cosmetics, hero items, ability icons, effects, the gem
// colour), kept in presets.json next to cosmetics.json. A preset only holds picks, never game files:
// putting one on changes the saved choices and the build stays pending until «Применить косметику».

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface PresetPick { itemId: string; effects: string }
export interface PresetData {
  picks: Record<string, string>;
  items: Record<string, PresetPick>;
  icons: Record<string, string>;
  fx: Record<string, string>;
  gem: [number, number, number] | null;
}
export interface Preset { id: string; name: string; saved: number; auto?: boolean; data: PresetData }

/** What the window lists: no picks, only how much is in a preset. */
export interface PresetInfo {
  id: string; name: string; saved: number; auto: boolean;
  /** free cosmetics, hero items, ability icons */
  counts: { free: number; items: number; icons: number };
}

export const AUTO_ID = 'auto';
const MAX_PRESETS = 50;
const MAX_NAME = 40;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A preset's data from whatever the file holds: anything of the wrong shape is dropped, not trusted. */
export function cleanData(raw: unknown): PresetData {
  const r = isObj(raw) ? raw : {};
  const strMap = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (isObj(v)) for (const [k, val] of Object.entries(v)) if (typeof val === 'string' || typeof val === 'number') out[k] = String(val);
    return out;
  };
  const items: Record<string, PresetPick> = {};
  if (isObj(r.items)) {
    for (const [k, val] of Object.entries(r.items)) {
      if (isObj(val) && (typeof val.itemId === 'string' || typeof val.itemId === 'number')) {
        items[k] = { itemId: String(val.itemId), effects: typeof val.effects === 'string' ? val.effects : '' };
      }
    }
  }
  const g = r.gem;
  const gem = Array.isArray(g) && g.length === 3 && g.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? ([g[0], g[1], g[2]] as [number, number, number]) : null;
  return { picks: strMap(r.picks), items, icons: strMap(r.icons), fx: strMap(r.fx), gem };
}

export const isEmptyData = (d: PresetData): boolean =>
  !Object.keys(d.picks).length && !Object.keys(d.items).length && !Object.keys(d.icons).length && !Object.keys(d.fx).length;

const canon = (d: PresetData): string => JSON.stringify(d, (_k, val) => (isObj(val)
  ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : val));
export const sameData = (a: PresetData, b: PresetData): boolean => canon(a) === canon(b);

export function createPresets(dataDir: string) {
  const file = path.join(dataDir, 'presets.json');

  function read(): Preset[] {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(raw?.list) ? raw.list : [];
      return list.filter((p: unknown) => isObj(p) && typeof p.id === 'string' && typeof p.name === 'string')
        .map((p: any) => ({ id: p.id, name: p.name.slice(0, MAX_NAME), saved: Number(p.saved) || 0, auto: p.auto === true || undefined, data: cleanData(p.data) }));
    } catch { return []; }
  }
  function write(list: Preset[]): void {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ list }, null, 2));
    fs.renameSync(file + '.tmp', file);
  }

  const info = (p: Preset): PresetInfo => ({
    id: p.id, name: p.name, saved: p.saved, auto: p.auto === true,
    counts: { free: Object.keys(p.data.picks).length, items: Object.keys(p.data.items).length, icons: Object.keys(p.data.icons).length },
  });

  /** The automatic copy first, then the player's own, newest first. */
  function list(): PresetInfo[] {
    const all = read();
    const own = all.filter((p) => !p.auto).sort((a, b) => b.saved - a.saved);
    return [...all.filter((p) => p.auto), ...own].map(info);
  }

  function get(id: string): Preset | null { return read().find((p) => p.id === id) ?? null; }

  /** Save what is worn under a name. A name already taken is written over (that is how a preset is updated). */
  function save(nameRaw: unknown, data: PresetData): PresetInfo {
    const name = String(nameRaw ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
    if (!name) throw new Error('Введи название пресета.');
    if (isEmptyData(data)) throw new Error('Нечего сохранять: сейчас ничего не надето.');
    const all = read();
    const same = all.find((p) => !p.auto && p.name.toLowerCase() === name.toLowerCase());
    if (!same && all.filter((p) => !p.auto).length >= MAX_PRESETS) throw new Error(`Пресетов слишком много (больше ${MAX_PRESETS}): удали ненужные.`);
    const rec: Preset = { id: same?.id ?? crypto.randomBytes(6).toString('hex'), name: same?.name ?? name, saved: Date.now(), data };
    write([...all.filter((p) => p.id !== rec.id), rec]);
    return info(rec);
  }

  /** The copy made before something was taken off or replaced: one slot, always the latest. */
  function saveAuto(data: PresetData, label: string): void {
    if (isEmptyData(data)) return;
    const all = read();
    const prev = all.find((p) => p.auto);
    if (prev && sameData(prev.data, data)) return;
    write([...all.filter((p) => !p.auto), { id: AUTO_ID, name: label, saved: Date.now(), auto: true, data }]);
  }

  function remove(id: string): void {
    const all = read();
    if (!all.some((p) => p.id === id)) throw new Error('Пресет не найден.');
    write(all.filter((p) => p.id !== id));
  }

  return { list, get, save, saveAuto, remove };
}
