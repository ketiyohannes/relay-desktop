const $ = (selector) => document.querySelector(selector);

export const DEFAULT_APP_KEYBINDINGS = { submit: 'enter' };
export function showUsage() { return localStorage.getItem('relay.showUsage') !== 'false'; }
export function matchesAppKey(event, action) {
  const chord = (localStorage.getItem(`relay.keybinding.${action}`) || DEFAULT_APP_KEYBINDINGS[action] || '').split('+');
  return event.key.toLowerCase() === chord.at(-1)
    && event.shiftKey === chord.includes('shift') && event.altKey === chord.includes('alt')
    && (chord.includes('mod') ? event.ctrlKey || event.metaKey : !event.ctrlKey && !event.metaKey);
}

export function installSettings() {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const dialog = $('#settings-dialog');
  const render = () => {
    const preference = localStorage.getItem('relay.theme');
    const mode = ['light', 'dark'].includes(preference) ? preference : 'system';
    document.documentElement.dataset.theme = mode === 'system' ? system.matches ? 'dark' : 'light' : mode;
    $('#theme-select').value = mode;
    $('#send-shortcut').value = localStorage.getItem('relay.keybinding.submit') || DEFAULT_APP_KEYBINDINGS.submit;
    for (const [id, key, attribute] of [
      ['setting-usage', 'relay.showUsage', 'showUsage'],
      ['setting-account', 'relay.showAccount', 'showAccount'],
      ['setting-effects', 'relay.effects', 'effects'],
    ]) {
      const enabled = localStorage.getItem(key) !== 'false';
      $( `#${id}`).checked = enabled;
      document.documentElement.dataset[attribute] = String(enabled);
    }
    window.dispatchEvent(new Event('relay-select-refresh'));
  };
  const selectPage = (page) => {
    for (const tab of dialog.querySelectorAll('[data-settings-tab]')) {
      const selected = tab.dataset.settingsTab === page;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      $(`#settings-page-${tab.dataset.settingsTab}`).hidden = !selected;
    }
    window.dispatchEvent(new CustomEvent('relay-settings-page', { detail: page }));
  };
  const open = (page = 'general') => {
    document.querySelectorAll('.routing-popover:popover-open').forEach((popover) => popover.hidePopover());
    render(); selectPage(page);
    dialog.querySelectorAll('.dialog-error').forEach((error) => error.remove());
    if (!dialog.open) dialog.showModal();
  };
  $('#settings-button').addEventListener('click', () => open());
  $('#accounts-button').addEventListener('click', () => open());
  for (const tab of dialog.querySelectorAll('[data-settings-tab]')) {
    tab.addEventListener('click', () => selectPage(tab.dataset.settingsTab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...dialog.querySelectorAll('[data-settings-tab]')];
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
      selectPage(tabs[index].dataset.settingsTab); tabs[index].focus();
    });
  }
  for (const [id, key] of [['theme-select', 'relay.theme'], ['send-shortcut', 'relay.keybinding.submit'], ['setting-usage', 'relay.showUsage'], ['setting-account', 'relay.showAccount'], ['setting-effects', 'relay.effects']]) {
    $(`#${id}`).addEventListener('change', (event) => {
      localStorage.setItem(key, event.target.type === 'checkbox' ? String(event.target.checked) : event.target.value);
      render();
      document.querySelectorAll('.routing-popover:popover-open').forEach((popover) => popover.hidePopover());
      window.dispatchEvent(new Event('relay-settings-change'));
    });
  }
  system.addEventListener('change', render);
  render(); selectPage('general');
  return { open };
}
