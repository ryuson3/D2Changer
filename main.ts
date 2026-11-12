// Standalone window for the free-cosmetics module. Written for this project; the logic it
// drives (src/cosmetics.ts, patcher, schema) comes from Dota 2 Mod Manager (GPL-3.0).
import { app, BrowserWindow, dialog, ipcMain, net, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createCosmetics, isGameRunning } from './src/cosmetics.ts';
import { findDotaGamePath, validateGamePath } from './src/steam.ts';
import { modFolderName } from './src/modfolder.ts';
import { createToolchain } from './src/toolchain.ts';
import { createGameIcons } from './src/game-icons.ts';
import { createSpellPictures } from './src/spell-pictures.ts';
import electronUpdater from 'electron-updater';
import { canAutoUpdate } from './src/updates.ts';
import { createUpdater } from './src/auto-update.ts';

type Cosmetics = ReturnType<typeof createCosmetics>;

const here = import.meta.dirname;
let win: BrowserWindow | null = null;
let gamePath: string | null = null;
let cos: Cosmetics | null = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
interface Settings { gamePath?: string; toolsPromptSeen?: boolean; downloadProxy?: string }
function readSettings(): Settings {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(s: Settings): void {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

/** http(s)/socks proxy for the one download this window makes; '' = direct. */
function validProxy(v: string): boolean {
  if (!v) return true;
  try { return ['http:', 'https:', 'socks4:', 'socks5:'].includes(new URL(v).protocol); } catch { return false; }
}
async function applyProxy(v: string): Promise<void> {
  await session.defaultSession.setProxy(v ? { proxyRules: v } : { mode: 'system' });
}

const send = (channel: string, payload: unknown) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
// the Source 2 tool (optional download) and the item pictures read through it
const toolchain = createToolchain({
  userDataDir: app.getPath('userData'),
  fetchImpl: (url, init) => net.fetch(url, init) as unknown as Promise<Response>,
  onProgress: (evt) => send('tools:progress', evt),
});
const gameIcons = createGameIcons({ userDataDir: app.getPath('userData'), toolchain, getGamePath: () => gamePath });

const spellPics = createSpellPictures({ userDataDir: app.getPath('userData'), toolchain, getGamePath: () => gamePath });

function bind(p: string | null): void {
  gamePath = p;
  cos = p ? createCosmetics({ gamePath: p, dataDir: app.getPath('userData') }) : null;
}

async function detectGame(): Promise<void> {
  const saved = readSettings().gamePath;
  if (saved && validateGamePath(saved)) return bind(saved);
  const found = await findDotaGamePath();
  if (found) writeSettings({ gamePath: found });
  bind(found);
}

/** Every handler answers { ok: true, ...data } or { ok: false, error }, so the window never sees a throw. */
function handle(channel: string, fn: (...args: any[]) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, ...(await fn(...args) as object) }; }
    catch (err) { return { ok: false, error: String((err as Error)?.message || err) }; }
  });
}

function needGame(): Cosmetics {
  if (!cos) throw new Error('Dota 2 не найдена. Укажи папку игры (…\\dota 2 beta\\game).');
  return cos;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1340, height: 860, minWidth: 980, minHeight: 620,
    frame: false, backgroundColor: '#0b1424', title: 'Менеджер модов',
    icon: path.join(here, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.removeMenu();
  // the window shows our own page and nothing else
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void win.loadFile(path.join(here, 'ui', 'index.html'));
}

app.whenReady().then(async () => {
  await applyProxy(readSettings().downloadProxy || '').catch(() => {});
  await detectGame();

  handle('app:init', () => ({
    gamePath, connected: !!gamePath, gameRunning: isGameRunning(), folder: gamePath ? modFolderName(gamePath) : null,
    toolsPromptSeen: !!readSettings().toolsPromptSeen, tools: toolchain.state(),
    state: cos ? cos.state() : null,
  }));

  handle('game:choose', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Папка игры: …\\dota 2 beta\\game', properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return { changed: false };
    let p = r.filePaths[0];
    // accept the "dota 2 beta" folder too
    if (!validateGamePath(p) && validateGamePath(path.join(p, 'game'))) p = path.join(p, 'game');
    if (!validateGamePath(p)) throw new Error('Это не папка игры: не найден dota/pak01_dir.vpk.');
    writeSettings({ ...readSettings(), gamePath: p });
    bind(p);
    return { changed: true, gamePath: p };
  });

  handle('cos:state', () => ({ state: needGame().state(), gameRunning: isGameRunning() }));

  // heavy (walks ~26 000 items): the window asks once per open section
  handle('cos:slots', () => ({ slots: needGame().slots(), effects: needGame().effects() }));

  // a courier (or the default one) together with its effects
  handle('cos:pickFx', (slot: string, itemId: string | null, effects: string[]) => {
    const c = needGame();
    const r = c.pickFx(String(slot), itemId === null ? null : String(itemId), effects || []);
    return { state: c.state(), failed: r.failed };
  });

  // particle effects on the courier
  handle('cos:slotFx', (slot: string, effects: string[]) => {
    const c = needGame();
    const r = c.setSlotFx(String(slot), effects || []);
    return { state: c.state(), failed: r.failed };
  });

  // everything worn now, named, for the "Надето" window
  handle('cos:equipped', () => { const c = needGame(); return { ...c.equipped(), effects: c.effects() }; });

  // «Применить косметику»: the only place where the pak is built from the picks
  handle('cos:apply', () => {
    const c = needGame();
    const r = c.apply();
    return { state: c.state(), failed: r.failed, deployed: r.deployed, gameRunning: isGameRunning(), report: r.report };
  });

  handle('cos:clearAll', () => {
    const c = needGame();
    const r = c.clearAll();
    return { state: c.state(), failed: r.failed };
  });

  // presets: named copies of what is worn; putting one on only changes the picks (apply builds them)
  handle('preset:list', () => ({ presets: needGame().presets() }));
  handle('preset:save', (name: unknown) => ({ presets: needGame().presetSave(name) }));
  handle('preset:load', (id: string) => {
    const c = needGame();
    const r = c.presetLoad(String(id));
    return { state: c.state(), failed: r.failed, presets: c.presets() };
  });
  handle('preset:delete', (id: string) => ({ presets: needGame().presetDelete(String(id)) }));

  // «Удалить модификации»: our pak, the gameinfo patch and the picks; nothing that is not ours
  handle('mods:remove', () => {
    const c = needGame();
    const r = c.removeAll();
    return { state: c.state(), removed: r.removed, left: r.left, presets: c.presets(), gameRunning: isGameRunning() };
  });

  // emblems: their own list, found by name, and a pick that refuses a slot with nothing to replace
  handle('cos:emblems', () => ({ groups: needGame().emblems() }));
  handle('cos:pickEmblem', (slot: string, itemId: string | null) => {
    const c = needGame();
    c.pickEmblem(slot, itemId);
    return { state: c.state() };
  });

  handle('cos:pick', (slot: string, itemId: string | null) => {
    const c = needGame();
    c.pick(slot, itemId);
    return { state: c.state() };
  });

  // hero items ("Предметы"): the grid of heroes, one hero's slots and sets, and the picks
  handle('hero:list', () => ({ heroes: needGame().heroes() }));
  handle('hero:slots', (heroId: string) => ({ ...needGame().heroSlots(String(heroId)), effects: needGame().effects() }));
  handle('hero:pick', (slotId: string, itemId: string | null, effects: string[]) => {
    const c = needGame();
    const r = c.pickItem(String(slotId), itemId === null ? null : String(itemId), Array.isArray(effects) ? effects.map(String) : []);
    return { state: c.state(), failed: r.failed };
  });
  handle('hero:set', (setId: string) => {
    const c = needGame();
    const r = c.pickSet(String(setId));
    return { state: c.state(), failed: r.failed };
  });
  // Terrorblade's gem: [r, g, b] or null (the arcana as the game's own files make it)
  handle('hero:gem', (color: unknown) => {
    const c = needGame();
    const r = c.setGem(color === null ? null : color);
    return { state: c.state(), failed: r.failed };
  });
  // ability icons: the abilities with more than one picture, a pick, and the pictures for the window
  handle('spell:list', () => ({ heroes: needGame().abilityIcons() }));
  handle('spell:pick', (ability: string, icon: string | null) => {
    const c = needGame();
    const r = c.setAbilityIcon(String(ability), icon === null ? null : String(icon));
    return { state: c.state(), failed: r.failed };
  });
  handle('icons:spells', async (names: unknown) => {
    // get() answers { pictures, reasons }: both go to the window as they are (wrapping it again hid every picture)
    try { const r = await spellPics.get(Array.isArray(names) ? names : []); return { pictures: r.pictures, reasons: r.reasons }; }
    catch (err) { return { pictures: {}, reasons: { '': String((err as Error)?.message || err) } }; }
  });
  handle('hero:preview', async (heroId: string) => ({ scene: await needGame().heroPreview(String(heroId)) }));
  handle('hero:reset', (heroId: string) => {
    const c = needGame();
    const r = c.resetHero(String(heroId));
    return { state: c.state(), failed: r.failed };
  });


  // ----- pictures: the player's own game, never a wiki. Missing ones come back absent and the card keeps its colour. -----
  handle('icons:items', async (ids: unknown) => {
    const list = (Array.isArray(ids) ? ids : []).slice(0, 60).map(String);
    try { return { pictures: await gameIcons.getMany(list) }; } catch { return { pictures: {} }; }
  });
  handle('icons:heroes', async (ids: unknown) => {
    try { return { pictures: await gameIcons.heroPortraits((Array.isArray(ids) ? ids : []).slice(0, 300)) }; }
    catch { return { pictures: {} }; }
  });

  // ----- Settings -----
  const toolsView = () => ({ tools: toolchain.state(), iconCacheBytes: gameIcons.size() + spellPics.size() });
  handle('settings:get', () => {
    const s = readSettings();
    return {
      gamePath: gamePath || '', gameValid: !!gamePath, modFolder: gamePath ? modFolderName(gamePath) : '', proxy: s.downloadProxy || '',
      toolsPromptSeen: !!s.toolsPromptSeen, version: app.getVersion(), dataDir: app.getPath('userData'),
      ...toolsView(),
    };
  });
  handle('settings:set', async (key: string, value: unknown) => {
    const s = readSettings();
    if (key === 'toolsPromptSeen') s.toolsPromptSeen = !!value;
    else if (key === 'downloadProxy') {
      const v = String(value || '').trim();
      if (!validProxy(v)) throw new Error('Прокси должен выглядеть как http://host:port или socks5://host:port');
      s.downloadProxy = v;
      await applyProxy(v);
    } else throw new Error('Неизвестная настройка');
    writeSettings(s);
    return {};
  });
  // Updates: a copy put in place by the installer updates itself; any other copy only learns that a newer one exists.
  const installed = canAutoUpdate({
    platform: process.platform, isPackaged: app.isPackaged, env: process.env,
    execDir: path.dirname(process.execPath), listDir: (d) => fs.readdirSync(d),
  });
  const updater = createUpdater({
    version: app.getVersion(),
    engine: installed ? (electronUpdater.autoUpdater as any) : null,
    send: (state) => { if (win && !win.isDestroyed()) win.webContents.send('update:state', state); },
    fetch: (u, i) => net.fetch(u, i) as unknown as Promise<Response>,
  });
  handle('update:state', () => ({ update: updater.state() }));
  handle('update:check', async () => ({ update: await updater.check() }));
  handle('update:install', () => ({ started: updater.install() }));
  handle('game:detect', async () => {
    const found = await findDotaGamePath();
    if (!found) return { found: false };
    writeSettings({ ...readSettings(), gamePath: found });
    bind(found);
    return { found: true, gamePath: found };
  });
  handle('tools:install', async (name: string) => {
    await toolchain.ensure(String(name || 'vrf'));
    return toolsView();
  });
  handle('tools:remove', (name: string) => {
    toolchain.remove(String(name || 'vrf'));
    gameIcons.clear(); // the pictures it produced are only reachable through it
    spellPics.clear();
    return toolsView();
  });
  handle('cache:clear', () => { gameIcons.clear(); spellPics.clear(); return toolsView(); });
  handle('shell:dataFolder', async () => { await shell.openPath(app.getPath('userData')); return {}; });
  handle('shell:external', async (url: string) => {
    if (!/^https:\/\/(github\.com|www\.youtube\.com)\//.test(String(url))) throw new Error('Ссылка не разрешена');
    await shell.openExternal(String(url));
    return {};
  });

  handle('shell:modsFolder', async () => {
    needGame();
    const dir = path.join(gamePath!, modFolderName(gamePath!));
    // no mod folder yet (nothing applied, or everything removed): show the game folder it will appear in
    const exists = fs.existsSync(dir);
    const err = await shell.openPath(exists ? dir : gamePath!);
    if (err) throw new Error('Не удалось открыть папку: ' + err);
    return { exists };
  });

  handle('shell:play', async () => {
    const c = needGame();
    c.heal(); // a Dota update may have wiped the patch: put it back before the game starts
    await shell.openExternal('steam://rungameid/570');
    return {};
  });

  ipcMain.on('win:min', () => win?.minimize());
  ipcMain.on('win:max', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.on('win:close', () => win?.close());

  createWindow();
  // after a Dota update the patch can be gone: repair once the window is up
  if (cos) { try { if (!isGameRunning()) cos.heal(); } catch { /* shown by the next state() */ } }
});

app.on('window-all-closed', () => app.quit());
