// The open and close rules of the shared menu. app.js passes the document, the menu element, and two callbacks.
// A tap on a phone sends pointer events, touch events, a compatibility mousedown that moves the focus, and then click.
// The menu closes on click, Escape, an outside release, or when the focus leaves the menu for a place that is not a trigger.
export function installNavMenu({ doc, nav, brand, isPhone, isAppView, openHelp }) {
  let lastTrigger = null;
  let pointerDown = false;
  const triggers = () => doc.querySelectorAll('[data-nav-trigger]');
  const isOpen = () => nav.classList.contains('open');
  function setOpen(open) {
    nav.classList.toggle('open', open);
    for (const trigger of triggers()) trigger.setAttribute('aria-expanded', String(open));
  }
  const close = () => { setOpen(false); lastTrigger = null; };
  const inTrigger = (target) => Boolean(target?.closest?.('[data-nav-trigger]'));

  nav.addEventListener('pointerdown', (e) => { pointerDown = Boolean(e.target.closest?.('a, button')); });
  doc.addEventListener('pointerup', (e) => {
    // An iOS tap on a plain area sends no click to the document, so the release closes the menu.
    if (!pointerDown) {
      if (isOpen() && !nav.contains(e.target) && !inTrigger(e.target)) close();
      return;
    }
    pointerDown = false;
    if (nav.contains(e.target)) return;
    close();
  });
  doc.addEventListener('pointercancel', () => { pointerDown = false; });
  // Escape closes the open menu and returns the focus to its trigger. It returns false when the menu is closed.
  function escape() {
    if (!isOpen()) return false;
    const trigger = doc.querySelector('[data-nav-trigger][aria-expanded="true"]') || lastTrigger;
    setOpen(false);
    trigger?.focus();
    lastTrigger = null;
    return true;
  }
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  nav.addEventListener('focusout', (e) => {
    if (pointerDown) return;
    if (e.relatedTarget && nav.contains(e.relatedTarget)) return;
    // The mousedown of a tap on a trigger moves the focus before the click. The click toggles the menu.
    if (inTrigger(e.relatedTarget)) return;
    close();
  });
  doc.addEventListener('click', (e) => {
    const trigger = e.target.closest?.('[data-nav-trigger]');
    if (trigger) {
      if (trigger === brand && (!isPhone() || isAppView())) return;
      if (trigger === brand) e.preventDefault();
      lastTrigger = trigger;
      const open = !isOpen();
      setOpen(open);
      if (open) nav.querySelector('a[aria-current="page"], a')?.focus();
      else trigger.focus();
      return;
    }
    if (e.target.closest?.('[data-nav-help]')) {
      close();
      openHelp();
      return;
    }
    if (!isOpen()) return;
    if (e.target.closest?.('#primary-nav')) return;
    close();
  });
  return { setOpen, escape };
}
