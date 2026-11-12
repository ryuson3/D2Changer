// A small soft glow that follows the mouse. Pure decoration: it ignores clicks and never blocks anything.
(() => {
  const el = document.createElement('div');
  el.id = 'cursorGlow';
  document.body.appendChild(el);
  let tx = 0, ty = 0, x = 0, y = 0, raf = 0;
  const tick = () => {
    x += (tx - x) * 0.18; y += (ty - y) * 0.18;   // a little lag makes it feel soft
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    raf = (Math.abs(tx - x) > 0.3 || Math.abs(ty - y) > 0.3) ? requestAnimationFrame(tick) : 0;
  };
  addEventListener('mousemove', (e) => {
    tx = e.clientX; ty = e.clientY;
    if (!el.classList.contains('on')) { x = tx; y = ty; el.classList.add('on'); }
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => el.classList.remove('on'));
})();
