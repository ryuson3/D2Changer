/* Looking for a newer version of the program: asks GitHub for the latest release of the repository and
 * compares its tag with the version that is running. It only looks: nothing is downloaded or installed
 * here, the window shows a button that opens the release page.
 *
 * Copyright (C) 2026 h6rd, TheFleece
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Where the program's releases live. */
export const UPDATE_REPO = 'ryuson3/d267updater';

export type UpdateInfo = {
  /** A release newer than the running version exists. */
  available: boolean;
  current: string;
  /** The newest release's version ("" when there is no release yet). */
  latest: string;
  /** The release page to open. */
  url: string;
  /** What the release says is new, trimmed to a few lines. */
  notes: string;
};

/** "v1.2.3" or "1.2.3-beta.1" → [1, 2, 3]; null when it does not look like a version. */
export function parseVersion(s: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** True when `a` is a higher version than `b`. */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export async function checkForUpdate(current: string, fetchImpl: Fetch, repo: string = UPDATE_REPO): Promise<UpdateInfo> {
  const none: UpdateInfo = { available: false, current, latest: '', url: `https://github.com/${repo}/releases`, notes: '' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dota-mod-launcher' },
      signal: ctl.signal,
    });
    if (res.status === 404) return none; // no release published yet
    if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
    const rel = await res.json() as { tag_name?: string; html_url?: string; body?: string };
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    if (!parseVersion(latest)) return none;
    // Only ever hand out a link to this repository's own release page.
    const page = String(rel.html_url || '');
    const url = page.startsWith(`https://github.com/${repo}/`) ? page : none.url;
    const notes = String(rel.body || '').replace(/\r/g, '').trim().split('\n').slice(0, 12).join('\n').slice(0, 1200);
    return { available: isNewer(latest, current), current, latest, url, notes };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new Error('GitHub не отвечает: проверь интернет или прокси в настройках');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether this copy can install updates by itself. Only a build put in place by the NSIS installer can:
 * it leaves an "Uninstall …exe" next to the program. A portable exe, an unpacked folder or a run from
 * source cannot, and for them the window just shows a link to the release page. */
export function canAutoUpdate(o: {
  platform: string; isPackaged: boolean; env: Record<string, string | undefined>; execDir: string;
  listDir: (dir: string) => string[];
}): boolean {
  if (o.platform !== 'win32' || !o.isPackaged || o.env.PORTABLE_EXECUTABLE_DIR) return false;
  try { return o.listDir(o.execDir).some((f) => /^Uninstall .+\.exe$/i.test(f)); } catch { return false; }
}
