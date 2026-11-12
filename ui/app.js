// The window. Plain JS, no build step: it only talks to window.api (preload.cjs).
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.api;
  const META = new Map(window.SLOTS.map(([id, label, icon], i) => [id, { label, icon, order: i }]));
  const meta = (slot) => META.get(slot) || { label: slot.replace(/_/g, ' '), icon: 'auto_awesome', order: 1000 };

  const S = {
    connected: false, gameRunning: false, pending: false, applying: false, picks: {}, slots: null, loading: false, current: null, query: '',
    // hero items: the view (a slot of the free cosmetics, or the heroes), the grid, one hero's data, the picks
    why: new Map(), tab: 'cos', eq: null, eqLoading: false, pics: new Map(), tool: null, toolBusy: false, set: null,
    view: 'heroes', emblems: null, emblemsLoading: false, slotFx: {}, effects: [], items: {}, icons: {}, spells: null, spellsLoading: false, heroTab: 'items', gem: null, heroes: null, heroLoading: false, hero: null, heroData: null, heroSlot: null, fx: new Set(), setsOpen: false,
  };

  // replaceChildren(null) writes the text "null" into the page (it was showing under «Иконки способностей»):
  // skip empty kids the way h() does, for every call in this file
  {
    const rc = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function (...kids) { return rc.apply(this, kids.flat().filter((k) => k != null && k !== false)); };
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM: setAttribute('style') is blocked by the page's CSP
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }
  const icon = (name) => h('span', { class: 'mi', text: name });

  let toastTimer;
  function toast(msg, err = false) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, err ? 6000 : 2600);
  }

  /** Every IPC answer is { ok, ... }; an error becomes a toast and null. */
  async function call(fn, ...args) {
    const r = await fn(...args);
    if (!r || !r.ok) { toast((r && r.error) || 'Что-то пошло не так', true); return null; }
    return r;
  }


  // ---------- pictures from the player's own game ----------
  // A tile draws its colour at once and an <img> that fades in when the picture arrives; the
  // pictures are asked for in batches after each paint. No picture (no game file, tool not
  // downloaded) just leaves the colour.
  const pic = (kind, id) => h('img', { class: 'pic', alt: '', 'data-kind': kind, 'data-id': id, draggable: 'false' });
  let picGen = 0;
  async function fillPics(roots) {
    roots = Array.isArray(roots) ? roots : [roots];
    const imgsOf = (sel) => roots.flatMap((r) => [...r.querySelectorAll(sel)]);
    const gen = ++picGen;
    const need = { item: [], hero: [], spell: [] };
    for (const img of imgsOf('img.pic')) {
      const key = img.dataset.kind + ':' + img.dataset.id;
      const hit = S.pics.get(key);
      if (hit) { img.src = hit; img.classList.add('on'); }
      else if (hit === undefined) need[img.dataset.kind].push(img.dataset.id);
    }
    const run = async (kind, ids, fn, size) => {
      ids = [...new Set(ids)];
      for (let i = 0; i < ids.length; i += size) {
        const chunk = ids.slice(i, i + size);
        const r = await fn(chunk);
        const got = (r && r.ok && r.pictures) || {};
        const why = (r && r.ok && r.reasons) || {};
        for (const id of chunk) { S.pics.set(kind + ':' + id, got[id] || null); if (!got[id] && why[id]) S.why.set(kind + ':' + id, why[id]); }
        if (gen !== picGen) return; // the tiles were replaced meanwhile
        for (const img of imgsOf(`img.pic[data-kind="${kind}"]`)) {
          const uri = S.pics.get(kind + ':' + img.dataset.id);
          if (uri && !img.src) { img.src = uri; img.classList.add('on'); }
          // no picture: the tile says why (hover) instead of staying an unexplained empty square
          else if (!uri && S.why.has(kind + ':' + img.dataset.id) && img.parentElement && !img.parentElement.dataset.why) {
            const t = img.parentElement; t.dataset.why = '1';
            t.title = (t.title ? t.title + '\n' : '') + 'Нет картинки: ' + S.why.get(kind + ':' + img.dataset.id);
          }
        }
      }
    };
    await Promise.all([run('item', need.item, api.iconsItems, 24), run('hero', need.hero, api.iconsHeroes, 60), run('spell', need.spell, api.iconsSpells, 40)]);
  }

  function applyState(state, running) {
    if (state) { S.pending = !!state.pending; S.picks = state.picks || {}; S.items = state.items || {}; S.icons = state.icons || {}; S.gem = state.gem || null; S.slotFx = state.fx || {}; }
    if (typeof running === 'boolean') S.gameRunning = running;
    renderBar(); renderEqTab();
  }

  function renderBar() {
    const dot = $('dot'), txt = $('statusText');
    if (!S.connected) { dot.className = 'dot bad'; txt.textContent = 'Dota 2 не найдена'; }
    else if (S.pending) { dot.className = 'dot warn'; txt.textContent = S.gameRunning ? 'Есть неприменённые изменения: закрой Dota 2 и нажми «Применить косметику»' : 'Есть неприменённые изменения'; }
    else if (S.gameRunning) { dot.className = 'dot warn'; txt.textContent = 'Dota 2 запущена: закрой её, чтобы менять косметику'; }
    else { dot.className = 'dot ok'; txt.textContent = 'Dota 2 подключена'; }
    const ab = $('applyBtn');
    ab.disabled = !S.connected || S.applying || !S.pending;
    ab.classList.toggle('pending', S.connected && S.pending && !S.applying);
    $('applyLabel').textContent = S.applying ? 'Применяю…' : 'Применить косметику';
    $('playBtn').disabled = !S.connected;
    $('folderBtn').disabled = !S.connected;
  }

  // The left list: «Герой», «Эмблемы», then the free cosmetics (the slots read from the game), a line for each
  // slot under the name of its group. A slot that is in no group (one Valve adds later) goes to «Прочее».
  const RAIL_GROUPS = [
    { id: 'units', label: 'Спутники', icon: 'pets', slots: ['courier', 'ward', 'radiantcreeps', 'direcreeps', 'radiantsiegecreeps', 'diresiegecreeps', 'radianttowers', 'diretowers'] },
    { id: 'world', label: 'Игровой мир', icon: 'landscape', slots: ['terrain', 'weather'] },
    { id: 'ui', label: 'Интерфейс', icon: 'dashboard', slots: ['hud_skin', 'loading_screen', 'versus_screen'] },
    { id: 'sound', label: 'Звук', icon: 'music_note', slots: ['music', 'announcer', 'mega_kills'] },
    { id: 'fx', label: 'Эффекты', icon: 'auto_awesome', slots: ['streak_effect'] },
  ];
  /** The groups that have slots in this game, each with them. */
  function railGroups() {
    const emblemSlots = new Set((S.emblems || []).map((g) => g.slot)); // shown under «Эмблемы»
    const free = (S.slots || []).filter((s) => !emblemSlots.has(s.slot));
    const byId = new Map(free.map((s) => [s.slot, s]));
    const placed = new Set();
    const out = [];
    for (const g of RAIL_GROUPS) {
      const list = g.slots.map((id) => byId.get(id)).filter(Boolean);
      list.forEach((s) => placed.add(s.slot));
      if (list.length) out.push({ id: g.id, label: g.label, icon: g.icon, list });
    }
    const rest = free.filter((s) => !placed.has(s.slot));
    if (rest.length) out.push({ id: 'misc', label: 'Прочее', icon: 'category', list: rest });
    return out;
  }
  function openSlot(slot) {
    S.view = 'slot'; S.current = slot; S.query = ''; $('search').value = '';
    renderRail(); renderContent();
  }
  function renderRail() {
    const rail = $('rail');
    rail.hidden = S.tab !== 'cos';
    if (S.tab !== 'cos') return;
    rail.replaceChildren();
    if (!S.connected) return;
    const item = (active, ic, label, dot, onclick) => h('button', { class: 'rail-item' + (active ? ' active' : ''), type: 'button', onclick },
      icon(ic), h('span', { class: 'grow', text: label }), dot ? h('i', { class: 'rail-dot', title: 'Есть выбранное' }) : null);
    const hasHero = Object.keys(S.items).length > 0 || Object.keys(S.icons).length > 0;
    const hasEmblems = (S.emblems || []).some((g) => S.picks[g.slot]);
    rail.append(item(S.view === 'heroes', 'person', 'Герой', hasHero, openHeroes), item(S.view === 'emblems', 'star', 'Эмблемы', hasEmblems, openEmblems));
    if (S.loading) { rail.append(h('div', { class: 'rail-hint', text: 'Читаю таблицу предметов игры…' })); return; }
    // every slot is a line of its own, under the name of its group
    for (const g of railGroups()) {
      rail.append(h('div', { class: 'rail-label', text: g.label }));
      for (const sl of g.list) { const m = meta(sl.slot); rail.append(item(S.view === 'slot' && S.current === sl.slot, m.icon, m.label, !!S.picks[sl.slot], () => openSlot(sl.slot))); }
    }
  }

  // The entrance animation plays when the screen changes (another tab, category, hero) or when the content arrives
  // after a loader, not on every redraw: a pick redraws the grid and the cards must not jump again.
  let lastViewKey = '', lastWasEmpty = false, enterTimer = 0;
  const viewKey = () => { const id = (v) => (v && typeof v === 'object' ? (v.id ?? v.hero ?? v.slot ?? '') : (v ?? '')); return [S.tab, S.view, S.current, id(S.hero), S.heroTab, id(S.heroSlot)].join('|'); };
  function playEnter(c) {
    clearTimeout(enterTimer);
    c.classList.remove('enter'); void c.offsetWidth; c.classList.add('enter');
    enterTimer = setTimeout(() => c.classList.remove('enter'), 900);
  }
  function renderContent() {
    const c = $('content');
    const key = viewKey();
    const changed = key !== lastViewKey;
    lastViewKey = key;
    if (changed) playEnter(c);
    renderContentInner(c);
    const empty = !!(c.firstElementChild && c.firstElementChild.classList.contains('empty'));
    if (!changed && lastWasEmpty && !empty) playEnter(c);
    lastWasEmpty = empty;
    if (!(S.tab === 'cos' && S.view === 'heroes' && S.hero)) renderPicker();
    if (S.tab === 'cos') fillPics([c, $('pickerHost')]);
  }

  /* The brush on a card: a round button that shows when the card is hovered and opens a small menu of
   * effects for that one item. `apply(ids)` puts the item on with those effects and answers false when
   * it did not go in. The menu stays open (it lives on the page, not in the grid that is redrawn). */
  /* The effects in the order the picker shows them, each with a picture of what it does (ui/img/fx).
   * An effect with no picture (one the game adds) gets an icon tile. */
  const FX_ORDER = ['fire', 'lightnings', 'frostbloom', 'snow', 'sand-storm', 'ghost', 'gold-glow', 'smoke', 'featherfall'];
  const FX_PICS = new Set(FX_ORDER);
  // pictures of the three seasonal effects, carried in the code so they show even when ui/img/fx is not copied along
  const FX_INLINE = {
    'gold-glow': 'data:image/jpeg;base64,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',
    'smoke': 'data:image/jpeg;base64,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',
    'featherfall': 'data:image/jpeg;base64,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',
  };
  const fxSorted = (list) => {
    const all = list.filter((e) => e.id);
    const at = (id) => { const i = FX_ORDER.indexOf(id); return i < 0 ? FX_ORDER.length : i; };
    return all.map((e, i) => ({ e, i })).sort((a, b) => at(a.e.id) - at(b.e.id) || a.i - b.i).map((x) => x.e);
  };
  function fxThumb(id, gem = false) {
    if (gem) return h('img', { class: 'fxpic', src: 'img/kinetic-gem.jpg', alt: '', draggable: 'false' });
    if (!FX_PICS.has(id)) return h('span', { class: 'fxnone' }, icon(id === 'sand-storm' ? 'air' : 'auto_awesome'));
    const img = h('img', { class: 'fxpic', src: FX_INLINE[id] || `img/fx/${id}.jpg`, alt: '', draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: 'fxnone' }, icon('auto_awesome'))));
    return img;
  }
  let fxMenuEl = null;
  function closeFxMenu() {
    if (fxMenuEl) { fxMenuEl.remove(); fxMenuEl = null; }
    document.removeEventListener('keydown', fxEsc, true);
  }
  function fxEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); closeFxMenu(); } }
  /* The effects window: a dialog in the middle of the screen over a dimmed backdrop, with big picture tiles. */
  function openFxMenu(anchor, ids, apply, title, courier = false, kinetic = false) {
    closeFxMenu();
    let cur = [...ids];
    const menu = h('div', { class: 'overlay fxoverlay' });
    const box = h('div', { class: 'fxmenu', role: 'dialog', 'aria-modal': 'true' });
    menu.append(box); // the box is made once, so a pick redraws its content without replaying the pop-in
    const tile = (e) => {
      const on = cur.includes(e.id);
      return h('button', {
        class: 'fxtile' + (on ? ' active' : ''), type: 'button', title: e.name, 'aria-pressed': on ? 'true' : 'false',
        onclick: async () => {
          const next = on ? cur.filter((x) => x !== e.id) : [...cur, e.id];
          if (await apply(next) !== false) { cur = next; paint(); }
        },
      }, fxThumb(e.id, !!e.kinetic), h('span', { class: 'fxname', text: e.name }), on ? h('span', { class: 'fxcheck' }, icon('check_circle')) : null);
    };
    /* One window for the effects, another for the Kinetic Gems of this hero (never on the courier).
     * The builder's own effects come first, then the game's unusual ones (Ethereal Flame, Sunfire...), all in one grid;
     * the search in the head narrows it, there are a few dozen. */
    const kineticIds = new Set(S.effects.filter((e) => e.kinetic).map((e) => e.id));
    const grid = h('div', { class: 'fxgrid' });
    const scroll = h('div', { class: 'fxscroll' }, grid);
    const input = h('input', { type: 'search', placeholder: 'Найти эффект…', autocomplete: 'off' });
    const searchBox = h('label', { class: 'search' }, icon('search'), input);
    const fill = () => {
      const shown = S.effects.filter((e) => e.id && !(courier && e.heroOnly) && (!e.hero || (!courier && (S.hero === e.hero || (e.heroes || []).includes(S.hero)))))
        .filter((e) => (kinetic ? !!e.kinetic : !e.kinetic));
      searchBox.hidden = shown.length < 13;
      const want = searchBox.hidden ? '' : input.value.trim().toLowerCase();
      const hits = (kinetic ? shown : fxSorted(shown)).filter((e) => !want || e.name.toLowerCase().includes(want));
      grid.replaceChildren(...(hits.length ? hits.map(tile) : [h('div', { class: 'fxempty', text: 'Ничего не найдено' })]));
    };
    input.addEventListener('input', fill);
    // the head and the grid are made once (the search keeps its text and focus); a pick redraws the tiles and the foot
    const foot = h('div', { class: 'fxmenu-foot' });
    box.append(
      h('div', { class: 'fxmenu-head' },
        kinetic ? h('img', { class: 'fxhead-gem', src: 'img/kinetic-gem.jpg', alt: '', draggable: 'false' }) : icon('brush'),
        h('span', { class: 'fxlabel', text: kinetic ? 'Кинетики' : 'Эффекты' }),
        title && title !== 'null' ? h('span', { class: 'fxmenu-title', text: String(title) }) : null,
        h('div', { class: 'grow' }),
        searchBox,
        h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Закрыть', onclick: closeFxMenu }, icon('close'))),
      scroll, foot);
    const paint = () => {
      const top = scroll.scrollTop;
      fill();
      scroll.scrollTop = top;
      foot.replaceChildren(...[
        cur.some((id) => kineticIds.has(id) === kinetic) ? h('button', { class: 'btn', type: 'button', onclick: async () => {
          const rest = cur.filter((id) => kineticIds.has(id) !== kinetic); // the other window's picks stay
          if (await apply(rest) !== false) { cur = rest; paint(); }
        } }, kinetic ? 'Убрать кинетики' : 'Убрать все эффекты') : null,
        h('div', { class: 'grow' }),
        h('button', { class: 'btn primary', type: 'button', onclick: closeFxMenu }, 'Готово'),
      ].filter(Boolean));
    };
    paint();
    menu.addEventListener('mousedown', (e) => { if (e.target === menu) closeFxMenu(); });
    document.body.append(menu);
    fxMenuEl = menu;
    document.addEventListener('keydown', fxEsc, true);
  }
  /** A card with the brush on it: `on` when the item carries effects. For couriers; a hero's item has tabs in its window. */
  function withBrush(card, { on, ids, apply, title, courier = false }) {
    const brush = h('button', {
      class: 'fxbrush' + (on ? ' on' : ''), type: 'button', title: 'Эффекты', 'aria-label': 'Эффекты',
      onclick: (e) => { e.stopPropagation(); openFxMenu(brush, ids, apply, title, courier); },
    }, icon('brush'));
    return h('div', { class: 'cardwrap' }, card, brush);
  }
  /** The effects a hero's item can take: the Kinetic Gems of this hero, or everything else. */
  const heroFxList = (kinetic) => S.effects.filter((e) => e.id && (!e.hero || S.hero === e.hero || (e.heroes || []).includes(S.hero)) && !!e.kinetic === kinetic);
  /* The effects of the worn item: a tab of the slot window (and one more for the hero's Kinetic Gems).
   * `row`: what is on and the search; `body`: a picture tile for each effect. The window is drawn again after a pick. */
  function fxPane({ fx, apply, kinetic }) {
    const all = heroFxList(kinetic), list = kinetic ? all : fxSorted(all);
    const mine = new Set(all.map((e) => e.id));
    const on = fx.filter((id) => mine.has(id));
    const grid = h('div', { class: 'fxgrid' });
    const fill = () => {
      const want = (S.fxq || '').trim().toLowerCase();
      const hits = list.filter((e) => !want || e.name.toLowerCase().includes(want));
      grid.replaceChildren(...(hits.length ? hits.map((e) => {
        const active = fx.includes(e.id);
        return h('button', { class: 'fxtile' + (active ? ' active' : ''), type: 'button', title: e.name, 'aria-pressed': active ? 'true' : 'false',
          onclick: () => apply(active ? fx.filter((x) => x !== e.id) : [...fx, e.id]) },
          fxThumb(e.id, !!e.kinetic), h('span', { class: 'fxname', text: e.name }), active ? h('span', { class: 'fxcheck' }, icon('check_circle')) : null);
      }) : [h('div', { class: 'fxempty', text: 'Ничего не найдено' })]));
    };
    const input = h('input', { type: 'search', placeholder: kinetic ? 'Найти кинетик…' : 'Найти эффект…', value: S.fxq || '', autocomplete: 'off' });
    input.addEventListener('input', (e) => { S.fxq = e.target.value; fill(); });
    fill();
    const row = h('div', { class: 'fxrow gemrow' },
      h('span', { class: 'fxlabel', text: kinetic ? 'Кинетики' : 'Эффекты' }),
      h('span', { class: 'gemnow-text dim', text: on.length ? `Выбрано: ${on.length}` : 'Ничего не выбрано' }),
      h('div', { class: 'grow' }),
      on.length ? h('button', { class: 'pillbtn', type: 'button', onclick: () => apply(fx.filter((id) => !mine.has(id))) }, kinetic ? 'Убрать кинетики' : 'Убрать все эффекты') : null);
    return { row, body: [grid], search: list.length > 12 ? h('label', { class: 'search' }, icon('search'), input) : null };
  }

  function renderContentInner(c) {
    if (S.tab === 'set') { renderSettings(c); return; }
    if (S.tab === 'eq') { renderEquipped(c); return; }
    c.scrollTop = 0;
    if (!S.connected) {
      c.replaceChildren(h('div', { class: 'empty' }, icon('folder_off'),
        h('h2', { text: 'Dota 2 не найдена' }),
        h('p', { text: 'Укажи папку игры: …\\steamapps\\common\\dota 2 beta\\game' }),
        h('button', { class: 'btn primary', type: 'button', onclick: chooseGame, text: 'Выбрать папку' })));
      return;
    }
    if (S.view === 'heroes') { renderHeroes(c); return; }
    if (S.view === 'emblems') { renderEmblems(c); return; }
    if (S.loading) { c.replaceChildren(h('div', { class: 'empty' }, icon('hourglass_top'), h('h2', { text: 'Читаю таблицу предметов…' }))); return; }
    const slot = (S.slots || []).find((s) => s.slot === S.current);
    if (!slot) { c.replaceChildren(h('div', { class: 'empty' }, icon('category'), h('h2', { text: 'Выбери категорию слева' }))); return; }

    const q = S.query.trim().toLowerCase();
    const opts = slot.options.filter((o) => !q || o.name.toLowerCase().includes(q));
    const m = meta(slot.slot);
    const picked = S.picks[slot.slot];
    const fxSlot = slot.slot === 'courier' && S.effects.length > 0;
    const fxIds = (S.slotFx[slot.slot] || '').split(',').filter(Boolean);
    /* The cards of the slot. A courier (the slot with effects) puts the worn one first, then the default. */
    const courierCards = () => {
      const fxTag = (o) => fxTags({ effects: S.slotFx[slot.slot] || '' }, S.effects, null);
      const cards = opts.map((o) => {
        const on = picked === o.id;
        const card = h('button', { class: 'card' + (on ? ' picked' : ''), type: 'button', title: o.name, onclick: () => pick(slot.slot, on ? null : o.id) },
          pic('item', o.id),
          on ? h('span', { class: 'badge', text: 'Надето' }) : null,
          on && fxSlot ? fxTag(o) : null,
          h('div', { class: 'name', text: o.name }), h('div', { class: 'sub', text: m.label }));
        return { id: o.id, el: fxSlot ? withBrush(card, { on: on && fxIds.length > 0, ids: on ? fxIds : [], title: o.name, apply: (next) => pickFx(slot.slot, o.id, next), courier: true }) : card };
      });
      if (!fxSlot) return cards.map((x) => x.el);
      const lead = cards.filter((x) => x.id === picked).map((x) => x.el);
      const rest = cards.filter((x) => x.id !== picked).map((x) => x.el);
      const def = [];
      if (!q) {
        const on = !picked;
        const card = h('button', { class: 'card' + (on ? ' picked' : ''), type: 'button', title: 'Стандартный курьер', onclick: () => pick(slot.slot, null) },
          pic('item', slot.base),
          on ? h('span', { class: 'badge', text: 'Надето' }) : null,
          on ? fxTag(null) : null,
          h('div', { class: 'name', text: 'Стандартный курьер' }), h('div', { class: 'sub', text: m.label }));
        def.push(withBrush(card, { on: on && fxIds.length > 0, ids: on ? fxIds : [], title: 'Стандартный курьер', apply: (next) => pickFx(slot.slot, null, next), courier: true }));
      }
      return [...lead, ...def, ...rest];
    };
    c.replaceChildren(
      h('div', { class: 'head' },
        h('h1', { text: m.label }), h('span', { class: 'count', text: `${opts.length} из ${slot.options.length}` }), h('div', { class: 'grow' }),
        picked ? h('button', { class: 'btn ghost', type: 'button', onclick: () => pick(slot.slot, null), text: 'Сбросить на стандартный' }) : null),
      opts.length || (fxSlot && !q) ? h('div', { class: 'grid' }, courierCards()) : h('div', { class: 'empty' }, icon('search_off'), h('h2', { text: 'Ничего не найдено' })));
  }


  // ---------- hero items («Предметы») ----------
  const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? few : many}`;
  /** A pick's effects string ("fire,snow,style-2") as the effect ids and the style number. */
  const parsePick = (rec) => {
    const ids = rec ? rec.effects.split(',').filter(Boolean) : [];
    return { fx: ids.filter((x) => !/^style-\d+$/.test(x)), style: Number((ids.find((x) => /^style-\d+$/.test(x)) || '').slice(6)) || 0 };
  };
  const buildFx = (fx, style) => [...fx, ...(style ? [`style-${style}`] : [])];

  // ---------- emblems («Эмблемы») ----------
  function openEmblems() {
    S.view = 'emblems'; S.query = ''; $('search').value = '';
    renderRail(); renderContent();
    loadEmblems(); // read again: a VPK put in assets/emblem-attack since changes the marks
  }

  async function loadEmblems() {
    S.emblemsLoading = true; renderContent();
    const r = await call(api.emblems);
    S.emblemsLoading = false;
    S.emblems = r ? r.groups : [];
    renderRail(); renderContent();
  }

  async function pickEmblem(slot, itemId) {
    if (picking) return;
    picking = true;
    try {
      const r = await call(api.pickEmblem, slot, itemId);
      if (!r) return;
      applyState(r.state);
      S.eq = null;
      toast(itemId ? 'Эмблема выбрана. Нажми «Применить косметику».' : 'Эмблема сброшена. Нажми «Применить косметику».');
      renderRail(); renderContent();
    } finally { picking = false; }
  }

  function renderEmblems(c) {
    if (S.emblemsLoading || !S.emblems) { c.replaceChildren(h('div', { class: 'empty' }, icon('hourglass_top'), h('h2', { text: 'Ищу эмблемы…' }))); return; }
    if (!S.emblems.length) {
      c.replaceChildren(h('div', { class: 'empty' }, icon('search_off'), h('h2', { text: 'Эмблемы не найдены' }),
        h('p', { text: 'В таблице предметов этой версии игры нет эмблем с внешним видом.' })));
      return;
    }
    const q = S.query.trim().toLowerCase();
    const kids = [];
    for (const g of S.emblems) {
      const opts = g.options.filter((o) => !q || o.name.toLowerCase().includes(q));
      if (!opts.length) continue;
      const picked = S.picks[g.slot];
      kids.push(h('div', { class: 'head' },
        h('h1', { text: 'Эмблемы' }), h('span', { class: 'count', text: `${opts.length} из ${g.options.length}` }), h('div', { class: 'grow' }),
        picked ? h('button', { class: 'btn ghost', type: 'button', onclick: () => pickEmblem(g.slot, null), text: 'Сбросить на стандартную' }) : null));
      kids.push(h('p', { class: 'rail-hint', text: 'Можно надеть только одну эмблему: выбор другой снимает текущую. Эффект атаки у эмблем с пометкой «эффект атаки» включается сам, когда ты их надеваешь. Эффект Diretide видят и другие игроки без своей эмблемы: файлом сделать его только своим нельзя.' }));
      if (!g.base) kids.push(h('p', { class: 'rail-hint', text: 'У этого слота нет бесплатного базового предмета, поэтому заменить эмблему не получится.' }));
      kids.push(h('div', { class: 'grid' }, opts.map((o) => {
        const on = picked === o.id;
        const card = h('button', { class: 'card' + (on ? ' picked' : ''), type: 'button', title: o.name, onclick: () => pickEmblem(g.slot, on ? null : o.id) },
          pic('item', o.id),
          on ? h('span', { class: 'badge', text: 'Надето' }) : null,
          h('div', { class: 'name', text: o.name }), h('div', { class: 'sub', text: o.attack ? 'Эмблема · эффект атаки' : 'Эмблема · без эффекта атаки' }));
        return card;
      })));
    }
    c.replaceChildren(...(kids.length ? kids : [h('div', { class: 'empty' }, icon('search_off'), h('h2', { text: 'Ничего не найдено' }))]));
  }

  // ---------- ability icons: the third tab of a hero's screen ----------
  async function loadSpells() {
    S.spellsLoading = true; renderContent();
    const r = await call(api.spellList);
    S.spellsLoading = false;
    S.spells = r ? r.heroes : [];
    renderContent();
  }

  async function spellPick(ability, iconName) {
    if (picking) return;
    picking = true;
    const keep = $('content').scrollTop;
    try {
      const r = await call(api.spellPick, ability, iconName);
      if (!r) return;
      applyState(r.state);
      S.eq = null;
      if (r.failed && r.failed.length) toast('Не вошло в сборку: ' + r.failed[0], true); else toast(iconName ? 'Иконка выбрана. Нажми «Применить косметику».' : 'Иконка сброшена. Нажми «Применить косметику».');
      renderRail(); renderContent();
      $('content').scrollTop = keep;
    } finally { picking = false; }
  }

  /** The open hero's abilities, each with the icons it can take. */
  function spellsPane() {
    if (S.spellsLoading || !S.spells) {
      if (!S.spells && !S.spellsLoading) queueMicrotask(loadSpells); // not from inside the paint it is called by
      return [h('div', { class: 'empty' }, icon('hourglass_top'), h('h2', { text: 'Читаю иконки способностей…' }))];
    }
    const hero = S.spells.find((x) => x.hero === S.hero);
    if (!hero) return [h('div', { class: 'empty' }, icon('image_not_supported'), h('h2', { text: 'У героя нет альтернативных иконок' }))];
    const picked = (a) => S.icons[a.ability] || null;
    // Valve stores many of these pictures compressed: reading them needs the extra content from the settings
    const needTool = S.tool && S.tool.available && !S.tool.ready
      ? h('div', { class: 'notice' }, icon('image_not_supported'), h('div', {},
        h('b', { text: 'Картинок иконок может не быть' }),
        h('p', { text: 'Часть иконок Valve хранит сжатыми, и без дополнительного контента (Source 2 Viewer, около 50 МБ) их не прочитать: останутся только подписи. Выбор иконок при этом работает.' }),
        h('button', { class: 'btn sm primary', type: 'button', disabled: S.toolBusy, onclick: installTool }, icon('download'), 'Скачать'))) : null;
    const reset = hero.abilities.some(picked) ? h('div', { class: 'fxrow' }, h('div', { class: 'grow' }),
      h('button', { class: 'pillbtn', type: 'button', onclick: async () => { for (const a of hero.abilities) if (picked(a)) await spellPick(a.ability, null); } }, 'Сбросить иконки')) : null;
    return [needTool, reset, ...hero.abilities.map((a) => h('div', { class: 'abrow' },
      h('div', { class: 'abtitle' }, h('b', { text: a.name }), h('span', { text: a.ability })),
      h('div', { class: 'spellrow' }, a.variants.map((v) => {
        const on = (picked(a) || a.ability) === v.icon;
        return h('button', { class: 'spelltile' + (on ? ' on' : ''), type: 'button', title: v.label || 'Обычная иконка',
          onclick: () => spellPick(a.ability, v.icon === a.ability ? null : v.icon) },
          pic('spell', v.icon),
          on ? h('span', { class: 'spellmark' }, icon('check_circle')) : null,
          h('span', { class: 'spelllabel', text: v.label || 'Обычная' }));
      }))))];
  }

  function openHeroes() {
    S.view = 'heroes'; S.hero = null; S.query = ''; $('search').value = '';
    renderRail(); renderContent(); // the grid asks for the heroes itself when it has none
  }

  async function loadHeroes() {
    S.heroLoading = true; renderContent();
    const r = await call(api.heroes);
    S.heroLoading = false;
    S.heroes = r ? r.heroes : [];
    renderContent();
  }

  async function openHero(id, name) {
    S.pickerOpen = false; S.hero = id; S.heroName = name || id; S.heroTab = 'items'; S.heroData = null; S.heroSlot = null; S.query = ''; $('search').value = ''; S.fx = new Set(); S.setsOpen = false;
    renderContent();
    await loadHero();
  }

  async function loadHero() {
    const r = await call(api.heroSlots, S.hero);
    if (!r) { S.hero = null; renderContent(); return; }
    S.heroData = r;
    if (!r.slots.some((x) => x.slot === S.heroSlot)) S.heroSlot = r.slots.length ? r.slots[0].slot : null;
    renderContent();
  }

  /** After a pick or a reset: the state, a failed pick said, and the hero read again (the grid with it, next time it opens). */
  async function heroDone(r, okText) {
    if (!r) return;
    applyState(r.state);
    S.heroes = null;
    if (r.failed && r.failed.length) toast('Не вошло в сборку: ' + r.failed[0], true); else toast(okText);
    renderRail();
    await loadHero();
  }

  /** A hero item with effects from its brush; false when it did not go in. */
  async function heroFx(slotId, itemId, fx) {
    if (picking) return false;
    picking = true;
    try {
      const r = await call(api.heroPick, slotId, itemId, fx);
      if (!r) return false;
      await heroDone(r, 'Выбрано. Нажми «Применить косметику».');
      return true;
    } finally { picking = false; }
  }

  async function heroPick(slotId, itemId, fx) {
    if (picking) return;
    picking = true;
    try { await heroDone(await call(api.heroPick, slotId, itemId, fx), itemId ? 'Выбрано. Нажми «Применить косметику».' : 'Сброшено. Нажми «Применить косметику».'); }
    finally { picking = false; }
  }

  async function heroGem(color, set) {
    if (picking) return;
    picking = true;
    try { await heroDone(await call(api.heroGem, color, set), color ? 'Цвет гема выбран. Нажми «Применить косметику».' : 'Гем сброшен. Нажми «Применить косметику».'); }
    finally { picking = false; }
  }

  // The gem's colour for Terrorblade's and Techies' arcanas, each its own, in the window of the arcana's slot.
  // It lives in the arcana's files (the mod has no gem to socket), so it is a colour; the game's own
  // Prismatic Gems (read from its item table) are offered by name, and any colour besides.
  const GEM_DEFAULT = [255, 60, 40];
  const GEM_DEFAULT_TECHIES = [255, 175, 0];
  /** colours for when the game's table gave no Prismatic Gems */
  const GEM_COLORS = [GEM_DEFAULT, [255, 175, 0], [255, 140, 20], [255, 214, 40], [90, 220, 90], [30, 210, 220], [60, 110, 255], [170, 80, 255], [255, 90, 200], [235, 235, 235]];
  const toHex = (c) => '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
  const fromHex = (v) => [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  /** One arcana's colour now, or null. */
  const gemOf = (set) => (S.gem && S.gem[set]) || null;
  /** The gem the arcana on this card takes, or null: Terrorblade's and Techies' arcanas. */
  function gemFor(o) {
    if (S.hero === 'terrorblade' && /Fractal Horns/i.test(o.name)) return { def: GEM_DEFAULT, arcana: o.name, set: 'terrorblade-arcana' };
    if (S.hero === 'techies' && /Swine of the Sunken Galley/i.test(o.name)) return { def: GEM_DEFAULT_TECHIES, arcana: o.name, set: 'techies-arcana' };
    return null;
  }
  const rgb2hsv = ([r, g, b]) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hh = 0;
    if (d) { if (mx === r) hh = ((g - b) / d) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360; }
    return [hh, mx ? d / mx : 0, mx];
  };
  const hsv2rgb = ([hh, s, v]) => {
    const c = v * s, x = c * (1 - Math.abs((hh / 60) % 2 - 1)), m = v - c;
    const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map((n) => Math.round((n + m) * 255));
  };
  /* The gems of the worn arcana: a tab of the slot window, next to its items. A card for each Prismatic Gem,
   * and a picker for any colour. The window is drawn again after every pick, so what is open is kept here. */
  const sameRgb = (a, b) => !!a && !!b && a.every((n, i) => n === b[i]);
  const GP = { set: null, panel: false, hsv: null };
  function gemColorsOf(def) {
    // the game's Prismatic Gems by name; without them, a few colours of our own
    const game = (S.heroData && S.heroData.gems) || [];
    return game.length
      ? [{ rgb: def, name: 'По умолчанию' }, ...game.filter((g) => !sameRgb(g.rgb, def))]
      : [def, ...GEM_COLORS.filter((c) => !sameRgb(c, def))].map((c, i) => ({ rgb: c, name: i ? toHex(c).toUpperCase() : 'По умолчанию' }));
  }
  /** `row`: the colour now and its buttons; `body`: the picker for any colour (when open) and the gems. */
  function gemPane({ def, set: gemSet }) {
    if (GP.set !== gemSet) { GP.set = gemSet; GP.panel = false; GP.hsv = null; }
    const cur = gemOf(gemSet), hex = toHex(cur || def);
    if (!GP.hsv) GP.hsv = rgb2hsv(cur || def);
    const colors = gemColorsOf(def);
    const curName = cur ? (colors.find((g) => sameRgb(g.rgb, cur)) || {}).name : 'По умолчанию';
    const set = async (c, fromPanel) => { if (!fromPanel) GP.hsv = c ? rgb2hsv(c) : null; await heroGem(c, gemSet); };

    // a gem as the game draws it: its own socket picture, the shared gem picture with the colour laid on its mask, or a plain gem
    const art = S.heroData && S.heroData.gemArt;
    const gemPic = (g) => {
      if (g.picture) return h('img', { class: 'gemart', src: g.picture, alt: '', draggable: 'false' });
      if (!art) return h('span', { class: 'gemart plain' });
      return h('span', { class: 'gemart' },
        h('img', { src: art.image, alt: '', draggable: 'false' }),
        art.mask ? h('span', { class: 'gemtint', style: `-webkit-mask-image:url("${art.mask}");mask-image:url("${art.mask}")` }) : null,
        art.mask ? h('img', { class: 'gemfacets', src: art.mask, alt: '', draggable: 'false' }) : null);
    };
    const card = (g) => {
      const on = cur ? sameRgb(cur, g.rgb) : g.rgb === def;
      return h('button', { class: 'gemcard' + (on ? ' active' : ''), type: 'button', title: `${g.name} · ${toHex(g.rgb).toUpperCase()}`, style: `--gem:${toHex(g.rgb)}`,
        onclick: () => set(g.rgb === def ? null : g.rgb) },
        h('span', { class: 'gemmedia' }, gemPic(g)), h('span', { class: 'gemname', text: g.name }), on ? h('span', { class: 'gemcheck' }, icon('check_circle')) : null);
    };

    const nowText = h('span', { class: 'gemnow-text', text: (curName ? curName + ' · ' : '') + hex.toUpperCase() });
    const now = h('span', { class: 'gemnow', style: `--gem:${hex}` }, h('i'), nowText);
    const row = h('div', { class: 'fxrow gemrow' },
      h('span', { class: 'fxlabel', text: 'Цвет гема' }), now,
      h('div', { class: 'grow' }),
      h('button', { class: 'pillbtn' + (GP.panel ? ' active' : ''), type: 'button', onclick: () => { GP.panel = !GP.panel; if (GP.panel) GP.hsv = rgb2hsv(gemOf(gemSet) || def); renderPicker(); } }, icon('palette'), 'Свой цвет'),
      cur ? h('button', { class: 'pillbtn', type: 'button', onclick: () => set(null) }, 'Сбросить цвет') : null);

    const body = [];
    if (GP.panel) {
      const svKnob = h('div', { class: 'gemknob' }), hueKnob = h('div', { class: 'gemknob' });
      const svEl = h('div', { class: 'gemsv' }, svKnob), hueEl = h('div', { class: 'gemhue' }, hueKnob);
      const prev = h('div', { class: 'prev' });
      const hexIn = h('input', { class: 'gemhexin', type: 'text', maxlength: '7', spellcheck: 'false', 'aria-label': 'Цвет в виде #RRGGBB' });
      // while a knob is dragged the pane only follows it; the colour is kept when the mouse is let go
      const sync = () => {
        const hsv = GP.hsv, x = toHex(hsv2rgb(hsv));
        now.style.setProperty('--gem', x); nowText.textContent = x.toUpperCase();
        svEl.style.setProperty('--hue', Math.round(hsv[0]));
        svKnob.style.left = hsv[1] * 100 + '%'; svKnob.style.top = (1 - hsv[2]) * 100 + '%'; svKnob.style.background = x;
        hueKnob.style.left = hsv[0] / 360 * 100 + '%'; hueKnob.style.background = `hsl(${Math.round(hsv[0])},100%,50%)`;
        hexIn.value = x; prev.style.setProperty('--gem', x);
      };
      const drag = (el, onMove) => {
        let on = false;
        const at = (e) => { const r = el.getBoundingClientRect(); onMove(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))); sync(); };
        el.addEventListener('pointerdown', (e) => { on = true; el.setPointerCapture(e.pointerId); at(e); });
        el.addEventListener('pointermove', (e) => { if (on) at(e); });
        const end = () => { if (on) { on = false; set(hsv2rgb(GP.hsv), true); } };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
      };
      const fromText = () => { const m = /^#?([0-9a-f]{6})$/i.exec(hexIn.value.trim()); if (m) set(fromHex('#' + m[1].toLowerCase())); else sync(); };
      hexIn.addEventListener('change', fromText);
      hexIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') fromText(); });
      drag(svEl, (x, y) => { GP.hsv = [GP.hsv[0], x, 1 - y]; });
      drag(hueEl, (x) => { GP.hsv = [x * 359.99, GP.hsv[1], GP.hsv[2]]; });
      body.push(h('div', { class: 'gempanel' }, svEl, h('div', { class: 'gempanel-side' }, hueEl, h('div', { class: 'gemhexrow' }, prev, hexIn))));
      sync();
    }
    body.push(h('div', { class: 'gemgrid' }, colors.map(card)));
    return { row, body };
  }

  // The heroes: a tile each. The grid comes sorted by name; «изменённые сверху» lifts the ones that wear something.
  const HERO_SORT = 'hero-sort';
  S.heroSort = (() => { try { return localStorage.getItem(HERO_SORT) === 'name' ? 'name' : 'changed'; } catch { return 'changed'; } })();
  function renderHeroes(c) {
    if (S.hero) { renderHero(c); return; }
    if (S.heroLoading || !S.heroes) { c.replaceChildren(h('div', { class: 'empty' }, icon('hourglass_top'), h('h2', { text: 'Читаю таблицу предметов…' }))); if (!S.heroes && !S.heroLoading) loadHeroes(); return; }
    const q = S.query.trim().toLowerCase();
    const list = S.heroes.filter((x) => !q || x.name.toLowerCase().includes(q));
    const shown = S.heroSort === 'changed' ? [...list.filter((x) => x.picked), ...list.filter((x) => !x.picked)] : list;
    const sort = h('button', { class: 'btn', type: 'button', title: 'Сменить порядок', onclick: () => {
      S.heroSort = S.heroSort === 'changed' ? 'name' : 'changed';
      try { localStorage.setItem(HERO_SORT, S.heroSort); } catch { /* the order is then kept for this run only */ }
      renderContent();
    } }, `Сортировка: ${S.heroSort === 'changed' ? 'изменённые сверху' : 'по алфавиту'}`, icon('swap_vert'));
    c.replaceChildren(
      h('div', { class: 'head' }, h('h1', { text: 'Герои' }), h('span', { class: 'count', text: `${list.length} из ${S.heroes.length}` }), h('div', { class: 'grow' }), sort),
      list.length ? h('div', { class: 'herogrid' }, shown.map((x) => h('button', { class: 'herotile' + (x.picked ? ' picked' : ''), type: 'button', onclick: () => openHero(x.id, x.name) },
        h('span', { class: 'letter', text: x.name.slice(0, 1) }),
        pic('hero', x.id),
        x.picked ? h('i', { class: 'herodot' }) : null,
        h('span', { class: 'herocap' },
          h('span', { class: 'name', text: x.name }),
          h('span', { class: 'sub', text: x.picked ? `Изменено ${x.picked} из ${x.slots}` : plural(x.sets, 'набор', 'набора', 'наборов') })))))
        : h('div', { class: 'empty' }, icon('search_off'), h('h2', { text: 'Ничего не найдено' })));
  }

  /** Small tags saying which effects and style are on a worn item. */
  function fxTags(rec, effects, opt) {
    if (!rec) return null;
    const { fx, style } = parsePick(rec);
    const all = fx.map((id) => effects.find((e) => e.id === id) || { id, name: id });
    // one effect: its name; several: how many ("Эффектов применено 3"). Kinetic Gems count apart from the effects.
    const group = (list, many) => (list.length === 1 ? [list[0].name] : list.length > 1 ? [`${many} применено ${list.length}`] : []);
    const names = [...group(all.filter((e) => !e.kinetic), 'Эффектов'), ...group(all.filter((e) => e.kinetic), 'Кинетиков')];
    if (style > 0 && opt && opt.styles && opt.styles.length > 1) names.push(`Стиль ${style + 1}`);
    if (!names.length) return null;
    return h('span', { class: 'fxtags', title: 'Добавлено: ' + all.map((e) => e.name).concat(style > 0 ? [`Стиль ${style + 1}`] : []).join(', ') }, names.map((n) => h('span', { text: n })));
  }

  // The hero preview: a panel that stays on the hero screen (ui/preview.js) and is built again by
  // src/preview.ts whenever what the hero wears changes. One panel for the whole session: the hero
  // screen redraws often, and the panel (with its WebGL context) is moved into each new layout.
  const PV = { stage: null, key: '', seq: 0 };
  function previewStage() {
    if (!PV.stage) PV.stage = window.HeroPreview.createStage();
    return PV.stage;
  }
  async function refreshPreview() {
    const d = S.heroData;
    if (!S.hero || !d) return;
    const key = S.hero + '|' + JSON.stringify(d.slots.map((s) => (s.picked ? [s.slot, s.picked.itemId, s.picked.effects] : 0))) + '|' + JSON.stringify(S.gem || 0);
    if (key === PV.key) return;
    PV.key = key;
    const seq = ++PV.seq, hero = S.hero, stage = previewStage();
    stage.status('Собираю превью…');
    const r = await call(api.heroPreview, hero);
    if (seq !== PV.seq) return;            // a newer pick asked again meanwhile
    if (r && r.scene) stage.show({ scene: r.scene, hero });
    else { stage.status('Превью не собралось'); PV.key = ''; }
  }


  // The hero screen: the preview on the left, and on the right what the tab at the top says: a row for each slot
  // (what is worn there now), the effects of the worn items, or the ability icons. A click on a row opens the
  // window of that slot, where the items, effects and gems are chosen.
  function renderHero(c) {
    const name = S.heroName || S.hero;
    const back = h('button', { class: 'btn', type: 'button', onclick: () => { S.hero = null; S.pickerOpen = false; S.query = ''; $('search').value = ''; renderContent(); if (!S.heroes) loadHeroes(); } }, icon('arrow_back'), 'Герои');
    const d = S.heroData;
    if (!d) { c.replaceChildren(h('div', { class: 'head' }, back, h('h1', { text: name })), h('div', { class: 'empty' }, icon('hourglass_top'), h('h2', { text: 'Читаю предметы героя…' }))); renderPicker(); return; }
    const tab = ['items', 'fx', 'icons'].includes(S.heroTab) ? S.heroTab : 'items';
    const any = d.slots.some((x) => x.picked);
    const head = h('div', { class: 'head' }, back, h('h1', { text: name }), h('span', { class: 'count', text: plural(d.slots.length, 'слот', 'слота', 'слотов') }), h('div', { class: 'grow' }),
      d.sets.length ? h('button', { class: 'btn', type: 'button', 'aria-expanded': S.setsOpen && tab === 'items' ? 'true' : 'false',
        onclick: () => { S.setsOpen = tab === 'items' ? !S.setsOpen : true; S.heroTab = 'items'; renderContent(); } }, `Наборы · ${d.sets.length}`) : null,
      any ? h('button', { class: 'btn ghost', type: 'button', onclick: async () => { if (picking) return; picking = true; try { await heroDone(await call(api.heroReset, S.hero), 'Герой сброшен. Нажми «Применить косметику».'); } finally { picking = false; } } }, 'Сбросить героя') : null);
    const tabBtn = (id, label) => h('button', { class: tab === id ? 'active' : '', type: 'button', onclick: () => { S.heroTab = id; renderContent(); } }, label);
    const seg = h('div', { class: 'seg' }, tabBtn('items', `Предметы · ${d.slots.length}`), tabBtn('fx', 'Эффекты'), tabBtn('icons', 'Иконки способностей'));

    const wornOf = (sl) => (sl.picked ? sl.options.find((o) => o.id === sl.picked.itemId) : null) || null;
    /** One slot: what is on it, and the button that opens its window (on the effects, from the «Эффекты» tab). */
    const slotRow = (sl, fx) => {
      const worn = wornOf(sl);
      const open = () => { S.heroSlot = sl.slot; S.pq = ''; S.pickerOpen = true; S.fxq = ''; S.pickerTab = fx ? 'fx' : worn && gemFor(worn) ? 'gems' : 'items'; renderContent(); };
      return h('div', { class: 'row' + (worn ? ' worn' : ''), title: worn ? worn.name : sl.slotLabel, onclick: open },
        h('div', { class: 'thumb' + (worn ? '' : ' dim') }, icon(sl.icon), worn ? pic('item', worn.id) : null),
        h('div', { class: 'rowtext' },
          h('div', { class: 'rowlabel' }, h('span', { text: sl.slotLabel }), fxTags(sl.picked, d.effects, worn)),
          h('div', { class: 'rowname', text: worn ? worn.name : 'Стандартный' })),
        fx ? null : h('span', { class: 'rowstate' + (worn ? ' on' : ''), text: worn ? 'Надето' : 'Не изменено' }),
        h('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.stopPropagation(); open(); } }, fx ? 'Эффекты' : 'Сменить'));
    };

    const parts = [];
    if (tab === 'icons') parts.push(...spellsPane());
    else if (!d.slots.length) parts.push(h('div', { class: 'empty' }, icon('category'), h('h2', { text: 'У героя нет слотов для замены' })));
    else if (tab === 'fx') {
      const worn = d.slots.filter(wornOf);
      if (!heroFxList(false).length && !heroFxList(true).length) parts.push(h('div', { class: 'empty' }, icon('auto_awesome'), h('h2', { text: 'Эффектов нет' })));
      else if (!worn.length) {
        parts.push(h('div', { class: 'empty' }, icon('auto_awesome'), h('h2', { text: 'Сначала надень предмет' }),
          h('p', { text: 'Эффекты добавляются к надетому предмету: выбери его во вкладке «Предметы», и он появится здесь.' }),
          h('button', { class: 'btn primary', type: 'button', onclick: () => { S.heroTab = 'items'; renderContent(); } }, 'К предметам')));
      } else {
        parts.push(h('p', { class: 'rownote', text: 'Эффекты добавляются к надетым предметам. Кнопка открывает окно предмета на вкладке эффектов.' }));
        parts.push(h('div', { class: 'rows' }, worn.map((sl) => slotRow(sl, true))));
      }
    } else {
      if (S.setsOpen && d.sets.length) {
        parts.push(h('div', { class: 'setlist' }, d.sets.map((set) => h('button', { class: 'setchip', type: 'button', title: set.pieces.map((p) => p.name + (p.fits ? '' : ` (${p.reason})`)).join('\n'),
          onclick: async () => { if (picking) return; picking = true; try { await heroDone(await call(api.heroSet, set.id), 'Набор выбран. Нажми «Применить косметику».'); } finally { picking = false; } } },
          h('b', { text: set.name }), h('span', { text: `${set.fit} из ${set.pieces.length} предметов` })))));
      }
      parts.push(h('div', { class: 'rows' }, d.slots.map((sl) => slotRow(sl, false))));
    }
    const top = c.scrollTop;
    c.replaceChildren(head, seg, h('div', { class: 'hero-split' }, previewStage().el, h('div', { class: 'hero-side' }, parts)));
    c.scrollTop = top;
    renderPicker();
    refreshPreview();
  }

  const closePicker = () => { S.pickerOpen = false; renderPicker(); };

  /** The window for one slot: effects, styles, search and the items to choose from. */
  function renderPicker() {
    const host = $('pickerHost');
    const d = S.heroData;
    const slot = d && S.pickerOpen ? d.slots.find((x) => x.slot === S.heroSlot) : null;
    if (!slot) { host.hidden = true; host.replaceChildren(); return; }
    const { fx, style } = slot.picked ? parsePick(slot.picked) : { fx: [...S.fx], style: 0 };
    const picked = slot.picked ? slot.picked.itemId : null;
    const pickedOpt = slot.options.find((o) => o.id === picked);
    const prevSearch = host.querySelector('input[type=search]');
    const keep = prevSearch && document.activeElement === prevSearch;
    // What goes on the worn item is in tabs of this window, next to the items: its effects, the hero's
    // Kinetic Gems, and the gems of an arcana that takes a gem colour.
    const gemOpt = pickedOpt ? gemFor(pickedOpt) : null;
    const tabs = [['items', 'Предметы', slot.options.length]];
    if (pickedOpt && heroFxList(false).length) tabs.push(['fx', 'Эффекты', heroFxList(false).length]);
    if (pickedOpt && heroFxList(true).length) tabs.push(['kin', 'Кинетики', heroFxList(true).length]);
    if (gemOpt) tabs.push(['gems', 'Самоцветы', gemColorsOf(gemOpt.def).length]);
    const tab = tabs.some(([id]) => id === S.pickerTab) ? S.pickerTab : 'items';
    const applyFx = (next) => heroFx(slot.slot, picked, buildFx(next, style));
    const pane = tab === 'gems' ? gemPane(gemOpt) : tab === 'fx' || tab === 'kin' ? fxPane({ fx, apply: applyFx, kinetic: tab === 'kin' }) : null;
    const prevBody = host.querySelector('.picker-body');
    const paneTop = pane && prevBody && prevBody.dataset.tab === tab ? prevBody.scrollTop : 0;

    const grid = h('div', { class: 'grid' });
    const paintGrid = () => {
      const q = (S.pq || '').trim().toLowerCase();
      const found = slot.options.filter((o) => !q || o.name.toLowerCase().includes(q));
      // the worn item goes first, the rest keep their order
      const opts = [...found.filter((o) => o.id === picked), ...found.filter((o) => o.id !== picked)];
      grid.replaceChildren(...(opts.length ? opts.map((o) => {
        const on = picked === o.id;
        const card = h('button', { class: 'card' + (on ? ' picked' : ''), type: 'button', title: o.note ? `${o.name}\n${o.note.text}` : o.name,
          onclick: async () => {
            closePicker(); // choosing is the end of the errand; effects can be changed from the worn tile
            await heroPick(slot.slot, on ? null : o.id, buildFx([], 0));
          } },
          pic('item', o.id),
          on ? h('span', { class: 'badge', text: 'Надето' }) : null,
          o.note ? h('span', { class: 'warnmark ' + o.note.status, title: o.note.text }, icon(o.note.status === 'broken' ? 'error' : 'warning')) : null,
          on ? fxTags(slot.picked, d.effects, o) : null,
          h('div', { class: 'name', text: o.name }), h('div', { class: 'sub', text: slot.slotLabel }));
        return card;
      }) : [h('div', { class: 'empty' }, icon('search_off'), h('h2', { text: 'Ничего не найдено' }))]));
      fillPics([grid]);
    };

    const input = h('input', { type: 'search', placeholder: 'Поиск предмета…', value: S.pq || '', autocomplete: 'off' });
    input.addEventListener('input', (e) => { S.pq = e.target.value; paintGrid(); });
    const rows = [];
    if (pickedOpt && pickedOpt.styles && pickedOpt.styles.length > 1) {
      rows.push(h('div', { class: 'fxrow' }, h('span', { class: 'fxlabel', text: 'Стиль' }),
        ...pickedOpt.styles.map((_, i) => h('button', {
          class: 'pillbtn' + (style === i ? ' active' : ''), type: 'button',
          onclick: () => heroPick(slot.slot, picked, buildFx(fx, i)),
        }, `Стиль ${i + 1}`))));
    }
    // The ⚠ on a card says little by itself: spell it out here, in the window, once per slot.
    const noted = slot.options.filter((o) => o.note);
    const texts = [...new Set(noted.map((o) => o.note.text))];
    const worst = noted.some((o) => o.note.status === 'broken') ? 'broken' : 'issues';
    // folded by default so it does not get in the way; a click on its line opens it (the choice is kept)
    const notice = noted.length ? h('div', { class: 'notice ' + worst + (S.noticeOpen ? '' : ' folded') },
      icon(worst === 'broken' ? 'error' : 'warning'),
      h('div', { class: 'notice-body' },
        h('button', { class: 'notice-head', type: 'button', 'aria-expanded': S.noticeOpen ? 'true' : 'false',
          onclick: (e) => { S.noticeOpen = !S.noticeOpen; const box = e.currentTarget.closest('.notice'); box.classList.toggle('folded', !S.noticeOpen); e.currentTarget.setAttribute('aria-expanded', S.noticeOpen ? 'true' : 'false'); } },
          h('b', { text: 'Значок ⚠ на предмете' }), icon('expand_more')),
        h('div', { class: 'notice-more' },
          h('p', { text: texts.length === 1 ? texts[0] : 'Такие предметы работают с оговорками: наведи курсор на значок, чтобы увидеть, что именно не так с конкретным предметом.' }),
          h('p', { class: 'dim', text: 'Предмет всё равно можно надеть. Если он выглядит не так, как нужно, его можно снять кнопкой «Снять».' })))) : null;
    const tabBtn = ([id, label, n]) => h('button', { class: tab === id ? 'active' : '', type: 'button',
      onclick: () => { S.pickerTab = id; S.fxq = ''; renderPicker(); } }, label, h('span', { class: 'tabcount', text: String(n) }));
    const win = h('div', { class: 'picker', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'picker-head' },
        icon(slot.icon), h('h2', { text: `${S.heroName || S.hero}: ${slot.slotLabel}` }),
        tabs.length > 1 ? h('div', { class: 'seg' }, tabs.map(tabBtn)) : h('span', { class: 'count', text: plural(slot.options.length, 'предмет', 'предмета', 'предметов') }),
        h('div', { class: 'grow' }),
        pane ? pane.search || null : h('label', { class: 'search' }, icon('search'), input),
        picked ? h('button', { class: 'btn sm', type: 'button', onclick: () => { closePicker(); heroPick(slot.slot, null, []); } }, 'Снять') : null,
        h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Закрыть', onclick: closePicker }, icon('close'))),
      pane ? h('div', { class: 'picker-fx' }, pane.row) : h('div', { class: 'picker-fx' }, notice, rows),
      pane ? h('div', { class: 'picker-body gems', 'data-tab': tab }, pane.body) : h('div', { class: 'picker-body', 'data-tab': tab }, grid));
    host.replaceChildren(win);
    if (pane) win.querySelector('.picker-body').scrollTop = paneTop;
    host.hidden = false;
    host.onclick = (e) => { if (e.target === host) closePicker(); };
    if (!pane) paintGrid();
    if (keep) { const i = host.querySelector('input[type=search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }

  let picking = false;
  async function pick(slot, itemId) {
    if (picking) return;
    picking = true;
    try {
      const r = await call(api.pick, slot, itemId);
      if (!r) return;
      applyState(r.state);
      toast(itemId ? 'Выбрано. Нажми «Применить косметику».' : 'Сброшено. Нажми «Применить косметику».');
      renderRail(); renderContent();
    } finally { picking = false; }
  }

  /** A courier (or the default, null) with its effects, in one go. Answers false when it did not go in. */
  async function pickFx(slot, itemId, ids) {
    if (picking) return false;
    picking = true;
    try {
      const r = await call(api.pickFx, slot, itemId, ids);
      if (!r) return false;
      applyState(r.state);
      S.eq = null;
      if (r.failed && r.failed.length) toast('Не вошло в сборку: ' + r.failed[0], true); else toast('Выбрано. Нажми «Применить косметику».');
      renderRail(); renderContent();
      return true;
    } finally { picking = false; }
  }

  async function loadSlots() {
    S.loading = true; renderRail(); renderContent();
    const r = await call(api.slots);
    S.loading = false;
    S.effects = r ? (r.effects || []) : [];
    S.slots = r ? r.slots.sort((a, b) => meta(a.slot).order - meta(b.slot).order || a.slot.localeCompare(b.slot)) : [];
    if (!S.slots.some((s) => s.slot === S.current)) S.current = S.slots.length ? S.slots[0].slot : null;
    renderRail(); renderContent();
    loadEmblems();
  }

  async function chooseGame() {
    const r = await call(api.chooseGame);
    if (!r || !r.changed) return;
    await start();
  }

  async function start() {
    const r = await call(api.init);
    if (!r) return;
    S.connected = r.connected; S.slots = null; S.emblems = null; S.current = null; S.heroes = null; S.hero = null; S.view = 'heroes'; // «Предметы» is the screen the app opens on
    S.tool = vrfOf(r.tools);
    applyState(r.state, r.gameRunning);
    renderRail(); renderContent();
    S.eq = null; S.spells = null;
    if (S.connected) await loadSlots();
    if (S.connected && !r.toolsPromptSeen && !S.promptShown) { S.promptShown = true; await offerTool(r.tools); }
  }


  // ---------- «Инвентарь»: everything worn now, in one window ----------
  // The tab sits before «Настройки». It is built here (index.html has no markup for it).
  const wornCount = () => Object.keys(S.picks).length + Object.keys(S.items).length;
  function ensureEqTab() {
    if ($('tabEq')) return;
    const set = $('tabSet');
    const tab = h('button', { class: 'tab', id: 'tabEq', type: 'button' });
    set.parentNode.insertBefore(tab, set);
  }
  function renderEqTab() {
    const n = wornCount();
    $('tabEq').textContent = n ? `Инвентарь · ${n}` : 'Инвентарь';
  }

  async function loadEquipped(quiet) {
    if (!S.connected) { S.eq = null; renderContent(); return; }
    if (!quiet) { S.eqLoading = true; renderContent(); }
    const [r, pr] = await Promise.all([call(api.equipped), call(api.presets)]);
    S.presets = pr ? pr.presets : (S.presets || []);
    S.eqLoading = false;
    S.eq = r ? { free: r.free, heroItems: r.heroItems, abilityPicks: r.abilityPicks || [], effects: r.effects || [] } : { free: [], heroItems: [], abilityPicks: [], effects: [] };
    if (S.tab === 'eq') renderContent();
  }

  /** Take one worn item off, from this window. */
  async function unequip(kind, slot) {
    if (picking) return;
    picking = true;
    try {
      const r = kind === 'free' ? await call(api.pick, slot, null) : await call(api.heroPick, slot, null, []);
      if (!r) return;
      applyState(r.state);
      S.heroes = null; S.hero = null; S.heroData = null; // the hero grid is read again when it is opened
      toast('Снято. Нажми «Применить косметику».');
      renderRail();
      await loadEquipped(true);
    } finally { picking = false; }
  }

  /** «Снять все»: the first click asks again on the button itself, the second one does it. */
  let clearArmed = null;
  async function clearAll(btn) {
    if (picking) return;
    if (!clearArmed) {
      btn.lastChild.textContent = 'Точно снять всё?';
      btn.classList.add('danger');
      clearArmed = setTimeout(() => { clearArmed = null; if (btn.isConnected) { btn.lastChild.textContent = 'Снять все'; btn.classList.remove('danger'); } }, 4000);
      return;
    }
    clearTimeout(clearArmed); clearArmed = null;
    picking = true;
    try {
      const r = await call(api.clearAll);
      if (!r) return;
      applyState(r.state);
      S.heroes = null; S.hero = null; S.heroData = null;
      toast('Всё снято. Нажми «Применить косметику».');
      renderRail();
      await loadEquipped(true);
    } finally { picking = false; }
  }

  // ---------- presets: what is worn, kept under a name ----------
  const presetWhen = (ms) => (ms ? new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const presetSummary = (c) => [c.free ? `косметика ${c.free}` : '', c.items ? `предметов героев ${c.items}` : '', c.icons ? `иконок ${c.icons}` : ''].filter(Boolean).join(' · ');

  async function savePreset(name) {
    if (picking) return;
    if (!String(name).trim()) { toast('Введи название пресета', true); return; }
    picking = true;
    try {
      const r = await call(api.presetSave, name);
      if (!r) return;
      S.presets = r.presets;
      toast('Пресет сохранён');
      renderContent();
    } finally { picking = false; }
  }

  async function loadPreset(id) {
    if (picking) return;
    picking = true;
    try {
      const r = await call(api.presetLoad, id);
      if (!r) return;
      S.presets = r.presets;
      applyState(r.state);
      S.heroes = null; S.hero = null; S.heroData = null;
      toast('Пресет надет. Нажми «Применить косметику».');
      renderRail();
      await loadEquipped(true);
    } finally { picking = false; }
  }

  /** Deleting asks again on the button itself, like «Снять все». */
  let presetDelArmed = null;
  async function deletePreset(btn, id) {
    if (picking) return;
    if (!presetDelArmed || presetDelArmed.id !== id) {
      if (presetDelArmed) clearTimeout(presetDelArmed.timer);
      btn.classList.add('danger');
      btn.title = 'Нажми ещё раз, чтобы удалить';
      presetDelArmed = { id, timer: setTimeout(() => { presetDelArmed = null; if (btn.isConnected) { btn.classList.remove('danger'); btn.title = 'Удалить'; } }, 4000) };
      return;
    }
    clearTimeout(presetDelArmed.timer); presetDelArmed = null;
    picking = true;
    try {
      const r = await call(api.presetDelete, id);
      if (!r) return;
      S.presets = r.presets;
      renderContent();
    } finally { picking = false; }
  }

  /* The presets, in one strip above the worn things: a chip for each, and the name to keep what is worn now under.
   * The strip folds to the names alone. */
  S.presetsOpen = true;
  function presetsBar(anything) {
    const list = S.presets || [];
    const toggle = h('button', { class: 'presettoggle' + (S.presetsOpen ? '' : ' shut'), type: 'button', 'aria-expanded': S.presetsOpen ? 'true' : 'false',
      'aria-label': S.presetsOpen ? 'Свернуть пресеты' : 'Развернуть пресеты', onclick: () => { S.presetsOpen = !S.presetsOpen; renderContent(); } },
      icon('expand_more'), 'Пресеты', h('span', { text: list.length ? String(list.length) : '' }));
    if (!S.presetsOpen) return h('div', { class: 'presetbar' }, toggle, h('span', { class: 'presetnames', text: list.map((p) => p.name).join(' · ') }));
    const input = h('input', { class: 'sinput', type: 'text', maxlength: '40', placeholder: 'Название пресета', 'aria-label': 'Название пресета', spellcheck: 'false' });
    const doSave = () => savePreset(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: doSave }, 'Сохранить надетое');
    saveBtn.disabled = !anything;
    if (!anything) saveBtn.title = 'Сейчас ничего не надето';
    const chips = list.map((p) => {
      const c = p.counts || {};
      return h('div', { class: 'presetchip' + (p.auto ? ' auto' : ''), title: [presetSummary(c), presetWhen(p.saved)].filter(Boolean).join(' · ') },
        h('b', { text: p.name }), h('span', { text: String((c.free || 0) + (c.items || 0) + (c.icons || 0)) }),
        h('button', { class: 'btn xs', type: 'button', onclick: () => loadPreset(p.id) }, 'Надеть'),
        h('button', { class: 'del', type: 'button', 'aria-label': 'Удалить пресет', title: 'Удалить', onclick: (e) => deletePreset(e.currentTarget, p.id) }, icon('close')));
    });
    return h('div', { class: 'presetbar' }, toggle,
      h('div', { class: 'presetchips' }, chips.length ? chips
        : h('span', { class: 'presetnames', text: 'Сохрани надетое под именем: потом его можно вернуть одним нажатием, даже после «Снять все».' })),
      input, saveBtn);
  }

  /** One worn thing: its slot (with the effects and the gem on it), its name, and the cross that takes it off. */
  function wornItem(kind, o, label) {
    return h('div', { class: 'itm', title: o.name || '' },
      h('div', { class: 'thumb lg' }, icon(label.icon), pic('item', o.itemId)),
      h('div', { class: 'rowtext' },
        h('div', { class: 'rowlabel' }, h('span', { text: label.text }),
          kind === 'hero' ? fxTags({ effects: o.effects || '' }, S.eq.effects, o.styled ? { styles: [0, 1] } : null) : null,
          o.gem ? h('span', { class: 'gemline', title: 'Цвет гема' }, h('i', { class: 'gemdot', style: `background:${toHex(o.gem)}` }), toHex(o.gem).toUpperCase()) : null),
        h('div', { class: 'itmname', text: o.name || `Предмет ${o.itemId}` })),
      h('button', { class: 'del', type: 'button', 'aria-label': 'Снять', title: 'Снять', onclick: () => unequip(kind, o.slot) }, icon('close')));
  }

  function renderEquipped(c) {
    c.scrollTop = 0;
    if (!S.connected) {
      c.replaceChildren(h('div', { class: 'empty' }, icon('folder_off'), h('h2', { text: 'Dota 2 не найдена' }),
        h('p', { text: 'Укажи папку игры в «Настройках» или здесь.' }),
        h('button', { class: 'btn primary', type: 'button', onclick: chooseGame, text: 'Выбрать папку' })));
      return;
    }
    if (S.eqLoading || !S.eq) {
      c.replaceChildren(h('div', { class: 'empty' }, icon('hourglass_top'), h('h2', { text: 'Собираю список надетого…' })));
      if (!S.eq && !S.eqLoading) loadEquipped();
      return;
    }
    const { free, heroItems, abilityPicks } = S.eq;
    // The ability icons are not listed here: they are on each hero's own screen. They still count as worn for
    // «Снять все» and for a preset.
    const total = free.length + heroItems.length;
    const anything = total + abilityPicks.length;
    const kids = [h('div', { class: 'head' }, h('h1', { text: 'Инвентарь' }), h('span', { class: 'count', text: total ? plural(total, 'предмет', 'предмета', 'предметов') : '' }), h('div', { class: 'grow' }),
      anything ? h('button', { class: 'btn ghost', type: 'button', onclick: (e) => clearAll(e.currentTarget) }, h('span', { text: 'Снять все' })) : null)];
    kids.push(presetsBar(anything));
    if (!anything) {
      kids.push(h('div', { class: 'empty' }, icon('checkroom'), h('h2', { text: 'Пока ничего не надето' }),
        h('p', { text: 'Выбери предмет в разделе «Косметика» или у героя: он появится здесь, и его можно будет снять одной кнопкой.' }),
        h('button', { class: 'btn primary', type: 'button', onclick: () => setTab('cos'), text: 'К косметике' })));
      c.replaceChildren(...kids);
      return;
    }
    const section = (avatar, title, sub, open, items) => h('div', { class: 'invrow' },
      h('div', { class: 'invhead' }, avatar, h('div', {},
        h('div', { class: 'invtitle', text: title }), h('div', { class: 'invsub', text: sub }),
        open ? h('button', { class: 'invlink', type: 'button', onclick: open }, 'Открыть героя →') : null)),
      h('div', { class: 'invgrid' }, items));
    if (free.length) {
      kids.push(section(h('div', { class: 'avatar', text: '✦' }), 'Косметика', plural(free.length, 'предмет', 'предмета', 'предметов'), null,
        free.map((o) => { const m = meta(o.slot); return wornItem('free', o, { icon: m.icon, text: m.label }); })));
    }
    const byHero = new Map();
    for (const o of heroItems) { if (!byHero.has(o.hero)) byHero.set(o.hero, []); byHero.get(o.hero).push(o); }
    for (const [hero, list] of byHero) {
      const name = list[0].heroName;
      const withFx = list.filter((o) => parsePick({ effects: o.effects || '' }).fx.length).length;
      kids.push(section(h('div', { class: 'avatar' }, String(name || hero).slice(0, 1).toUpperCase(), pic('hero', hero)), name,
        plural(list.length, 'предмет', 'предмета', 'предметов') + (withFx ? `, ${withFx} с эффектом` : ''),
        () => { S.view = 'heroes'; setTab('cos'); openHero(hero, name); },
        list.map((o) => wornItem('hero', o, { icon: o.icon, text: o.slotLabel }))));
    }
    if (!total) kids.push(h('p', { class: 'invnote', text: `Из надетого сейчас только иконки способностей (${abilityPicks.length}). Они меняются на экране героя, во вкладке «Иконки способностей».` }));
    c.replaceChildren(...kids);
    fillPics([c]);
  }

  // ---------- Settings ----------
  const mb = (n) => (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' МБ';
  const vrfOf = (tools) => (tools || []).find((x) => x.name === 'vrf') || null;

  const TABS = { cos: 'tabCos', eq: 'tabEq', set: 'tabSet' };
  function setTab(tab) {
    if (S.tab === tab) return;
    S.tab = tab; if (S.pickerOpen) closePicker();
    if (tab === 'eq') S.eq = null; // read again each time the window opens
    for (const [name, id] of Object.entries(TABS)) $(id).classList.toggle('active', tab === name);
    $('search').closest('label').style.visibility = tab === 'cos' ? '' : 'hidden';
    renderRail(); renderContent();
  }

  async function reloadSettings() {
    const r = await call(api.settings);
    if (r) { S.set = r; S.tool = vrfOf(r.tools); }
    if (S.tab === 'set') renderContent();
  }

  function block(title, ...kids) { return h('div', { class: 'sblock' }, h('h3', { text: title }), kids); }
  const row = (...kids) => h('div', { class: 'srow' }, kids);
  const link = (text, url) => h('a', { class: 'slink', onclick: () => call(api.openExternal, url), text });

  /* Updates. The main process keeps one state ({ mode, phase, latest, percent, … }) and pushes it on every change.
   * A copy put in by the installer downloads a newer release by itself and offers «Перезапустить и обновить»;
   * any other copy gets a link to the release page. The title bar button follows the state; the block in
   * Settings is repainted in place (not the whole page, so the colour sliders keep working while it downloads). */
  function showUpdate(u) {
    S.update = u || null;
    const b = $('updBtn');
    if (b) {
      const p = u && u.phase;
      const on = !!(u && u.available);
      b.hidden = !on;
      if (on) {
        $('updText').textContent = p === 'ready' ? 'Перезапустить и обновить' : p === 'downloading' ? `Скачиваю ${u.percent || 0}%` : `Обновление ${u.latest}`;
        b.disabled = p === 'downloading';
        b.title = p === 'ready' ? `Версия ${u.latest} скачана. Нажми, чтобы перезапустить приложение и обновиться`
          : p === 'downloading' ? `Скачиваю версию ${u.latest}…` : `Доступна версия ${u.latest} (у тебя ${u.current}). Открыть страницу загрузки`;
      }
    }
    const old = document.getElementById('updBlock');
    if (old) old.replaceWith(updateBlock(S.appVersion));
  }
  async function checkUpdate(quiet) {
    try {
      const r = await api.checkUpdate();
      if (!r || !r.ok) { if (!quiet) toast((r && r.error) || 'Не удалось проверить обновления', true); return null; }
      showUpdate(r.update);
      return r.update;
    } catch { return null; }
  }
  async function installUpdate() {
    const r = await call(api.installUpdate);
    if (r && !r.started) toast('Обновление ещё не скачано', true);
  }
  api.onUpdate(showUpdate);
  $('updBtn').addEventListener('click', () => {
    const u = S.update;
    if (!u) return;
    if (u.phase === 'ready') installUpdate(); else if (u.mode === 'manual') call(api.openExternal, u.url);
  });

  function updateBlock(version) {
    const u = S.update || {};
    const busy = u.phase === 'checking' || u.phase === 'downloading';
    const newer = u.phase === 'available' || u.phase === 'ready';
    const text = {
      checking: 'Проверяю…',
      downloading: `Скачиваю версию ${u.latest}: ${u.percent || 0}%`,
      ready: `Версия ${u.latest} скачана`,
      available: `Доступна версия ${u.latest}`,
      none: u.latest ? 'У тебя последняя версия' : 'Релизов пока нет',
      error: 'Не удалось проверить обновления',
    }[u.phase] || 'Ещё не проверял';
    const tone = u.phase === 'error' ? ' bad' : newer ? ' new' : u.phase === 'none' && u.latest ? ' ok' : '';
    const act = u.phase === 'ready' ? h('button', { class: 'btn primary', type: 'button', onclick: installUpdate }, icon('restart_alt'), 'Перезапустить и обновить')
      : u.phase === 'available' && u.mode === 'manual' ? h('button', { class: 'btn primary', type: 'button', onclick: () => call(api.openExternal, u.url) }, icon('open_in_new'), 'Скачать') : null;
    const check = h('button', { class: 'btn' + (act ? '' : ' primary'), type: 'button', disabled: busy || u.phase === 'ready', onclick: () => checkUpdate(false) }, icon('refresh'), 'Проверить');
    const el = h('div', { class: 'sblock', id: 'updBlock' },
      h('i', { class: 'updglow' }),
      h('h3', { text: 'Обновления' }),
      h('div', { class: 'upd' },
        h('div', { class: 'updring' + (busy ? ' busy' : '') }, icon(busy ? 'progress_activity' : u.phase === 'error' ? 'priority_high' : newer ? 'arrow_downward' : 'check')),
        h('div', { class: 'grow' },
          h('div', { class: 'updk', text: 'ВЕРСИЯ' }), h('div', { class: 'updver', text: version || '—' }), h('div', { class: 'updstate' + tone, text })),
        check, act),
      u.phase === 'downloading' ? h('div', { class: 'bar' }, h('i', { style: `width: ${u.percent || 0}%` })) : null,
      u.phase === 'error' && u.error ? h('p', { class: 'shint', text: u.error }) : null,
      u.available && u.notes ? h('div', { class: 'upd-notes', text: u.notes }) : null,
      u.mode === 'manual' ? h('div', { class: 'infobox' }, icon('info'), h('span', { text: 'Эта копия сама не обновляется: автообновление работает у версии, установленной установщиком (Setup). Здесь приложение только сообщит о новой версии со ссылкой на загрузку.' }))
        : u.mode === 'auto' ? h('div', { class: 'infobox' }, icon('info'), h('span', { text: 'Новая версия скачивается сама. Если не нажимать «Перезапустить и обновить», она поставится, когда ты закроешь приложение.' })) : null);
    return el;
  }

  /* Colours of the interface: three sliders (the ready palettes are on the logo). Dragging a slider repaints the app
   * live and must not redraw this block (that would drop the slider), so the sliders are updated by hand. The two
   * squares in the heading are the colours now: they are drawn from the theme's own variables. */
  function themeBlock() {
    const T = window.Theme;
    const sliders = {};
    const track = () => {
      const t = T.get();
      const hues = Array.from({ length: 13 }, (_, i) => `hsl(${i * 30} 70% 55%)`).join(',');
      sliders.hue.style.setProperty('--track', `linear-gradient(90deg, ${hues})`);
      sliders.accent.style.setProperty('--track', `linear-gradient(90deg, ${hues})`);
      sliders.sat.style.setProperty('--track', `linear-gradient(90deg, hsl(${t.hue} 6% 20%), hsl(${t.hue} 80% 50%))`);
    };
    const slide = (key, label, min, max, fmt) => {
      const num = h('span', { class: 'num' });
      const input = h('input', { type: 'range', min, max, step: 1, value: T.get()[key], 'aria-label': label });
      sliders[key] = input;
      const sync = () => { num.textContent = fmt(+input.value); };
      input.addEventListener('input', () => { T.set({ [key]: +input.value }); sync(); track(); });
      sync();
      return h('div', { class: 'slide' }, h('span', { class: 'label', text: label }), input, num);
    };
    const follow = () => {
      const t = T.get();
      for (const k of ['hue', 'sat', 'accent']) { sliders[k].value = t[k]; sliders[k].dispatchEvent(new Event('input')); }
    };
    const box = h('div', { class: 'sblock' },
      h('h3', {}, 'Оформление', h('span', { class: 'swatches' }, h('i'), h('i'))),
      h('p', { class: 'shint', text: 'Готовые цвета меняются по клику на логотип слева вверху. Ползунки настраивают любой свой.' }),
      h('div', {},
        slide('hue', 'Цвет фона', 0, 360, (v) => v + '°'),
        slide('sat', 'Насыщенность фона', 0, 90, (v) => v + '%'),
        slide('accent', 'Цвет акцента', 0, 360, (v) => v + '°')),
      row(h('button', { class: 'btn sm', type: 'button', onclick: () => {
        T.reset(); follow();
        T.reset(); // the sliders, following, saved the default as a choice: it is no choice
      } }, 'Сбросить цвета')));
    track();
    // the logo changes the colours too: when this block is on screen, the sliders follow
    S.themeSync = () => { if (sliders.hue.isConnected) follow(); };
    return box;
  }

  async function renderSettings(c) {
    if (!S.set) { c.replaceChildren(h('div', { class: 'empty' }, icon('hourglass_top'), h('h2', { text: 'Загружаю настройки…' }))); await reloadSettings(); return; }
    const m = S.set, vrf = S.tool;
    S.appVersion = m.version;
    const field = (label, ...kids) => h('div', { class: 'field' }, h('span', { text: label }), kids);
    const titled = (title, sub, ...kids) => row(h('div', { class: 'grow' }, h('div', { class: 'strong', text: title }), sub ? h('div', { class: 'label', text: sub }) : null), ...kids);

    const pathBlock = block('Путь к Dota 2',
      field('Папка игры', h('div', { class: 'pathbox' }, h('span', { text: m.gamePath || 'не найден' }), h('i', { class: 'dot ' + (m.gameValid ? 'ok' : 'bad') }))),
      field('Папка модов', h('div', { class: 'pathbox' }, h('span', { text: m.modFolder ? m.gamePath.replace(/[\\/]+$/, '') + '\\' + m.modFolder : '—' }))),
      row(h('button', { class: 'btn sm', type: 'button', text: 'Найти автоматически', onclick: async () => {
        const r = await call(api.detectGame);
        if (r) { if (r.found) { toast('Dota 2 найдена'); await start(); } else toast('Не нашёл автоматически: укажи вручную', true); }
        await reloadSettings();
      } }), h('button', { class: 'btn sm', type: 'button', text: 'Указать вручную', onclick: async () => { await chooseGame(); await reloadSettings(); } })));

    const extra = [];
    if (vrf && vrf.available) {
      const ready = vrf.ready;
      extra.push(
        titled('Картинки предметов', `${ready ? 'Установлен' : 'Не скачан'} · ${mb(ready ? vrf.installedBytes : vrf.downloadBytes)}`,
          ready ? h('button', { class: 'btn sm', type: 'button', text: 'Удалить', onclick: removeTool })
            : h('button', { class: 'btn sm primary', type: 'button', disabled: S.toolBusy, onclick: installTool }, icon('download'), 'Скачать')),
        h('div', { class: 'bar', id: 'toolBar', hidden: !S.toolBusy }, h('i')),
        h('p', { class: 'shint', text: 'Большинство иконок предметов приложение читает из самой игры без скачивания. Эта программа (Source 2 Viewer, MIT) нужна для тех, что Valve хранит сжатыми, и для портретов героев. Удалить можно в любой момент.' }),
        h('div', { class: 'sdiv' }));
    }
    const extraBlock = block('Дополнительный контент', ...extra,
      titled('Кэш', `Картинки из игры · ${mb(m.iconCacheBytes)}`,
        h('button', { class: 'btn sm', type: 'button', text: 'Очистить', onclick: async () => {
          const r = await call(api.clearCache); if (!r) return;
          S.pics.clear(); S.why.clear(); toast('Кэш очищен'); await reloadSettings();
        } })),
      h('div', { class: 'sdiv' }),
      field('Прокси для загрузки', row(
        h('input', { class: 'sinput', id: 'proxyIn', placeholder: 'http://127.0.0.1:8080 (пусто = напрямую)', value: m.proxy, spellcheck: 'false' }),
        h('button', { class: 'btn sm', type: 'button', text: 'Сохранить', onclick: async () => {
          const r = await call(api.setSetting, 'downloadProxy', $('proxyIn').value);
          if (r) { toast($('proxyIn').value.trim() ? 'Прокси сохранён' : 'Прокси отключён'); await reloadSettings(); }
        } }))),
      row(h('button', { class: 'btn sm', type: 'button', onclick: () => call(api.openDataFolder) }, icon('folder_open'), 'Папка данных приложения')));

    const removeBlock = h('div', { class: 'sblock danger' }, h('h3', { text: 'Удаление модов' }),
      row(h('span', { class: 'label grow', text: 'Все файлы, которые менеджер положил в игру (pak99_dir.vpk, патч gameinfo), будут удалены. Чужие файлы не трогаются, надетое сохранится в «Автосохранении».' }),
        h('button', { class: 'btn sm redline', type: 'button', disabled: !m.gameValid, onclick: (e) => removeMods(e.currentTarget) }, h('span', { text: 'Удалить модификации' }))));

    const top = c.scrollTop;
    c.replaceChildren(h('div', { class: 'head' }, h('h1', { text: 'Настройки' })),
      h('div', { class: 'setgrid' },
        h('div', { class: 'setcol' }, themeBlock(), updateBlock(m.version)),
        h('div', { class: 'setcol' }, pathBlock, extraBlock, removeBlock)));
    c.scrollTop = top;
  }

  function paintToolProgress(evt) {
    const bar = document.getElementById('toolBar');
    const fill = bar && bar.firstChild;
    const st = $('statusText');
    if (evt.type === 'download') {
      const pct = evt.total ? Math.min(100, Math.round(evt.loaded / evt.total * 100)) : 0;
      if (bar) { bar.hidden = false; fill.style.width = pct + '%'; }
      st.textContent = `Скачиваю доп. контент: ${mb(evt.loaded)} / ${mb(evt.total)}`;
    } else if (evt.type === 'stage') {
      st.textContent = evt.stage === 'unpack' ? 'Распаковываю доп. контент…' : 'Скачиваю доп. контент…';
    } else { renderBar(); }
  }
  api.onToolProgress(paintToolProgress);

  async function installTool() {
    if (S.toolBusy) return;
    S.toolBusy = true;
    if (S.tab === 'set') renderContent();
    const r = await call(api.toolInstall);
    S.toolBusy = false;
    renderBar();
    if (r) {
      S.tool = vrfOf(r.tools); S.pics.clear(); S.why.clear();
      toast('Готово: картинки теперь берутся из игры');
    }
    await reloadSettings();
    if (S.tab === 'cos') renderContent();
  }

  async function removeTool() {
    const r = await call(api.toolRemove);
    if (!r) return;
    S.pics.clear(); S.why.clear(); toast('Инструмент удалён');
    await reloadSettings();
  }

  /** The one question about the extra content, asked once on first launch (Settings has the same button). */
  function askTool() {
    return new Promise((resolve) => {
      const dlg = $('toolDlg');
      const done = (v) => { dlg.hidden = true; window.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      window.addEventListener('keydown', onKey);
      $('toolYes').onclick = () => done(true);
      $('toolNo').onclick = () => done(false);
      dlg.onclick = (e) => { if (e.target === dlg) done(false); };
      dlg.hidden = false;
      $('toolYes').focus();
    });
  }

  async function offerTool(tools) {
    const vrf = vrfOf(tools);
    S.tool = vrf;
    if (!vrf || !vrf.available || vrf.ready) return;
    const yes = await askTool();
    await call(api.setSetting, 'toolsPromptSeen', true);
    if (yes) await installTool();
  }

  $('folderBtn').addEventListener('click', async () => {
    const r = await call(api.openModsFolder);
    if (r && !r.exists) toast('Папки модов ещё нет: открыл папку игры. Она появится после «Применить косметику».');
  });

  /** «Удалить модификации»: the first click asks again on the button itself, the second one does it. */
  let removeArmed = null;
  async function removeMods(btn) {
    if (picking) return;
    if (!removeArmed) {
      btn.lastChild.textContent = 'Точно удалить всё?';
      btn.classList.add('danger');
      removeArmed = setTimeout(() => { removeArmed = null; if (btn.isConnected) { btn.lastChild.textContent = 'Удалить модификации'; btn.classList.remove('danger'); } }, 4000);
      return;
    }
    clearTimeout(removeArmed); removeArmed = null;
    picking = true;
    try {
      const r = await call(api.removeMods);
      if (!r) return;
      S.presets = r.presets || S.presets;
      applyState(r.state, r.gameRunning);
      S.heroes = null; S.hero = null; S.heroData = null; S.eq = null;
      renderRail();
      const left = r.left && r.left.length ? ` Чужие файлы не тронуты: ${r.left.join(', ')}.` : '';
      toast((r.removed && r.removed.length ? 'Модификации удалены: игра вернулась к стандартным файлам.' : 'Удалять было нечего: наших файлов в игре нет.') + left);
      renderContent();
    } finally { picking = false; }
  }

  $('applyBtn').addEventListener('click', async () => {
    if (S.applying || !S.pending) return;
    S.applying = true; renderBar();
    try {
      const r = await call(api.apply);
      if (!r) return;
      applyState(r.state, r.gameRunning);
      if (r.failed && r.failed.length) toast('Не вошло в сборку: ' + r.failed[0], true);
      else toast(r.deployed ? 'Косметика применена. Можно играть!' : 'Всё снято: игра вернулась к стандартным файлам.');
    } finally { S.applying = false; renderBar(); }
  });
  $('playBtn').addEventListener('click', async () => {
    if (S.pending) toast('Есть неприменённые изменения: запускаю без них. Нажми «Применить косметику».', true);
    const r = await call(api.play);
    if (r && !S.pending) toast('Запускаю Dota 2 через Steam…');
  });
  $('search').addEventListener('input', (e) => { S.query = e.target.value; if (S.tab === 'cos' && S.connected) renderContent(); });
  $('wmin').addEventListener('click', () => api.win.min());
  $('wmax').addEventListener('click', () => api.win.max());
  $('wclose').addEventListener('click', () => api.win.close());
  window.addEventListener('focus', async () => { if (!S.connected) return; const r = await api.state(); if (r && r.ok) applyState(r.state, r.gameRunning); });

  // A click on the logo moves to the next ready palette (the sliders in Settings make any other one).
  const brand = document.querySelector('.brand');
  if (brand && window.Theme) {
    brand.classList.add('clickable');
    brand.setAttribute('role', 'button'); brand.setAttribute('tabindex', '0'); brand.title = 'Сменить оформление';
    const nextTheme = () => {
      const T = window.Theme;
      const i = T.PRESETS.findIndex((x) => T.preset(T.get())?.id === x.id);
      const p = T.PRESETS[(i + 1) % T.PRESETS.length];
      T.set(p);
      if (S.themeSync) S.themeSync();
      brand.classList.remove('spin'); void brand.offsetWidth; brand.classList.add('spin');
      toast(`Оформление: ${p.name}`);
    };
    brand.addEventListener('click', nextTheme);
    brand.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nextTheme(); } });
  }

  ensureEqTab();
  $('tabCos').addEventListener('click', () => setTab('cos'));
  $('tabEq').addEventListener('click', () => setTab('eq'));
  $('tabSet').addEventListener('click', () => setTab('set'));

  start();
  checkUpdate(true); // once, quietly: the title bar shows a button only when a newer release exists
})();
