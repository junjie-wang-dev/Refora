/*
 * Shared mock behaviour: theme toggle + generic view/state switching.
 * Convention: .view-tab buttons carry data-view + data-group;
 *             .view-panel containers carry data-view + data-group.
 * Clicking a tab reveals the matching panel and styles the active tab.
 *
 * Also exposes mockReviewNav() to build a consistent cross-mock nav bar.
 */
document.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement;
  root.dataset.mockPage =
    window.location.pathname.split('/').pop()?.replace('.html', '') || 'index';

  try {
    const savedTheme = window.sessionStorage.getItem('refora-mock-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') root.dataset.theme = savedTheme;
  } catch {}

  const reviewBar = document.querySelector('.mock-reviewbar');
  if (reviewBar) {
    reviewBar.setAttribute('aria-label', 'Design review controls');
    reviewBar.nextElementSibling?.classList.add('mock-stage');
    reviewBar.querySelector('nav')?.classList.add('mock-reviewnav');
  }

  const themeBtn = document.getElementById('themeBtn');
  function syncThemeButton() {
    if (!themeBtn) return;
    const dark = root.dataset.theme === 'dark';
    themeBtn.classList.add('mock-theme-btn');
    themeBtn.setAttribute('aria-pressed', String(dark));
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    themeBtn.setAttribute('title', dark ? 'Switch to light theme' : 'Switch to dark theme');
    themeBtn.innerHTML = `<svg aria-hidden="true" viewBox="0 0 256 256" fill="currentColor"><use href="#i-${dark ? 'sun' : 'moon'}"/></svg><span>${dark ? 'Light' : 'Dark'}</span>`;
  }

  if (themeBtn) {
    syncThemeButton();
    themeBtn.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        window.sessionStorage.setItem('refora-mock-theme', root.dataset.theme);
      } catch {}
      syncThemeButton();
    });
  }

  function styleTab(tab, on) {
    tab.classList.toggle('bg-panel', on);
    tab.classList.toggle('text-foreground', on);
    tab.classList.toggle('text-muted', !on);
    tab.classList.toggle('font-medium', on);
    tab.setAttribute('aria-selected', String(on));
    tab.setAttribute('tabindex', on ? '0' : '-1');
  }

  function activate(tab) {
    const target = tab.dataset.view;
    const group = tab.dataset.group || '';
    const tabSelector = group ? `.view-tab[data-group="${group}"]` : '.view-tab';
    const panelSelector = group ? `.view-panel[data-group="${group}"]` : '.view-panel';
    document.querySelectorAll(tabSelector).forEach((t) => styleTab(t, t.dataset.view === target));
    document.querySelectorAll(panelSelector).forEach((p) => {
      const hidden = p.dataset.view !== target;
      p.classList.toggle('hidden', hidden);
      p.hidden = hidden;
    });
  }

  const tabs = Array.from(document.querySelectorAll('.view-tab'));
  new Set(tabs.map((tab) => tab.parentElement).filter(Boolean)).forEach((tabList) => {
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', 'Mock states');
  });
  tabs.forEach((tab) => {
    const group = tab.dataset.group || 'default';
    const view = tab.dataset.view || 'view';
    const panel = Array.from(document.querySelectorAll('.view-panel')).find(
      (candidate) =>
        (candidate.dataset.group || 'default') === group && candidate.dataset.view === view,
    );
    tab.id ||= `mock-tab-${group}-${view}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('tabindex', '-1');
    if (panel) {
      panel.id ||= `mock-panel-${group}-${view}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      tab.setAttribute('aria-controls', panel.id);
    }
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const groupTabs = tabs.filter(
        (candidate) => (candidate.dataset.group || 'default') === group,
      );
      const currentIndex = groupTabs.indexOf(tab);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + groupTabs.length) % groupTabs.length;
      if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % groupTabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = groupTabs.length - 1;
      event.preventDefault();
      groupTabs[nextIndex]?.focus();
      if (groupTabs[nextIndex]) activate(groupTabs[nextIndex]);
    });
  });

  const pageSelect = document.getElementById('mockPageSelect');
  if (pageSelect) {
    pageSelect.addEventListener('change', () => {
      window.location.href = pageSelect.value;
    });
  }

  const groups = new Set(tabs.map((t) => t.dataset.group || ''));
  groups.forEach((group) => {
    const panelSelector = group ? `.view-panel[data-group="${group}"]` : '.view-panel';
    const tabSelector = group ? `.view-tab[data-group="${group}"]` : '.view-tab';
    const panels = Array.from(document.querySelectorAll(panelSelector));
    const visible = panels.find((p) => !p.classList.contains('hidden'));
    const targetView = (visible ?? panels[0])?.dataset.view;
    if (!targetView) return;
    document.querySelectorAll(tabSelector).forEach((t) => {
      const selected = t.dataset.view === targetView;
      styleTab(t, selected);
      t.setAttribute('tabindex', selected ? '0' : '-1');
    });
    panels.forEach((p) => {
      const hidden = p.dataset.view !== targetView;
      p.classList.toggle('hidden', hidden);
      p.hidden = hidden;
    });
  });

  document.querySelectorAll('button[title]:not([aria-label])').forEach((button) => {
    button.setAttribute('aria-label', button.getAttribute('title'));
  });

  document.querySelectorAll('svg').forEach((svg) => {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  });
});

/*
 * Build the shared review-bar nav links markup so every mock has the same
 * navigation. Call mockReviewNav('current.html') and insert the returned
 * string into the review bar. Returns an HTML string of <a> links.
 */
window.mockReviewNav = function (current) {
  const pages = [
    { href: 'index.html', label: 'Index' },
    { href: 'app-layout.html', label: 'App layout' },
    { href: 'sidebar.html', label: 'Sidebar' },
    { href: 'document-list.html', label: 'Doc list' },
    { href: 'detail-panel.html', label: 'Detail' },
    { href: 'workspace.html', label: 'Workspace' },
    { href: 'chat-panel.html', label: 'Chat' },
    { href: 'onboarding.html', label: 'Onboarding' },
    { href: 'settings.html', label: 'Settings' },
    { href: 'dialogs.html', label: 'Dialogs' },
    { href: 'ocr-reader.html', label: 'OCR reader' },
    { href: 'chat-extras.html', label: 'Chat extras' },
  ];
  return `<label class="mock-page-select-wrap">
    <span>Review page</span>
    <select id="mockPageSelect" class="mock-page-select" aria-label="Review page">
      ${pages
        .map((p) => `<option value="${p.href}"${p.href === current ? ' selected' : ''}>${p.label}</option>`)
        .join('')}
    </select>
  </label>`;
};
