/* UI colours. A theme is three numbers: the hue of the dark surfaces, how strong their colour is, and the
 * hue of the accent. Everything on screen is derived from them and written to CSS variables, so the
 * sliders in Settings repaint the whole interface live. The choice is kept in localStorage.
 *
 * The lightness of every surface is fixed (a near-black page, panels a step above it, raised controls a
 * step above those); the theme only turns their hue and saturation. The first preset gives the colours
 * of the design: page #0D0F13, panel #15181E, raised #1E232B, lines #262B34, accent #4DA3FF. */
(() => {
  const KEY = 'ui-theme';
  const PRESETS = [
    { id: 'graphite', name: 'Графит',   hue: 220, sat: 8,  accent: 211 },
    { id: 'blue',   name: 'Синий',      hue: 218, sat: 40, accent: 208 },
    { id: 'violet', name: 'Фиолетовый', hue: 262, sat: 36, accent: 270 },
    { id: 'emerald', name: 'Изумруд',   hue: 168, sat: 34, accent: 152 },
    { id: 'crimson', name: 'Багровый',  hue: 350, sat: 32, accent: 352 },
    { id: 'amber',  name: 'Янтарь',     hue: 30,  sat: 30, accent: 40 },
    { id: 'rose',   name: 'Розовый',    hue: 320, sat: 30, accent: 328 },
  ];
  const DEFAULT = PRESETS[0];
  const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.min(100, Math.round(s * 10) / 10)}% ${l}%)`;
  const hslRgb = (h, s, l) => { // → "r,g,b" for rgba(var(--x), a)
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return `${f(0)},${f(8)},${f(4)}`;
  };

  function vars({ hue, sat, accent }) {
    const s = 10 + sat; // the slider's 8% is the design's grey with a little blue in it
    return {
      '--bg': hsl(hue, s, 6.3),
      '--bar': hsl(hue, s * 1.1, 4.9),
      '--well': hsl(hue, s * 1.15, 8.4),
      '--card': hsl(hue, s, 10),
      '--hover': hsl(hue, s, 12.7),
      '--raised': hsl(hue, s, 14.3),
      '--line': hsl(hue, s * 0.87, 17.6),
      '--line-strong': hsl(hue, s * 0.85, 24),
      '--text': hsl(hue, Math.min(40, 18 + sat), 95),
      '--sub': hsl(hue, 5 + sat * 0.9, 68),
      '--faint': hsl(hue, 2 + sat * 0.8, 53.5),
      '--accent': hsl(accent, 100, 65),
      '--accent-rgb': hslRgb(accent, 100, 65),
      '--on-accent': hsl(accent, 68, 7.3),
    };
  }

  let cur = { ...DEFAULT };
  function apply(t, save) {
    cur = { hue: +t.hue, sat: +t.sat, accent: +t.accent };
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(vars(cur))) root.setProperty(k, v);
    if (save) { try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch {} }
  }
  function load() {
    try {
      const t = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (t && [t.hue, t.sat, t.accent].every((n) => Number.isFinite(+n))) return t;
    } catch {}
    return null;
  }

  const saved = load();
  if (saved) apply(saved, false); // before the first paint (this script sits in <head>)

  window.Theme = {
    PRESETS, DEFAULT,
    get: () => ({ ...cur }),
    set: (t) => apply({ ...cur, ...t }, true),
    reset: () => { apply(DEFAULT, false); try { localStorage.removeItem(KEY); } catch {} },
    preset: (t) => PRESETS.find((p) => p.hue === t.hue && p.sat === t.sat && p.accent === t.accent) || null,
  };
})();
