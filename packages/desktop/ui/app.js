import { renderCode } from './code-view.js';
import { renderFileTree, updateFileTree } from './file-tree.js';
import { installWorkspaceTools } from './workspace-tools.js';
import { installAccountControls, positionPopover, providerLabel } from './account-controls.js';

const $ = (selector) => document.querySelector(selector);
const bridge = window.relay;
let state = { projects: [], sessions: [], accounts: [] };
let activeId = localStorage.getItem('relay.activeSession') || '';
let selectedSnapshot;
let fileView;
let followMessages = true;
const drafts = new Map();
const accountCatalogs = new Map();
const accountCatalogErrors = new Map();
const toolExpansion = new Map();
let modelSelection;
let modelRequest = 0;
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
function renderTheme() {
  const preference = localStorage.getItem('relay.theme');
  const mode = ['light', 'dark'].includes(preference) ? preference : 'system';
  const theme = mode === 'system' ? systemTheme.matches ? 'dark' : 'light' : mode;
  document.documentElement.dataset.theme = theme;
  $('#theme-select').value = mode;
  $('#theme-icon').className = `icon icon-${theme === 'dark' ? 'moon' : 'sun'}`;
}
$('#theme-select').addEventListener('change', () => {
  localStorage.setItem('relay.theme', $('#theme-select').value);
  renderTheme();
});
systemTheme.addEventListener('change', renderTheme);
renderTheme();
const panels = [
  { element: '#navigation', toggle: '#sidebar-toggle', handle: '#left-resize', key: 'relay.sidebarHidden', widthKey: 'relay.sidebarWidth', variable: '--sidebar-width', label: 'projects', width: Number(localStorage.getItem('relay.sidebarWidth')) || 240, min: 180, max: 420 },
  { element: '#inspector', toggle: '#details-toggle', handle: '#right-resize', key: 'relay.inspectorHidden', widthKey: 'relay.inspectorWidth', variable: '--details-width', label: 'inspector', width: Number(localStorage.getItem('relay.inspectorWidth')) || 340, min: 280, max: 700 },
];
function renderPanels() {
  let budget = Math.max(460, window.innerWidth - 410 - 8);
  const visible = panels.filter((panel) => localStorage.getItem(panel.key) !== 'true');
  for (const panel of panels) {
    const hidden = !visible.includes(panel);
    const otherMinimum = panels.slice(panels.indexOf(panel) + 1).filter((item) => visible.includes(item)).reduce((sum, item) => sum + item.min, 0);
    const width = hidden ? 0 : Math.min(Math.max(panel.min, panel.width), panel.max, budget - otherMinimum);
    if (!hidden) budget -= width;
    document.documentElement.style.setProperty(panel.variable, `${width}px`);
    document.documentElement.style.setProperty(panel.handle === '#left-resize' ? '--left-rail' : '--right-rail', hidden ? '0px' : '4px');
    $(panel.element).hidden = hidden;
    $(panel.handle).hidden = hidden;
    $(panel.toggle).setAttribute('aria-expanded', String(!hidden));
    $(panel.toggle).setAttribute('aria-label', `${hidden ? 'Show' : 'Hide'} ${panel.label}`);
    $(panel.handle).setAttribute('aria-valuemin', String(panel.min));
    $(panel.handle).setAttribute('aria-valuemax', String(panel.max));
    $(panel.handle).setAttribute('aria-valuenow', String(Math.round(width)));
  }
}
for (const [index, panel] of panels.entries()) {
  $(panel.toggle).addEventListener('click', () => {
    localStorage.setItem(panel.key, String(!$(panel.element).hidden));
    renderPanels();
  });
  const handle = $(panel.handle);
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = event.clientX;
    const width = $(panel.element).getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    const move = (next) => {
      panel.width = Math.max(panel.min, Math.min(panel.max, width + (next.clientX - start) * (index === 0 ? 1 : -1)));
      renderPanels();
    };
    const finish = () => {
      panel.width = $(panel.element).getBoundingClientRect().width;
      localStorage.setItem(panel.widthKey, String(panel.width));
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('lostpointercapture', finish);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('lostpointercapture', finish);
  });
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    panel.width = event.key === 'Home' ? panel.min : event.key === 'End' ? panel.max : Math.max(panel.min, Math.min(panel.max, $(panel.element).getBoundingClientRect().width + (event.key === 'ArrowRight' ? 20 : -20) * (index === 0 ? 1 : -1)));
    renderPanels();
    panel.width = $(panel.element).getBoundingClientRect().width;
    localStorage.setItem(panel.widthKey, String(panel.width));
  });
}
window.addEventListener('resize', renderPanels);
renderPanels();
let inspectorTab = localStorage.getItem('relay.inspectorTab') || 'timeline';
if (!['timeline', 'diff', 'files', 'code'].includes(inspectorTab)) inspectorTab = 'timeline';
let inspectorSelection = '';
let inspectorPath = '';
let inspectorFile;
let inspectorRequest = 0;
let inspectorCacheKey = '';
function selectInspectorTab(view) {
  if (view === 'diff' && inspectorFile && !inspectorFile.changed.includes(inspectorPath)) inspectorCacheKey = '';
  inspectorTab = view;
  localStorage.setItem('relay.inspectorTab', view);
  for (const tab of document.querySelectorAll('[data-view]')) {
    const selected = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#view-${tab.dataset.view}`).hidden = !selected;
  }
  $('#inspector-source').hidden = view === 'timeline';
  $('#inspector-source').open = false;
  refreshInspector();
}
for (const tab of document.querySelectorAll('[data-view]')) {
  tab.addEventListener('click', () => selectInspectorTab(tab.dataset.view));
  tab.addEventListener('keydown', (event) => {
    const tabs = [...document.querySelectorAll('[data-view]')];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectInspectorTab(tabs[index].dataset.view);
    tabs[index].focus();
  });
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(text, onClick, className = '') {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}
function icon(name) {
  const element = node('span', `icon icon-${name}`);
  element.setAttribute('aria-hidden', 'true');
  return element;
}
function notice(error) {
  $('#notice').textContent = error instanceof Error ? error.message : String(error);
  $('#notice').hidden = false;
  const dialog = document.querySelector('dialog[open]');
  if (dialog) {
    let message = dialog.querySelector('.dialog-error');
    if (!message) { message = node('p', 'dialog-error'); dialog.append(message); }
    message.textContent = $('#notice').textContent;
  }
}
async function command(value) {
  try {
    if (!bridge) throw new Error('Browser preview. Launch the Electron app to connect projects and accounts.');
    const result = await bridge.command(value);
    if (result && Array.isArray(result.sessions)) receive(result);
    return result;
  } catch (error) { notice(error); throw error; }
}
function active() { return state.sessions.find((session) => session.id === activeId); }
function selectSession(id) {
  if (activeId) drafts.set(activeId, $('#prompt').value);
  inspectorRequest++;
  inspectorCacheKey = '';
  inspectorPath = '';
  inspectorSelection = '';
  activeId = id;
  localStorage.setItem('relay.activeSession', id);
  $('#prompt').value = drafts.get(id) || '';
  followMessages = true;
  render();
  workspaceTools.refreshHistory();
}
function receive(next) {
  state = next;
  if (!active() && state.sessions.length) activeId = state.sessions.at(-1).id;
  render();
}
function render() {
  const session = active();
  const busy = !!state.busySession;
  $('#projects').replaceChildren();
  for (const project of state.projects) {
    const group = node('div', 'project');
    const heading = node('div', 'project-name');
    const name = node('span', 'project-title', project.split(/[\\/]/).at(-1));
    name.title = project;
    heading.append(icon('folder-open'), name, button('', async () => {
      await command({ type: 'session', project });
      selectSession(state.sessions.at(-1).id);
    }));
    heading.lastChild.setAttribute('aria-label', `New session in ${project}`);
    heading.lastChild.classList.add('icon-button');
    heading.lastChild.append(icon('plus'));
    heading.lastChild.disabled = busy;
    group.append(heading);
    for (const item of state.sessions.filter((s) => s.project === project)) {
      const entry = button(item.name, () => selectSession(item.id), `session-button${item.id === activeId ? ' selected' : ''}`);
      entry.title = item.name;
      entry.setAttribute('aria-current', item.id === activeId ? 'true' : 'false');
      entry.replaceChildren(icon('chat-circle'), node('span', 'session-name', item.name));
      group.append(entry);
    }
    $('#projects').append(group);
  }
  if (!state.projects.length) $('#projects').append(node('p', 'empty-timeline', 'Your projects live here.\nOpen a folder with +.'));
  $('#recent').replaceChildren();
  const recent = [...state.sessions].sort((a, b) => b.updated - a.updated).slice(0, 4);
  for (const item of recent) {
    const entry = button(item.name, () => selectSession(item.id));
    entry.append(node('small', '', item.project.split(/[\\/]/).at(-1)));
    $('#recent').append(entry);
  }
  if (!recent.length) $('#recent').append(node('small', 'eyebrow', 'NO SESSIONS YET'));
  $('#session-title').textContent = session?.name || 'New session';
  $('#project-path').textContent = session?.project || 'Open a project to begin';
  accountControls.render();
  const account = state.accounts.find((item) => item.id === session?.accountId);
  const modelId = session?.models?.[account?.id] || account?.model;
  $('#current-model').textContent = accountCatalogs.get(account?.id)?.models.find((item) => item.id === modelId)?.name || modelId || 'Choose model';
  $('#model-picker').disabled = busy || !session || !state.accounts.length;
  $('#model-picker').title = busy ? 'Stop the run before changing models' : 'Choose model for this session';
  $('#composer-connect').disabled = busy;
  $('#auto-switch').checked = session?.autoSwitch ?? true;
  $('#auto-switch').disabled = !session;
  $('#cancel').hidden = !busy;
  $('#send').disabled = busy || !session || !session.accountId;
  $('#accounts-button').disabled = busy;
  $('#open-project').disabled = busy;
  $('#ai-review').disabled = busy || !session?.accountId;
  if (!busy) { permissionQueue.length = 0; $('#permission-dialog').close(); }
  renderMessages(session);
  renderTimeline(session);
  refreshInspector();
  renderSnapshotReviews();
}
async function openModels() {
  const session = active();
  if (!session) return;
  const request = ++modelRequest;
  modelSelection = { sessionId: session.id };
  $('#model-account').textContent = 'All connected accounts';
  if (!$('#model-dialog').matches(':popover-open')) { $('#model-search').value = ''; $('#model-dialog').showPopover(); $('#model-search').focus(); }
  positionPopover($('#model-dialog'), $('#model-picker'));
  $('#model-options').replaceChildren();
  $('#model-status').textContent = 'Loading models…';
  $('#model-refresh').disabled = true;
  try {
    const result = await command({ type: 'account_catalogs' });
    if (request !== modelRequest) return;
    accountCatalogs.clear(); accountCatalogErrors.clear();
    for (const entry of result.accounts) {
      if (entry.catalog) accountCatalogs.set(entry.accountId, entry.catalog);
      if (entry.error) accountCatalogErrors.set(entry.accountId, entry.error);
    }
    renderModelOptions();
    if ($('#accounts-dialog').open) renderAccounts();
  } catch (error) { if (request === modelRequest) $('#model-status').textContent = `Could not load models. ${error.message}`; }
  finally { if (request === modelRequest) $('#model-refresh').disabled = false; }
}
function renderModelOptions() {
  const selection = modelSelection;
  if (!selection) return;
  const session = state.sessions.find((item) => item.id === selection.sessionId);
  const search = $('#model-search').value.toLowerCase();
  $('#model-options').replaceChildren();
  let count = 0;
  for (const account of state.accounts) {
  const catalog = accountCatalogs.get(account.id);
  const current = session?.models?.[account.id] ?? account.model;
  const provider = providerLabel(account);
  const models = catalog?.connected !== false ? catalog?.models.filter((model) => model.authenticated && `${account.name} ${provider} ${model.name} ${model.id} ${model.description || ''}`.toLowerCase().includes(search)) || [] : [];
  const unavailable = accountCatalogErrors.get(account.id) || (catalog?.connected === false ? 'Sign-in needed' : '');
  if (!models.length && !unavailable) continue;
  const group = node('section', 'model-account-group');
  group.append(node('h3', '', `${account.name} · ${provider}`));
  if (unavailable) group.append(node('p', 'model-account-status', unavailable));
  count += models.length;
  for (const model of models) {
    const selected = session?.accountId === account.id && model.id === current;
    const row = button('', async () => {
      row.disabled = true;
      try {
        await command({ type: 'select_model', ...selection, accountId: account.id, model: model.id });
        $('#model-dialog').hidePopover();
      } catch (error) { $('#model-status').textContent = error.message; }
      finally { row.disabled = !model.authenticated; }
    }, `model-option${selected ? ' selected' : ''}`);
    const text = node('div');
    text.append(node('strong', '', model.name), node('small', '', model.description || `${model.id}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k context` : ''}`));
    row.append(text, icon(selected ? 'check-circle' : 'caret-right'));
    row.disabled = !model.authenticated || !!state.busySession;
    row.setAttribute('aria-pressed', String(selected));
    group.append(row);
  }
  $('#model-options').append(group);
  }
  $('#model-status').textContent = count ? `${count} models · choose a model to switch accounts in this session` : 'No authenticated models available. Connect an account or refresh.';
}
$('#model-picker').addEventListener('click', () => { if ($('#model-dialog').matches(':popover-open')) $('#model-dialog').hidePopover(); else openModels(); });
$('#model-refresh').addEventListener('click', () => openModels(true));
$('#model-search').addEventListener('input', renderModelOptions);
$('#model-close').addEventListener('click', () => $('#model-dialog').hidePopover());
$('#model-dialog').addEventListener('toggle', (event) => { $('#model-picker').setAttribute('aria-expanded', String(event.newState === 'open')); if (event.newState === 'closed') { modelRequest++; modelSelection = undefined; } });
window.addEventListener('resize', () => { if ($('#model-dialog').matches(':popover-open')) positionPopover($('#model-dialog'), $('#model-picker')); });
async function refreshInspector() {
  const session = active();
  const snapshots = session?.actions.filter((action) => action.snapshot && action.kind === 'checkpoint') || [];
  const selector = $('#inspector-snapshot');
  selector.replaceChildren();
  selector.append(new Option('Working tree', ''));
  for (const action of [...snapshots].reverse()) selector.append(new Option(`${new Date(action.time).toLocaleTimeString()} · ${action.text.split('\n')[0]}`, action.id));
  if (!snapshots.some((action) => action.id === inspectorSelection)) inspectorSelection = '';
  selector.value = inspectorSelection;
  selector.disabled = false;
  if (inspectorTab === 'timeline') return;
  const action = snapshots.find((item) => item.id === inspectorSelection);
  const cacheKey = `${session?.id || ''}/${action?.id || `live-${session?.updated || ''}`}`;
  if (cacheKey === inspectorCacheKey) return;
  inspectorCacheKey = cacheKey;
  const request = ++inspectorRequest;
  inspectorFile = undefined;
  $('#diff-expand').disabled = true;
  $('#diff-file-title').textContent = action ? action.text.split('\n')[0] : 'Working tree';
  $('#changed-files').replaceChildren();
  $('#project-files').replaceChildren();
  $('#inspector-code').textContent = session ? 'Select a file in Files or Changes.' : 'Open a project to browse files.';
  $('#inspector-diff').textContent = session ? 'Loading changes…' : 'Open a project to see changes.';
  $('#inspector-file-title').textContent = 'Select a file';
  if (!session) return;
  const selection = { sessionId: session.id, ...(action ? { actionId: action.id } : {}) };
  $('#inspector-code-mode').options[0].text = action ? 'After' : 'Working';
  $('#inspector-code-mode').options[1].text = action ? 'Before' : 'HEAD';
  try {
    const view = await command({ type: selection.actionId ? 'snapshot' : 'workspace', ...selection });
    if (request !== inspectorRequest) return;
    const paths = [...new Set(selection.actionId ? [...view.files, ...view.changed] : view.files)].sort();
    renderFileTree($('#project-files'), { files: paths, changed: view.changed, deleted: view.changed.filter((path) => !view.files.includes(path)), query: $('#file-search').value, selected: inspectorPath, select: (path) => loadInspectorFile(selection, path, 'code') });
    renderFileTree($('#changed-files'), { files: view.changed, changed: view.changed, deleted: view.changed.filter((path) => !view.files.includes(path)), selected: inspectorPath, select: (path) => loadInspectorFile(selection, path, 'diff') });
    $('#inspector-diff').textContent = view.changed.length ? 'Select a changed file to inspect its diff.' : 'No changes in this version.';
    const path = inspectorTab === 'diff' ? view.changed.includes(inspectorPath) ? inspectorPath : view.changed[0] : paths.includes(inspectorPath) ? inspectorPath : view.changed[0] || paths[0];
    if (path) await loadInspectorFile(selection, path);
  } catch (error) {
    if (request === inspectorRequest) { inspectorCacheKey = ''; $('#inspector-diff').textContent = String(error); }
  }
}
async function loadInspectorFile(selection, path, view) {
  const request = ++inspectorRequest;
  inspectorPath = path;
  inspectorFile = undefined;
  $('#diff-expand').disabled = true;
  $('#inspector-diff').textContent = 'Loading changes…';
  $('#inspector-code').textContent = 'Loading file…';
  try {
    const result = await command({ type: selection.actionId ? 'snapshot' : 'workspace', ...selection, path });
    if (request !== inspectorRequest) return;
    inspectorFile = result;
    $('#inspector-file-title').textContent = path;
    $('#diff-file-title').textContent = path;
    $('#diff-file-title').title = path;
    $('#diff-expand').disabled = false;
    renderCode($('#inspector-diff'), result);
    renderInspectorCode();
    updateFileTree($('#project-files'), { selected: path });
    updateFileTree($('#changed-files'), { selected: path });
    if (view) selectInspectorTab(view);
  } catch (error) { if (request === inspectorRequest) { $('#inspector-diff').textContent = error.message; $('#inspector-code').textContent = error.message; } }
}
function renderInspectorCode() {
  if (!inspectorFile) return;
  renderCode($('#inspector-code'), inspectorFile, $('#inspector-code-mode').value, { attachOrigin });
}
$('#diff-expand').addEventListener('click', () => openSnapshot(active()?.actions.find((action) => action.id === inspectorSelection), inspectorPath));
$('#inspector-snapshot').addEventListener('change', () => { inspectorSelection = $('#inspector-snapshot').value; $('#inspector-source').open = false; refreshInspector(); });
$('#inspector-code-mode').addEventListener('change', renderInspectorCode);
// Build DOM nodes from Markdown tokens. Model HTML and URLs never enter innerHTML.
function markdown(container, tokens, depth = 0) {
  if (depth > 30) return;
  for (const token of tokens) {
    let element;
    if (token.type === 'space') continue;
    if (token.type === 'heading') element = node(`h${Math.min(token.depth, 4)}`);
    else if (token.type === 'paragraph') element = node('p');
    else if (token.type === 'strong') element = node('strong');
    else if (token.type === 'em') element = node('em');
    else if (token.type === 'del') element = node('del');
    else if (token.type === 'blockquote') element = node('blockquote');
    else if (token.type === 'br') element = node('br');
    else if (token.type === 'hr') element = node('hr');
    else if (token.type === 'codespan') element = node('code', '', token.text);
    else if (token.type === 'code') { element = node('pre'); element.append(node('code', '', token.text)); }
    else if (token.type === 'list') {
      element = node(token.ordered ? 'ol' : 'ul');
      if (token.ordered && token.start) element.start = token.start;
      for (const item of token.items) { const row = node('li'); markdown(row, item.tokens, depth + 1); element.append(row); }
    } else if (token.type === 'link') {
      element = node('span', 'markdown-link');
      try {
        const url = new URL(token.href);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
          element = node('a'); element.href = url.href; element.title = url.href;
          element.addEventListener('click', (event) => { event.preventDefault(); bridge?.openUrl(url.href); });
        }
      } catch { /* Relative and unsupported links are displayed as text. */ }
    } else if (token.type === 'table') {
      element = node('table');
      const heading = node('tr');
      for (const cell of token.header) { const th = node('th'); markdown(th, cell.tokens, depth + 1); heading.append(th); }
      element.append(heading);
      for (const row of token.rows) { const tr = node('tr'); for (const cell of row) { const td = node('td'); markdown(td, cell.tokens, depth + 1); tr.append(td); } element.append(tr); }
    } else if (token.tokens) { markdown(container, token.tokens, depth + 1); continue; }
    else { container.append(document.createTextNode(token.text || token.raw || '')); continue; }
    if (token.tokens && !['list', 'table'].includes(token.type)) markdown(element, token.tokens, depth + 1);
    container.append(element);
  }
}
function renderMessages(session) {
  const container = $('#messages');
  const position = container.scrollTop;
  container.replaceChildren();
  const actions = session?.actions.filter((a) => a.kind !== 'checkpoint' || a.files?.length) || [];
  if (!actions.length) {
    const welcome = node('div', 'welcome');
    welcome.append(node('h2', '', session ? 'Start a conversation' : 'Open a project'), node('p', '', session ? 'Choose an account and send a prompt. Tool calls and code changes will appear as your agent works.' : 'Add a folder from the Projects panel, then connect an account to begin.'));
    if (!state.accounts.length) welcome.append(button('Connect an account', () => openAccounts('connect'), 'welcome-connect'));
    container.append(welcome);
    return;
  }
  for (const action of actions) {
    if (action.kind === 'tool') {
      const details = node('details', `tool-card ${action.status || 'done'}`);
      details.dataset.id = action.id;
      details.open = toolExpansion.get(action.id) ?? ['running', 'error'].includes(action.status);
      const summary = node('summary');
      summary.addEventListener('click', () => toolExpansion.set(action.id, !details.open));
      const name = action.text.split('\n')[0];
      let input = {};
      try { input = JSON.parse(action.input || '{}') || {}; } catch { /* Preserve raw input below. */ }
      const target = input.command || input.file_path || input.path || input.pattern || input.query || input.description || '';
      const status = action.status === 'running' ? action.progress || 'Running' : action.status === 'error' ? 'Failed' : 'Completed';
      const title = node('span', 'tool-heading');
      title.append(node('span', 'tool-name', name), node('span', 'tool-target', String(target)));
      summary.append(icon('caret-right'), icon(name.toLowerCase() === 'bash' ? 'terminal' : 'code'), title, node('span', 'tool-state', `${status}${action.finished ? ` · ${Math.max(0.1, (action.finished - action.time) / 1000).toFixed(1)}s` : ''}`));
      details.append(summary);
      const body = node('div', 'tool-body');
      if (action.input) body.append(node('div', 'tool-section-label', 'Input'), node('pre', '', action.input));
      const output = action.output ?? action.text.split('\n').slice(1).join('\n');
      if (output) {
        let display = output;
        try {
          const value = JSON.parse(output);
          if (typeof value === 'string') display = value;
          else if (Array.isArray(value?.content)) display = value.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n') || output;
          if (value?.details?.diff) display += `\n${value.details.diff}`;
        } catch { /* Plain tool output is displayed verbatim. */ }
        body.append(node('div', 'tool-section-label', 'Output'), node('pre', 'tool-output', display));
      } else body.append(node('p', 'tool-waiting', action.status === 'running' ? 'Waiting for output…' : 'No output returned.'));
      details.append(body);
      container.append(details);
    } else if (action.kind === 'checkpoint') {
      const checkpoint = button('', () => openSnapshot(action), 'conversation-checkpoint');
      checkpoint.append(icon('check-circle'), node('span', '', action.files.length === 1 ? action.files[0] : `${action.files.length} files changed`), node('span', 'muted', 'View changes'));
      container.append(checkpoint);
    } else {
      const message = node('article', `message ${action.kind}`);
      if (['user', 'assistant', 'review'].includes(action.kind)) {
        const label = node('div', 'message-label');
        label.append(node('span', '', action.kind === 'user' ? 'You' : action.kind === 'review' ? 'Review' : 'Agent'), node('span', '', new Date(action.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
        message.append(label);
      }
      const body = node('div', 'message-body');
      if (['assistant', 'review'].includes(action.kind) && window.marked) { body.classList.add('markdown'); markdown(body, window.marked.lexer(action.text)); }
      else body.textContent = action.text;
      message.append(body);
      container.append(message);
    }
  }
  if (state.busySession === session?.id) {
    const activity = node('div', 'conversation-activity');
    activity.append(node('span', 'led'), node('span', '', session.actions.some((action) => action.kind === 'tool' && action.status === 'running') ? 'Working on your request' : 'Agent is responding…'));
    container.append(activity);
  }
  container.scrollTop = followMessages ? container.scrollHeight : position;
}
const timelineExpansion = new Map();
const timelineFolderExpansion = new Map();
const timelinePreviews = new Map();
async function renderTimelinePreview(container, sessionId, action) {
  const key = `${sessionId}/${action.id}/${action.files[0]}`;
  container.textContent = 'Loading changes…';
  try {
    if (!timelinePreviews.has(key)) {
      timelinePreviews.set(key, command({ type: 'snapshot', sessionId, actionId: action.id, path: action.files[0] }));
      if (timelinePreviews.size > 40) timelinePreviews.delete(timelinePreviews.keys().next().value);
    }
    const view = await timelinePreviews.get(key);
    if (container.isConnected) renderCode(container, view, 'diff', { limit: 16 });
  } catch (error) { timelinePreviews.delete(key); container.textContent = error.message; }
}
function renderTimeline(session) {
  const query = $('#timeline-search').value.toLowerCase();
  const actions = session?.actions.filter((a, index) => ['tool', 'checkpoint', 'switch', 'error', 'review'].includes(a.kind) && (a.kind !== 'checkpoint' || a.files?.length) && `${index + 1} ${a.text} ${a.files?.join(' ') || ''}`.toLowerCase().includes(query)) || [];
  const latestChange = actions.findLast((action) => action.kind === 'checkpoint' && action.files?.length);
  const position = $('#actions').scrollTop;
  $('#actions').replaceChildren();
  if (!actions.length) $('#actions').append(node('p', 'empty-timeline', 'Nothing recorded yet.\nActions appear here as\nyour agent works.'));
  actions.forEach((action, index) => {
    const entry = node('article', 'action');
    const details = node('details', 'action-details');
    details.dataset.id = action.id;
    details.open = timelineExpansion.get(action.id) ?? action === latestChange;
    const summary = node('summary');
    let title = action.text.split('\n')[0];
    if (action.kind === 'checkpoint' && action.files?.length) title = `${action.files.length} ${action.files.length === 1 ? 'file' : 'files'} changed`;
    if (action.kind === 'tool') {
      try {
        const input = JSON.parse(action.input || '{}');
        const target = input.file_path || input.path || input.command || input.pattern || input.query;
        if (target) title += ` · ${target}`;
      } catch { /* Legacy action text remains available under details. */ }
    }
    summary.append(icon({tool: 'terminal', checkpoint: 'check-circle', switch: 'arrows-clockwise', error: 'warning-circle', review: 'note-pencil'}[action.kind] || 'code'), node('span', 'action-title', title), node('time', 'action-time', new Date(action.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })));
    summary.title = `${action.kind} · Action ${index + 1} · ${title}`;
    details.append(summary);
    if (action.kind === 'checkpoint' && action.files?.length) {
      const files = node('div', 'timeline-files');
      if (!timelineFolderExpansion.has(action.id)) {
        timelineFolderExpansion.set(action.id, { expanded: new Set(), collapsed: new Set() });
        if (timelineFolderExpansion.size > 100) timelineFolderExpansion.delete(timelineFolderExpansion.keys().next().value);
      }
      renderFileTree(files, { files: action.files, changed: action.files, expansion: timelineFolderExpansion.get(action.id), select: (path) => openSnapshot(action, path) });
      const preview = node('pre', 'timeline-preview');
      preview.setAttribute('aria-label', `Changes in ${action.files[0]}`);
      details.append(files, preview, button('Open code & review', () => openSnapshot(action), 'timeline-review'));
      summary.addEventListener('click', () => {
        timelineExpansion.set(action.id, !details.open);
        if (!details.open) renderTimelinePreview(preview, session.id, action);
      });
      // Queue until the new timeline is in the document.
      if (details.open) queueMicrotask(() => renderTimelinePreview(preview, session.id, action));
    } else {
      summary.addEventListener('click', () => timelineExpansion.set(action.id, !details.open));
      if (action.kind === 'tool') {
        details.append(node('div', 'action-description', action.status === 'running' ? action.progress || 'Running…' : action.status === 'error' ? 'Failed' : 'Completed'));
        const raw = node('details', 'action-raw');
        raw.append(node('summary', '', 'Tool details'), node('pre', '', [action.input, action.output || action.text].filter(Boolean).join('\n\n')));
        details.append(raw);
      } else details.append(node('div', 'action-description', action.text));
    }
    if (action.snapshot) {
      const inspect = button('', () => openSnapshot(action), 'icon-button action-inspect');
      inspect.append(icon('code'));
      inspect.setAttribute('aria-label', `Inspect codebase: ${title}`);
      inspect.title = 'Inspect codebase and review';
      entry.append(inspect);
    }
    entry.prepend(details);
    $('#actions').append(entry);
  });
  $('#actions').scrollTop = position;
}
let snapshotRequest = 0;
async function openSnapshot(action, preferredPath, searchMatch) {
  const request = ++snapshotRequest;
  selectedSnapshot = { sessionId: activeId, ...(action ? { actionId: action.id } : {}) };
  workspaceTools.updateNavigation();
  renderSnapshotReviews();
  fileView = undefined;
  $('#snapshot-title').textContent = action ? action.text.split('\n')[0] : 'Working tree';
  $('#snapshot-dialog .eyebrow').textContent = action ? 'Historical codebase · Read only' : 'Working tree · Read only';
  $('#review-form').hidden = !action;
  $('#code-mode').options[0].text = action ? 'Entire file / after' : 'Entire file / working';
  $('#code-mode').options[1].text = action ? 'Entire file / before' : 'Entire file / HEAD';
  $('#file-title').textContent = 'Changes';
  $('#snapshot-all-files').checked = false;
  $('#snapshot-all-files').disabled = true;
  $('#snapshot-file-search').value = '';
  $('#snapshot-edit').disabled = true;
  $('#snapshot-files').replaceChildren();
  $('#file-content').textContent = 'Loading snapshot…';
  if (!$('#snapshot-dialog').open) $('#snapshot-dialog').showModal();
  const selection = { ...selectedSnapshot };
  const view = await command({ type: selection.actionId ? 'snapshot' : 'workspace', ...selection });
  if (request !== snapshotRequest) return;
  const paths = [...new Set([...view.changed, ...view.files])];
  const showAll = !!preferredPath && !view.changed.includes(preferredPath);
  $('#snapshot-all-files').checked = showAll;
  $('#snapshot-all-files').disabled = false;
  const load = async (path) => {
    const fileRequest = ++snapshotRequest;
    fileView = undefined;
    $('#file-content').textContent = 'Loading file…';
    $('#file-title').textContent = path;
    updateFileTree($('#snapshot-files'), { selected: path });
    try {
      const result = await command({ type: selection.actionId ? 'snapshot' : 'workspace', ...selection, path });
      if (fileRequest !== snapshotRequest) return;
      fileView = result;
      $('#snapshot-edit').disabled = false;
      renderFile();
    } catch (error) { if (fileRequest === snapshotRequest) $('#file-content').textContent = error.message; }
  };
  renderFileTree($('#snapshot-files'), { files: paths, changed: view.changed, deleted: view.changed.filter((path) => !view.files.includes(path)), changedOnly: !showAll, select: load, orders: view.fileOrders });
  const path = paths.includes(preferredPath) ? preferredPath : view.changed[0];
  $('#code-mode').value = searchMatch ? 'context' : view.changed.includes(path) ? 'diff' : 'after';
  if (path) await load(path);
  else $('#file-content').textContent = 'No visible changes. Enable All files to browse the codebase.';
  if (searchMatch && fileView?.path === path) {
    renderCode($('#file-content'), fileView, 'context', { attachOrigin, query: searchMatch.query });
    const row = [...$('#file-content').querySelectorAll('.code-line')].find((row) => row.dataset[searchMatch.side === 'before' ? 'oldLine' : 'newLine'] === String(searchMatch.line));
    row?.classList.add('active-match'); row?.scrollIntoView({ block: 'center' });
  }
}
$('#snapshot-all-files').addEventListener('change', () => {
  updateFileTree($('#snapshot-files'), { changedOnly: !$('#snapshot-all-files').checked });
  if (!$('#snapshot-all-files').checked && fileView && !fileView.changed.includes(fileView.path)) {
    snapshotRequest++;
    fileView = undefined;
    $('#file-content').textContent = 'Select a changed file.';
    $('#file-title').textContent = 'Changes';
  }
});
$('#snapshot-file-search').addEventListener('input', () => updateFileTree($('#snapshot-files'), { query: $('#snapshot-file-search').value }));
$('#snapshot-dialog').addEventListener('close', () => { snapshotRequest++; fileView = undefined; });
function renderFile() {
  if (!fileView) return;
  $('#file-title').textContent = fileView.path;
  renderCode($('#file-content'), fileView, $('#code-mode').value, { attachOrigin });
}
function renderSnapshotReviews() {
  const container = $('#snapshot-reviews');
  container.replaceChildren();
  const session = state.sessions.find((session) => session.id === selectedSnapshot?.sessionId);
  const action = session?.actions.find((action) => action.id === selectedSnapshot?.actionId) || workspaceTools.actions.get(selectedSnapshot?.actionId);
  if (!action?.snapshot || !session) return;
  for (const review of session.actions.filter((review) => review.kind === 'review' && review.snapshot === action.snapshot)) {
    const details = node('details', 'snapshot-review');
    details.append(node('summary', '', `${new Date(review.time).toLocaleTimeString()} · ${review.text.split('\n')[0].slice(0, 90)}`));
    const body = node('div', 'markdown'); markdown(body, window.marked.lexer(review.text)); details.append(body); container.append(details);
  }
}
let directoryView;
let browserPurpose = 'project';
let browserRequest = 0;
async function openBrowser(purpose, path) {
  browserPurpose = purpose;
  $('#browser-title').textContent = purpose === 'project' ? 'Open project' : 'Select account profile';
  $('#browser-select').textContent = purpose === 'project' ? 'Open folder' : 'Use folder';
  $('#browser-search').value = '';
  $('#browser-dialog').showModal();
  await loadDirectory(path);
}
async function loadDirectory(path) {
  const request = ++browserRequest;
  directoryView = undefined;
  $('#browser-select').disabled = true;
  $('#browser-finder').disabled = true;
  $('#browser-entries').replaceChildren(node('p', 'empty-timeline', 'Loading folders…'));
  const result = await command({ type: 'browse', path });
  if (request !== browserRequest) return;
  directoryView = result;
  $('#browser-select').disabled = false;
  $('#browser-finder').disabled = false;
  $('#browser-path').value = result.path;
  $('#browser-up').disabled = result.parent === result.path;
  renderDirectory();
}
function renderDirectory() {
  $('#browser-entries').replaceChildren();
  for (const entry of directoryView?.entries || []) {
    const search = $('#browser-search').value.toLowerCase();
    if (entry.name.startsWith('.') && !search.startsWith('.')) continue;
    if (!entry.name.toLowerCase().includes(search)) continue;
    const row = button(entry.name, () => { $('#browser-search').value = ''; loadDirectory(entry.path); });
    row.prepend(icon('folder-open'));
    $('#browser-entries').append(row);
  }
  if (!$('#browser-entries').children.length) $('#browser-entries').append(node('p', 'empty-timeline', 'No matching folders.'));
}
$('#browser-path-form').addEventListener('submit', (event) => { event.preventDefault(); loadDirectory($('#browser-path').value); });
$('#browser-search').addEventListener('input', renderDirectory);
$('#browser-up').addEventListener('click', () => { $('#browser-search').value = ''; loadDirectory(directoryView.parent); });
$('#browser-finder').addEventListener('click', () => bridge.reveal(directoryView.path));
$('#browser-select').addEventListener('click', async () => {
  if (!directoryView) return;
  const path = directoryView.path;
  if (browserPurpose === 'project') {
    await command({ type: 'project', path });
    await command({ type: 'session', project: path });
    selectSession(state.sessions.at(-1).id);
  } else { $('#account-form').elements.configDir.value = path; }
  $('#browser-dialog').close();
});
$('#open-project').addEventListener('click', () => openBrowser('project', active()?.project));
$('#browse-profile').addEventListener('click', () => openBrowser('profile', $('#account-form').elements.configDir.value || undefined));
$('#file-search').addEventListener('input', () => {
  updateFileTree($('#project-files'), { query: $('#file-search').value });
});
$('#refresh-files').addEventListener('click', () => { inspectorCacheKey = ''; refreshInspector(); });
$('#reveal-project').addEventListener('click', () => { if (active()) bridge.reveal(active().project); });
let editingAccount = '';
let loginState;
function selectAccountTab(selected) {
  for (const tab of document.querySelectorAll('[data-account-tab]')) {
    const active = tab.dataset.accountTab === selected;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    $(`#account-view-${tab.dataset.accountTab}`).hidden = !active;
  }
  if (selected === 'profile') $('#accounts-dialog .existing-profiles').open = true;
}
function openAccounts(tab = state.accounts.length ? 'connected' : 'connect') {
  accountForm(); renderAccounts(); selectAccountTab(loginState?.status === 'running' ? 'connect' : tab);
  $('#accounts-dialog').querySelectorAll('.dialog-error').forEach((item) => item.remove());
  if (!$('#accounts-dialog').open) $('#accounts-dialog').showModal();
}
for (const tab of document.querySelectorAll('[data-account-tab]')) {
  tab.addEventListener('click', () => selectAccountTab(tab.dataset.accountTab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-account-tab]')];
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectAccountTab(tabs[index].dataset.accountTab); tabs[index].focus();
  });
}
for (const provider of ['codex', 'claude']) $(`#signup-${provider}`).addEventListener('click', async () => {
  await bridge.openUrl(provider === 'codex' ? 'https://chatgpt.com/auth/login' : 'https://claude.ai/login');
  $('#signup-status').textContent = `Create your ${provider === 'codex' ? 'ChatGPT' : 'Claude'} account in the browser, then return and choose Sign in to connect it to Relay.`;
});
function renderLogin(next) {
  loginState = next;
  const running = next.status === 'running';
  $('#login-codex').disabled = running;
  $('#login-claude').disabled = running;
  $('#login-name').disabled = running;
  for (const provider of ['codex', 'claude']) $(`#signup-${provider}`).disabled = running;
  $('#login-cancel').hidden = !running;
  $('#login-status').textContent = next.message;
  $('#login-steps').replaceChildren();
  if (next.url) $('#login-steps').append(button('Open authorization page', () => bridge.openUrl(next.url)));
  if (next.code) $('#login-steps').append(node('p', 'login-code', next.code));
  if (next.prompt) {
    const prompt = next.prompt;
    $('#login-steps').append(node('p', '', prompt.message));
    if (prompt.options) {
      for (const option of prompt.options) $('#login-steps').append(button(option.label, () => command({ type: 'login_reply', id: prompt.id, value: option.id })));
    } else {
      const input = node('input'); input.type = prompt.type === 'secret' ? 'password' : 'text'; input.autocomplete = 'off'; input.setAttribute('aria-label', prompt.message);
      const submit = () => { const value = input.value.trim(); if (value) { input.value = ''; command({ type: 'login_reply', id: prompt.id, value }); } };
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
      $('#login-steps').append(input, button('Continue', submit));
    }
  }
  if (next.status === 'success') {
    accountCatalogs.clear();
    renderAccounts();
    $('#login-steps').append(button('View connected accounts', () => selectAccountTab('connected')));
    const session = active();
    if (session && !session.accountId && state.accounts.length) command({ type: 'select_account', sessionId: session.id, accountId: state.accounts.at(-1).id, autoSwitch: true });
  }
}
for (const provider of ['codex', 'claude']) $(`#login-${provider}`).addEventListener('click', () => command({ type: 'login_start', provider, name: $('#login-name').value.trim() || (provider === 'codex' ? 'Codex' : 'Claude') }));
$('#login-cancel').addEventListener('click', () => { $('#login-status').textContent = 'Cancelling sign-in…'; command({ type: 'login_cancel' }); });
$('#accounts-dialog').addEventListener('close', () => { if (loginState?.status === 'running') command({ type: 'login_cancel' }); });
let accountRequest = 0;
function accountForm(account) {
  $('#accounts-dialog .existing-profiles').open = !!account;
  if (account) selectAccountTab('profile');
  accountRequest++;
  editingAccount = account?.id || '';
  const form = $('#account-form');
  form.reset();
  $('#profile-status').textContent = '';
  for (const name of ['name', 'engine', 'configDir', 'provider', 'model', 'credentialSource']) if (account) form.elements[name].value = account[name] || (name === 'credentialSource' ? 'pi' : '');
  renderAccountFields();
}
function renderAccountFields() {
  const form = $('#account-form');
  const pi = form.elements.engine.value === 'pi';
  form.elements.credentialSource.closest('label').hidden = !pi;
  form.elements.provider.closest('label').hidden = !pi;
  $('#load-models').hidden = false;
  if (!pi) form.elements.credentialSource.value = 'pi';
}
$('#account-form').elements.engine.addEventListener('change', renderAccountFields);
function renderAccounts() {
  $('#configured-accounts').replaceChildren();
  if (!state.accounts.length) $('#configured-accounts').textContent = 'No accounts connected. Add profiles in fallback order.';
  for (const [index, account] of state.accounts.entries()) {
    const row = node('article', 'connected-account');
    const heading = node('div', 'connected-heading');
    const identity = node('div');
    const provider = account.engine === 'claude' ? 'Claude' : account.provider === 'openai-codex' ? 'Codex' : account.provider;
    const catalog = accountCatalogs.get(account.id);
    identity.append(node('strong', '', account.name), node('small', '', `${provider} · ${account.model || 'Default model'}`));
    const status = node('span', 'connection-status', accountCatalogErrors.has(account.id) ? 'Unavailable' : catalog ? catalog.connected ? `${catalog.models.filter((model) => model.authenticated).length} models` : 'Sign-in needed' : 'Saved');
    heading.append(identity, status);
    row.append(heading);
    if (catalog?.identity) row.append(node('p', 'account-identity', catalog.identity));
    accountControls.attachUsage(row, account);
    const controls = node('div', 'account-row-controls');
    const use = button(active()?.accountId === account.id ? 'Selected' : 'Use account', async () => {
      if (active()) await command({ type: 'select_account', sessionId: activeId, accountId: account.id, autoSwitch: $('#auto-switch').checked });
      renderAccounts();
    });
    use.disabled = !active() || active()?.accountId === account.id;
    const check = button('Check connection', async () => {
      check.disabled = true; status.textContent = 'Checking…';
      try { accountCatalogs.set(account.id, await command({ type: 'account_catalog', accountId: account.id })); accountCatalogErrors.delete(account.id); renderAccounts(); }
      catch { status.textContent = 'Check failed'; check.disabled = false; }
    });
    controls.append(use, check, button('Edit', () => accountForm(account)));
    const up = button('', async () => { await command({ type: 'move_account', accountId: account.id, offset: -1 }); renderAccounts(); });
    up.append(icon('arrow-up'));
    up.setAttribute('aria-label', `Move ${account.name} earlier in fallback order`);
    up.disabled = index === 0;
    controls.append(up);
    const down = button('', async () => { await command({ type: 'move_account', accountId: account.id, offset: 1 }); renderAccounts(); });
    down.append(icon('arrow-up')); down.className = 'move-account-down'; down.title = 'Move later'; down.setAttribute('aria-label', `Move ${account.name} later in fallback order`); down.disabled = index === state.accounts.length - 1;
    controls.append(down); row.append(controls);
    $('#configured-accounts').append(row);
  }
}
$('#accounts-button').addEventListener('click', () => openAccounts());
$('#composer-connect').addEventListener('click', () => openAccounts('connect'));
$('#new-account').addEventListener('click', () => { accountForm(); $('#accounts-dialog .existing-profiles').open = true; });
let catalog;
async function loadModels() {
  const form = $('#account-form');
  const request = ++accountRequest;
  const provider = form.elements.provider.value;
  $('#profile-status').textContent = 'Loading profile models…';
  catalog = await command({ type: 'catalog', configDir: form.elements.configDir.value || undefined, credentialSource: form.elements.credentialSource.value, engine: form.elements.engine.value });
  if (request !== accountRequest) return;
  $('#models-list').replaceChildren();
  for (const model of catalog.models.filter((model) => form.elements.engine.value === 'claude' || !provider || model.provider === provider)) $('#models-list').append(new Option(`${model.name} / ${model.provider}`, model.id));
  const authenticated = [...new Set(catalog.models.filter((model) => model.authenticated).map((model) => model.provider))];
  $('#profile-status').textContent = authenticated.length ? `Credentials available · ${catalog.models.length} models loaded${catalog.identity ? ` · ${catalog.identity}` : ''}` : 'No credentials found. Sign in from Add account, or choose another profile.';
  return catalog;
}
$('#load-models').addEventListener('click', loadModels);
$('#account-form').elements.provider.addEventListener('change', loadModels);
async function useDefaultPi(source) {
  accountForm({ id: '', name: source === 'codex' ? 'Codex' : 'Pi', engine: 'pi', configDir: '', provider: 'openai-codex', model: '', credentialSource: source });
  const result = await loadModels();
  if (!result) return;
  $('#account-form').elements.configDir.value = result.configDir;
  const preferred = result.models.filter((model) => model.authenticated && model.provider === 'openai-codex');
  const chosen = preferred.at(-1);
  if (chosen) $('#account-form').elements.model.value = chosen.id;
}
$('#default-pi').addEventListener('click', () => useDefaultPi('pi'));
$('#default-codex').addEventListener('click', () => useDefaultPi('codex'));
$('#default-claude').addEventListener('click', () => { accountForm({ id: '', name: 'Claude', engine: 'claude', configDir: '', provider: '', model: 'sonnet' }); loadModels(); });
function attachOrigin(element, snapshot) {
  const recorded = active()?.actions.filter((action) => action.snapshot && action.kind === 'checkpoint' && action.files?.length) || [];
  const action = recorded.find((action) => action.snapshot === snapshot) || [...workspaceTools.actions.values()].find((action) => action.snapshot === snapshot);
  element.dataset.origin = snapshot;
  element.title = action ? `Origin: ${action.text} · ${new Date(action.time).toLocaleTimeString()}` : `Origin: ${snapshot.slice(0, 8)}`;
  if (action) {
    const index = recorded.indexOf(action);
    const badge = button(action.changeOrder ? `Δ${action.changeOrder}` : index >= 0 ? `Δ${index + 1}` : 'Origin', () => openSnapshot(action), 'origin-badge');
    badge.title = element.title; element.append(badge);
    element.querySelector('.line-number').addEventListener('click', () => openSnapshot(action));
  }
}
const permissionQueue = [];
function showPermission() {
  const request = permissionQueue[0];
  if (!request) return;
  $('#permission-title').textContent = `Allow ${request.tool}?`;
  $('#permission-input').textContent = JSON.stringify(request.input, null, 2);
  if (!$('#permission-dialog').open) $('#permission-dialog').showModal();
}
async function answerPermission(allowed, allowRun = false) {
  const request = permissionQueue.shift();
  $('#permission-dialog').close();
  if (request) await bridge.permission(request.id, allowed, allowRun);
  showPermission();
}
$('#permission-allow').addEventListener('click', () => answerPermission(true));
$('#permission-run').addEventListener('click', () => answerPermission(true, true));
$('#permission-deny').addEventListener('click', () => answerPermission(false));
$('#permission-dialog').addEventListener('cancel', (event) => { event.preventDefault(); answerPermission(false); });
$('#ai-review').addEventListener('click', async () => {
  if (!selectedSnapshot) return;
  await command({ type: 'review_snapshot', ...selectedSnapshot });
  $('#snapshot-dialog').close();
  selectInspectorTab('timeline');
});
for (const close of document.querySelectorAll('.close-dialog')) close.addEventListener('click', () => close.closest('dialog').close());
$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    await command({ type: 'account', account: { ...data, id: editingAccount } });
    accountCatalogs.clear();
    const session = active();
    if (session && !session.accountId) await command({ type: 'select_account', sessionId: session.id, accountId: state.accounts.at(-1).id, autoSwitch: true });
    renderAccounts(); selectAccountTab('connected');
    form.reset();
  } catch (error) { notice(error); }
});
async function updateAccount(accountId = active()?.accountId) {
  if (!active()) return;
  if (state.busySession === activeId && active().accountId !== accountId) { permissionQueue.length = 0; $('#permission-dialog').close(); }
  await command({ type: 'select_account', sessionId: activeId, accountId, autoSwitch: $('#auto-switch').checked });
}
$('#auto-switch').addEventListener('change', () => updateAccount());
$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('#prompt').value.trim();
  if (!text) return;
  $('#notice').hidden = true;
  const sessionId = activeId;
  const submitted = $('#prompt').value;
  try {
    await command({ type: 'prompt', sessionId, text });
    if (activeId === sessionId && $('#prompt').value === submitted) $('#prompt').value = '';
    if (drafts.get(sessionId) === submitted) drafts.delete(sessionId);
  }
  catch (error) { notice(error); }
});
$('#cancel').addEventListener('click', () => command({ type: 'cancel' }));
$('#code-mode').addEventListener('change', renderFile);
$('#messages').addEventListener('scroll', () => { const box = $('#messages'); followMessages = box.scrollHeight - box.scrollTop - box.clientHeight < 60; });
$('#review-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedSnapshot) return;
  await command({ type: 'review', ...selectedSnapshot, text: $('#review-text').value });
  $('#review-text').value = '';
});
const workspaceTools = installWorkspaceTools({
  command, active, busy: () => !!state.busySession, openSnapshot,
  snapshotSelection: () => selectedSnapshot,
  renderTimeline: () => renderTimeline(active()),
  saved: () => { inspectorCacheKey = ''; refreshInspector(); workspaceTools.refreshHistory(); },
  openSearchMatch: async (selection, match, query) => {
    if (selection.sessionId !== activeId) return;
    const action = active()?.actions.find((entry) => entry.id === selection.actionId) || workspaceTools.actions.get(selection.actionId);
    if (selection.actionId && !action) throw new Error('Snapshot is no longer available. Refresh the timeline.');
    $('#search-dialog').close();
    await openSnapshot(action, match.path, { ...match, query });
  },
});
const inspectorTarget = () => ({ sessionId: activeId, ...(inspectorSelection ? { actionId: inspectorSelection } : {}), path: inspectorPath || undefined });
$('#diff-search').addEventListener('click', () => { if (active()) workspaceTools.openSearch(inspectorTarget(), 'diff'); });
$('#code-search').addEventListener('click', () => { if (active()) workspaceTools.openSearch(inspectorTarget(), 'code'); });
$('#snapshot-search').addEventListener('click', () => workspaceTools.openSearch({ ...selectedSnapshot, path: fileView?.path }, $('#code-mode').value === 'diff' ? 'diff' : 'code'));
$('#inspector-edit').addEventListener('click', () => workspaceTools.openEditor(inspectorTarget()));
$('#snapshot-edit').addEventListener('click', () => workspaceTools.openEditor({ ...selectedSnapshot, path: fileView?.path }));
const accountControls = installAccountControls({ state: () => state, active, command, openAccounts, choose: updateAccount });
selectInspectorTab(inspectorTab);
if (bridge) {
  bridge.onLogin(renderLogin);
  bridge.onPermission((request) => { permissionQueue.push(request); showPermission(); });
  bridge.onPermissionClosed((id) => {
    const index = permissionQueue.findIndex((request) => request.id === id);
    if (index < 0) return;
    permissionQueue.splice(index, 1);
    if (index === 0) { $('#permission-dialog').close(); showPermission(); }
  });
  bridge.onState(receive);
  bridge.onError(notice);
  command({ type: 'state' }).catch(() => {});
} else {
  render();
}
window.addEventListener('unhandledrejection', (event) => { event.preventDefault(); notice(event.reason); });
