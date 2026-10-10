// The open and close rules of the shared menu. app.js passes the document, the menu element, and two callbacks.
// A tap on a phone sends pointer events, touch events, a compatibility mousedown that moves the focus, and then click.
// A tap on iOS Safari gives a link no focus, so the focused element blurs to the body before the click.
// The menu closes on Escape, on a pointer release outside it, on a click outside it, and after the click on an entry.
// An event inside the menu never closes it before the click: the anchor default action must run first.
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
  // The anchor default action starts the navigation after this handler. The menu closes in the next frame.
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) requestAnimationFrame(() => setOpen(false));
  });
  // Only a keyboard move of the focus to another element outside the menu closes it.
  // A blur to the body (relatedTarget null) is what iOS sends before the click of a tap, so it keeps the menu open.
  nav.addEventListener('focusout', (e) => {
    if (pointerDown || !e.relatedTarget) return;
    if (nav.contains(e.relatedTarget) || inTrigger(e.relatedTarget)) return;
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
