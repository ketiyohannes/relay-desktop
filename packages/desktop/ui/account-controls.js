const $ = (selector) => document.querySelector(selector);
const node = (tag, className, text) => { const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element; };

export function providerLabel(account) {
  return account?.engine === 'claude' ? 'Claude' : account?.provider === 'openai-codex' ? 'Codex' : account?.provider === 'openai' ? 'OpenAI API' : account?.provider || 'Account';
}

export function positionPopover(popover, anchor) {
  const box = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - popover.offsetWidth - 12))}px`;
  popover.style.bottom = `${Math.max(12, window.innerHeight - box.top + 8)}px`;
  popover.style.maxHeight = `${Math.max(120, box.top - 20)}px`;
}

export function installAccountControls(api) {
  const usage = new Map();
  const pending = new Map();
  const fingerprints = new Map();
  const menu = $('#account-menu');
  let previousBusy;
  let menuKey = '';
  const fingerprint = (account) => JSON.stringify([account.engine, account.provider, account.configDir, account.credentialSource]);

  const renderUsage = (container, account) => {
    container.replaceChildren();
    const value = usage.get(account.id);
    if (!value) { container.append(node('p', 'usage-note', pending.has(account.id) ? 'Checking usage…' : 'Usage not checked')); return; }
    if (value.plan) container.append(node('span', 'usage-plan', value.plan.replaceAll('_', ' ')));
    if (value.noFiveHourLimit) container.append(node('p', 'usage-note', 'No 5-hour limit'));
    for (const window of value.windows) {
      const row = node('div', 'usage-window');
      const heading = node('div', 'usage-window-heading');
      heading.append(node('span', '', window.label), node('strong', '', window.remainingPercent === null ? 'Unavailable' : `${Math.round(window.remainingPercent)}% left`));
      row.append(heading);
      if (window.remainingPercent !== null) {
        const meter = node('meter', 'usage-meter'); meter.min = 0; meter.max = 100; meter.value = window.remainingPercent;
        meter.setAttribute('aria-label', `${window.label} remaining`); row.append(meter);
      }
      if (window.resetsAt) row.append(node('small', 'usage-reset', `${window.resetsAt <= Date.now() ? 'Reset due' : 'Resets'} ${new Date(window.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`));
      container.append(row);
    }
    if (value.message) container.append(node('p', 'usage-note', value.message));
    container.append(node('small', 'usage-checked', `${pending.has(account.id) ? 'Refreshing · ' : ''}Checked ${new Date(value.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
  };

  const renderSummary = () => {
    const account = api.state().accounts.find((entry) => entry.id === api.active()?.accountId);
    const summary = $('#usage-summary');
    summary.hidden = !account;
    if (!account) return;
    const value = usage.get(account.id);
    const windows = value?.windows.filter((window) => ['5 hours', 'Weekly'].includes(window.label)) || [];
    summary.textContent = windows.length ? windows.map((window) => `${window.label === 'Weekly' ? 'Week' : '5h'} ${window.remainingPercent === null ? '—' : `${Math.round(window.remainingPercent)}%`}`).join(' · ') : pending.has(account.id) ? 'Usage…' : 'Usage';
    summary.title = value ? `${value.noFiveHourLimit ? 'No 5-hour limit. ' : ''}Remaining allowance · checked ${new Date(value.checkedAt).toLocaleTimeString()}. Click for details.` : 'View remaining usage and reset times';
  };

  const updateMeters = () => {
    for (const container of document.querySelectorAll('[data-usage-account]')) {
      const account = api.state().accounts.find((entry) => entry.id === container.dataset.usageAccount);
      if (account) renderUsage(container, account);
    }
    renderSummary();
  };

  const readUsage = async (account, refresh = false) => {
    if (!window.relay) return;
    const key = fingerprint(account);
    if (pending.get(account.id)?.key === key) return pending.get(account.id).promise;
    const cached = usage.get(account.id);
    if (!refresh && fingerprints.get(account.id) === key && cached && Date.now() - cached.checkedAt < 60000) return;
    if (fingerprints.get(account.id) !== key) usage.delete(account.id);
    fingerprints.set(account.id, key);
    const token = { key };
    pending.set(account.id, token);
    updateMeters();
    token.promise = api.command({ type: 'account_usage', accountId: account.id, refresh }).then((value) => {
      if (pending.get(account.id) === token) usage.set(account.id, value);
    }).catch(() => {
      if (pending.get(account.id) === token) usage.set(account.id, { accountId: account.id, checkedAt: Date.now(), windows: [], status: 'unavailable', message: 'Usage unavailable. Try refreshing.' });
    }).finally(() => {
      if (pending.get(account.id) === token) pending.delete(account.id);
      updateMeters();
    });
    return token.promise;
  };

  const attachUsage = (container, account) => {
    const meters = node('div', 'account-usage'); meters.dataset.usageAccount = account.id;
    container.append(meters); renderUsage(meters, account);
    void readUsage(account);
  };
  const renderMenu = () => {
    const state = api.state();
    const key = JSON.stringify([state.accounts, api.active()?.accountId, api.active()?.id]);
    if (key === menuKey) { updateMeters(); return; }
    menuKey = key;
    const options = $('#account-menu-options'); options.replaceChildren();
    for (const [index, account] of state.accounts.entries()) {
      const selected = account.id === api.active()?.accountId;
      const row = node('section', 'account-choice');
      const choose = node('button', `account-choice-button${selected ? ' selected' : ''}`); choose.type = 'button';
      choose.setAttribute('aria-pressed', String(selected)); choose.disabled = !api.active();
      const text = node('span', 'account-choice-label');
      text.append(node('strong', '', account.name), node('small', '', `${providerLabel(account)} · ${index + 1} in fallback order`));
      const mark = node('span', `icon icon-${selected ? 'check-circle' : 'caret-right'}`); mark.setAttribute('aria-hidden', 'true');
      choose.append(text, mark);
      choose.addEventListener('click', async () => { choose.disabled = true; try { await api.choose(account.id); menu.hidePopover(); } finally { choose.disabled = !api.active(); } });
      row.append(choose); attachUsage(row, account); options.append(row);
    }
    if (!state.accounts.length) options.append(node('p', 'usage-note', 'Connect Codex or Claude to begin.'));
  };
  const openMenu = () => {
    if (menu.matches(':popover-open')) { menu.hidePopover(); return; }
    menu.showPopover(); renderMenu(); positionPopover(menu, $('#account-picker'));
    for (const account of api.state().accounts) void readUsage(account);
    menu.querySelector('button:not(:disabled)')?.focus();
  };
  $('#account-picker').addEventListener('click', openMenu);
  $('#usage-summary').addEventListener('click', openMenu);
  menu.addEventListener('toggle', (event) => { $('#account-picker').setAttribute('aria-expanded', String(event.newState === 'open')); });
  for (const [id, tab] of [['account-menu-connect', 'connect'], ['account-menu-manage', 'connected']]) $(`#${id}`).addEventListener('click', () => { menu.hidePopover(); api.openAccounts(tab); });
  $('#usage-refresh').addEventListener('click', async () => {
    $('#usage-refresh').disabled = true;
    try { await Promise.all(api.state().accounts.map((account) => readUsage(account, true))); }
    finally { $('#usage-refresh').disabled = false; }
  });
  window.addEventListener('resize', () => { if (menu.matches(':popover-open')) positionPopover(menu, $('#account-picker')); });
  setInterval(() => {
    if (document.hidden) return;
    const accounts = api.state().accounts;
    for (const account of accounts.filter((account) => menu.matches(':popover-open') || $('#accounts-dialog').open || account.id === api.active()?.accountId)) void readUsage(account);
    updateMeters();
  }, 60000);
  return {
    attachUsage,
    render() {
      const state = api.state();
      const account = state.accounts.find((entry) => entry.id === api.active()?.accountId);
      $('#current-provider').textContent = providerLabel(account);
      $('#current-account').textContent = account?.name || 'Connect';
      $('#account-picker').title = account ? `${providerLabel(account)} · ${account.name}` : 'Connect an account';
      if (account) void readUsage(account, !!previousBusy && !state.busySession);
      previousBusy = state.busySession;
      renderSummary();
      if (menu.matches(':popover-open')) renderMenu();
    },
  };
}
