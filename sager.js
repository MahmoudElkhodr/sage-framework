(() => {
  const menus = [...document.querySelectorAll('.menu')];
  const setOpen = (menu, open) => {
    menu.dataset.open = String(open);
    menu.querySelector('.dropdown-toggle')?.setAttribute('aria-expanded', String(open));
  };
  for (const menu of menus) {
    const toggle = menu.querySelector('.dropdown-toggle');
    toggle.addEventListener('click', () => {
      if (menu.dataset.open !== 'true') {
        menus.forEach(item => setOpen(item, false));
        setOpen(menu, true);
      }
    });
    menu.addEventListener('pointerenter', event => {
      if (event.pointerType === 'mouse') {
        menus.forEach(item => setOpen(item, item === menu));
      }
    });
    menu.addEventListener('pointerleave', event => {
      if (event.pointerType === 'mouse' && !menu.contains(document.activeElement)) setOpen(menu, false);
    });
    menu.addEventListener('focusout', event => {
      if (!menu.contains(event.relatedTarget)) setOpen(menu, false);
    });
    document.addEventListener('click', event => {
      if (!menu.contains(event.target)) setOpen(menu, false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.dataset.open === 'true') {
        setOpen(menu, false);
        toggle.focus();
      }
    });
  }
  const links = [...document.querySelectorAll('.sidebar-links a[href^="#"]')];
  const sections = [...document.querySelectorAll('.guide-content > section[id]')];
  const update = () => {
    let current = sections[0]?.id;
    for (const section of sections) if (section.getBoundingClientRect().top <= 150) current = section.id;
    for (const link of links) {
      if (link.hash === '#' + current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };
  let scheduled = false;
  document.addEventListener('scroll', () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => { update(); scheduled = false; });
    }
  }, {passive: true});
  update();
  for (const link of links) link.addEventListener('click', () => {
    const toc = link.closest('.mobile-toc');
    if (toc) toc.open = false;
  });
  document.querySelectorAll('[data-print]').forEach(button => button.addEventListener('click', () => window.print()));
  document.querySelectorAll('[data-print-cycle]').forEach(button => button.addEventListener('click', () => {
    document.body.dataset.printCycle = 'true';
    window.print();
  }));
  let closedDetails = [];
  window.addEventListener('beforeprint', () => {
    closedDetails = [...document.querySelectorAll('details.sample:not([open])')];
    closedDetails.forEach(item => item.open = true);
  });
  window.addEventListener('afterprint', () => {
    closedDetails.forEach(item => item.open = false);
    delete document.body.dataset.printCycle;
  });
  // Keep existing links to the former single-page modules useful.
  if (document.body.dataset.page === 'overview') {
    const legacy = {'#educator': 'sager-supervisors.html', '#student': 'sager-candidates.html'};
    if (legacy[location.hash]) location.replace(legacy[location.hash]);
  }
})();
