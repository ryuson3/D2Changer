// Diagnostics after «Применить косметику»: for every worn hero item, which stock path its files went
// under, whether that path was borrowed from another stock item, and whether the pak kept the file
// or dropped it because an earlier file already sat on that path (the pak keeps the first one).
//
// A pick that "does not work" on a friend's machine looks the same in every case (the stock look stays),
// and this says which of them it is. The text is also written to apply-report.txt in the data folder,
// and the window has a button that copies it.
import type { Deployed } from './schema.ts';

/** What the build knew about one worn hero item while it made the pick. */
export interface PickTrace {
  /** the pick's source in the pak: the slot id */ source: string;
  hero: string; heroName: string; slotLabel: string;
  /** the worn item */ itemId: string; name: string | null;
  /** the hero's stock item the pick is written over */ stockId: string; stockName: string | null;
  /** the stock item whose model path the pick took, when its own stock item has no model */
  borrowed: { id: string; name: string | null; model: string } | null;
  /** the paths (lower case, compiled) the pick's own files go under */ paths: string[];
  /** the pick could not be built at all */ error?: string;
}

export type FileState = 'ok' | 'same' | 'dropped' | 'absent';
export interface ReportFile { path: string; state: FileState; by?: string }
export interface ReportEntry {
  slot: string; hero: string; heroName: string; slotLabel: string;
  itemId: string; name: string | null;
  stockId: string; stockName: string | null;
  borrowed: PickTrace['borrowed'];
  /** the stock item's block in items_game: `ok`, not in the table, written over by another pick, or the pick failed */
  block: 'ok' | 'missing' | 'overridden' | 'error';
  blockBy?: string; error?: string;
  /** two picks wrote different blocks for the same stock item */ conflicts: string[];
  files: ReportFile[];
  problem: boolean;
}
export interface ApplyReport { entries: ReportEntry[]; text: string }

export const EMPTY_REPORT: ApplyReport = { entries: [], text: '' };

/** What `deploy` told about the merge and the pak, as it concerns each pick. `label` names a source for people. */
export function buildApplyReport(
  traces: PickTrace[],
  res: Pick<Deployed, 'applied' | 'missing' | 'conflicts' | 'owners' | 'dropped'>,
  label: (source: string) => string,
  stamp = '',
): ApplyReport {
  const entries: ReportEntry[] = traces.map((t) => {
    const e: ReportEntry = {
      slot: t.source, hero: t.hero, heroName: t.heroName, slotLabel: t.slotLabel, itemId: t.itemId, name: t.name,
      stockId: t.stockId, stockName: t.stockName, borrowed: t.borrowed,
      block: 'ok', conflicts: [], files: [], problem: false,
    };
    if (t.error) { e.block = 'error'; e.error = t.error; e.problem = true; return e; }

    const win = res.applied.find((a) => a.id === t.stockId);
    if (!win) e.block = 'missing';
    else if (win.source !== t.source) { e.block = 'overridden'; e.blockBy = win.source; }
    e.conflicts = res.conflicts.filter((c) => c.id === t.stockId).map((c) => `${label(c.a)} ↔ ${label(c.b)}`);

    for (const p of t.paths) {
      if (res.owners[p] === t.source) { e.files.push({ path: p, state: 'ok' }); continue; }
      const d = res.dropped.find((x) => x.path === p && x.lost === t.source);
      if (d) e.files.push({ path: p, state: d.same ? 'same' : 'dropped', by: d.by });
      else e.files.push({ path: p, state: 'absent', by: res.owners[p] });
    }
    e.problem = e.block !== 'ok' || e.conflicts.length > 0 || e.files.some((f) => f.state === 'dropped' || f.state === 'absent');
    return e;
  });
  return { entries, text: formatReport(entries, label, stamp) };
}

function formatReport(entries: ReportEntry[], label: (s: string) => string, stamp: string): string {
  const lines: string[] = [`Диагностика применения${stamp ? ` · игра ${stamp}` : ''}`, ''];
  for (const e of entries) {
    const who = `${e.heroName || e.hero} · ${e.slotLabel} · ${e.name ?? 'предмет'} (id ${e.itemId})`;
    lines.push(`${e.problem ? '[ПРОБЛЕМА]' : '[ок]'} ${who}`);
    if (e.block === 'error') { lines.push(`  не собран: ${e.error}`, ''); continue; }
    lines.push(`  стоковый предмет: ${e.stockId}${e.stockName ? ` «${e.stockName}»` : ''}`);
    lines.push(e.borrowed
      ? `  путь одолжен: ДА, у ${e.borrowed.id}${e.borrowed.name ? ` «${e.borrowed.name}»` : ''} (${e.borrowed.model}); его собственный вид пропадает, пока это надето`
      : '  путь одолжен: нет (у стокового предмета есть своя модель, или пик идёт по своим путям)');
    if (!e.files.length) lines.push('  файлы под стоковыми путями: нет');
    for (const f of e.files) {
      const state = f.state === 'ok' ? 'лёг в пак'
        : f.state === 'same' ? `уже лежал такой же от «${label(f.by ?? '')}» (одинаковый, не страшно)`
        : f.state === 'dropped' ? `ОТБРОШЕН: путь занят файлом «${label(f.by ?? '')}», а он другой`
        : `ОТСУТСТВУЕТ в паке${f.by ? ` (путь занят «${label(f.by)}»)` : ''}`;
      lines.push(`  файл ${f.path}: ${state}`);
    }
    lines.push(`  блок в items_game: ${e.block === 'ok' ? 'применён'
      : e.block === 'missing' ? 'НЕ ПРИМЕНЁН: стокового предмета нет в таблице игры'
      : `ПЕРЕКРЫТ другим предметом «${label(e.blockBy ?? '')}» на тот же стоковый id`}`);
    for (const c of e.conflicts) lines.push(`  конфликт блоков: ${c}`);
    lines.push('');
  }
  const bad = entries.filter((e) => e.problem).length;
  lines.push(`Итог: проблем ${bad} из ${entries.length}`);
  return lines.join('\n');
}
