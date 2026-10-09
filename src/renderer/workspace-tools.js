import { renderCode } from './code-view.js';

const $ = (selector) => document.querySelector(selector);
const element = (tag, text, className = '') => { const item = document.createElement(tag); item.textContent = text; item.className = className; return item; };
const button = (text, click, className = '') => { const item = element('button', text, className); item.type = 'button'; item.addEventListener('click', click); return item; };

export function installWorkspaceTools(api) {
  let searchRequest = 0;
  let searchTimer;
  let searchSelection;
  let matches = [];
  let matchIndex = -1;
  let editor;
  let saving = false;
  let editorRequest = 0;
  let historyRequest = 0;
  let history;
  let historySession;
  const timelineSupport = new Map();
  const timelineChecks = new Map();
  let timelineChanging = false;
  let timelineError;
  const actions = new Map();
  const expanded = new Set();
  const timelineNotice = element('p', '', 'empty-timeline');
  timelineNotice.hidden = true;
  $('#timeline-controls').after(timelineNotice);

  const timelineEnabled = () => {
    const session = api.active();
    const supported = api.state().timelineAvailability?.[session?.project] ?? timelineSupport.get(session?.project);
    return !!session && !session.externalSource && supported === true && !!session.timelineEnabled;
  };
  const renderTimelineStatus = () => {
    const session = api.active();
    const project = session?.project;
    const supported = api.state().timelineAvailability?.[project] ?? timelineSupport.get(project);
    const enabled = timelineEnabled();
    const projectHistory = $('#timeline-source').value === 'project';
    $('#timeline-empty').hidden = enabled;
    $('#timeline-controls').hidden = !enabled;
    $('#timeline-search').hidden = !enabled;
    $('#actions').hidden = !enabled || projectHistory;
    $('#project-history').hidden = !enabled || !projectHistory;
    $('#timeline-import').hidden = !project || !!session.externalSource || supported !== true || enabled;
    $('#timeline-import').disabled = timelineChanging || api.busy();
    $('#timeline-disable').disabled = timelineChanging || api.busy();
    $('#timeline-availability').textContent = !project ? 'Open a project to view its timeline.' : session.externalSource ? 'Open this conversation to check timeline support.' : supported === false ? 'Timeline is not supported for this project.' : supported === undefined ? 'Checking timeline support…' : 'Timeline is optional. Import recorded changes for this session and record future changes.';
    if (historySession !== session?.id) {
      $('#timeline-source').value = 'session';
      $('#actions').hidden = !enabled;
      $('#project-history').hidden = true;
      timelineError = undefined;
      historyRequest++; historySession = session?.id; history = undefined; actions.clear();
      $('#history-events').replaceChildren(); $('#history-status').textContent = '';
    }
    timelineNotice.hidden = !enabled || $('#timeline-source').value !== 'session' || (!session.timelineImportTruncated && session.actions.some((action) => action.kind === 'checkpoint' && action.files?.length));
    timelineNotice.textContent = session?.timelineImportTruncated ? 'Showing up to 2,001 recent recorded entries for this session.' : 'No recorded changes for this session. Future file changes will appear here.';
    if (timelineError && timelineError.sessionId === session?.id) $('#timeline-availability').textContent = timelineError.message;
    if (project && !session.externalSource && supported === undefined && !timelineChecks.has(project)) {
      const check = api.command({ type: 'timeline_status', sessionId: session.id }, { silent: true }).then((result) => {
        timelineSupport.set(project, result.timeline.supported);
      }).catch(() => { timelineSupport.set(project, false); }).finally(() => {
        timelineChecks.delete(project); renderTimelineStatus(); api.renderTimeline(); refreshHistory();
      });
      timelineChecks.set(project, check);
    }
  };
  const changeTimeline = async (enabled) => {
    const session = api.active();
    if (!session || timelineChanging) return;
    timelineChanging = true; renderTimelineStatus();
    timelineError = undefined;
    try {
      const result = await api.command({ type: 'timeline_enable', sessionId: session.id, enabled }, { silent: true });
      timelineSupport.set(session.project, result.timeline.supported);
      if (api.active()?.id === session.id) {
        if (enabled && result.timeline.supported) $('#timeline-source').value = 'session';
        historyRequest++; history = undefined; actions.clear();
        $('#history-events').replaceChildren(); $('#history-status').textContent = '';
      }
    } catch {
      timelineError = { sessionId: session.id, message: 'Could not change timeline settings. Stop any active run and try again.' };
    } finally {
      timelineChanging = false; renderTimelineStatus(); api.renderTimeline(); refreshHistory(true);
    }
  };
  $('#timeline-import').addEventListener('click', () => changeTimeline(true));
  $('#timeline-disable').addEventListener('click', () => changeTimeline(false));

  const openMatch = async (index) => {
    if (!matches.length) return;
    matchIndex = (index + matches.length) % matches.length;
    const match = matches[matchIndex];
    $('#search-count').textContent = `${matchIndex + 1} / ${matches.length}`;
    for (const [i, item] of [...$('#search-results').children].entries()) item.classList.toggle('selected', i === matchIndex);
    await api.openSearchMatch(searchSelection, match, $('#code-search-query').value, $('#code-search-scope').value);
  };
  const search = async () => {
    const request = ++searchRequest;
    const query = $('#code-search-query').value;
    matches = []; matchIndex = -1;
    $('#search-results').replaceChildren();
    $('#search-count').textContent = query ? 'Searching…' : '';
    $('#search-prev').disabled = $('#search-next').disabled = true;
    if (!query || !searchSelection) return;
    const { path, ...selection } = searchSelection;
    try {
      const result = await api.command({ type: 'search_code', ...selection, query, scope: $('#code-search-scope').value, ...($('#code-search-files').value === 'file' && path ? { path } : {}) });
      if (request !== searchRequest) return;
      matches = result.matches;
      $('#search-count').textContent = `${matches.length} matching lines${result.truncated ? ' · search limit reached' : ''}${result.skipped ? ` · ${result.skipped} files skipped` : ''}`;
      matches.forEach((match, index) => {
        const row = button('', () => openMatch(index), `search-result ${match.kind}`);
        row.append(element('strong', `${match.path}:${match.line} · ${match.side === 'before' ? 'before' : 'after'}`), element('span', match.text));
        $('#search-results').append(row);
      });
      $('#search-prev').disabled = $('#search-next').disabled = !matches.length;
    } catch (error) { if (request === searchRequest) $('#search-count').textContent = error.message; }
  };
  const openSearch = (selection, scope) => {
    searchRequest++; searchSelection = selection;
    $('#code-search-scope').value = scope;
    $('#code-search-files').value = 'all';
    $('#search-target').textContent = selection.actionId ? 'Selected snapshot' : 'Working tree';
    if (!$('#search-dialog').open) $('#search-dialog').showModal();
    $('#code-search-query').focus(); search();
  };
  $('#code-search-query').addEventListener('input', () => { searchRequest++; clearTimeout(searchTimer); searchTimer = setTimeout(search, 200); });
  for (const id of ['#code-search-scope', '#code-search-files']) $(id).addEventListener('change', search);
  $('#search-prev').addEventListener('click', () => openMatch(matchIndex - 1));
  $('#search-next').addEventListener('click', () => openMatch(matchIndex + 1));
  $('#search-dialog').addEventListener('close', () => { searchRequest++; clearTimeout(searchTimer); });

  const editorStatus = () => {
    const dirty = editor && $('#editor-text').value !== editor.display;
    $('#editor-status').textContent = saving ? 'Saving…' : dirty ? 'Unsaved changes' : editor?.warning || 'Saved on disk';
    $('#editor-save').disabled = !dirty || saving || api.busy();
    $('#editor-reload').disabled = saving;
  };
  const loadEditor = async (selection) => {
    const request = ++editorRequest;
    $('#editor-status').textContent = 'Loading current file…';
    $('#editor-save').disabled = true;
    $('#editor-text').disabled = true;
    try {
      const file = await api.command({ type: 'editor_read', ...selection });
      if (request !== editorRequest) return;
      editor = { ...file, sessionId: selection.sessionId };
      $('#editor-path').textContent = file.path;
      $('#editor-text').value = file.content;
      editor.display = $('#editor-text').value;
      $('#editor-text').disabled = false;
      $('#editor-preview').hidden = true; $('#editor-text').hidden = false;
      $('#editor-preview-toggle').textContent = 'Preview';
      editorStatus(); $('#editor-text').focus();
    } catch (error) { if (request === editorRequest) $('#editor-status').textContent = error.message; }
  };
  const openEditor = (selection) => {
    if (!selection?.path) return;
    editor = undefined;
    $('#editor-path').textContent = selection.path;
    $('#editor-text').value = '';
    $('#editor-dialog').showModal();
    loadEditor(selection);
  };
  $('#editor-text').addEventListener('input', editorStatus);
  $('#editor-preview-toggle').addEventListener('click', () => {
    if (!editor) return;
    const preview = $('#editor-preview').hidden;
    $('#editor-preview').hidden = !preview; $('#editor-text').hidden = preview;
    $('#editor-preview-toggle').textContent = preview ? 'Edit' : 'Preview';
    if (preview) renderCode($('#editor-preview'), { path: editor.path, after: $('#editor-text').value }, 'after');
  });
  const closeEditor = () => {
    if (saving) return;
    if (editor && $('#editor-text').value !== editor.display) { $('#editor-discard').hidden = false; return; }
    $('#editor-dialog').close();
  };
  $('#editor-close').addEventListener('click', closeEditor);
  $('#editor-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });
  $('#editor-keep').addEventListener('click', () => { $('#editor-discard').hidden = true; });
  $('#editor-discard-confirm').addEventListener('click', () => { $('#editor-dialog').close(); });
  $('#editor-dialog').addEventListener('close', () => { editorRequest++; editor = undefined; $('#editor-discard').hidden = true; });
  $('#editor-reload').addEventListener('click', () => {
    if (!editor) return;
    if ($('#editor-text').value !== editor.display) { $('#editor-status').textContent = 'Your draft is unsaved. Copy it before reloading, or discard and reopen this file.'; return; }
    loadEditor({ sessionId: editor.sessionId, path: editor.path });
  });
  $('#editor-save').addEventListener('click', async () => {
    if (!editor || saving) return;
    saving = true; editorStatus(); $('#editor-text').disabled = true;
    try {
      const content = editor.content.includes('\r\n') ? $('#editor-text').value.replace(/\r?\n/g, '\r\n') : $('#editor-text').value;
      const file = await api.command({ type: 'editor_save', sessionId: editor.sessionId, path: editor.path, expected: editor.content, content });
      editor = { ...editor, ...file, display: $('#editor-text').value };
      api.saved();
      saving = false; editorStatus();
    } catch (error) { saving = false; editorStatus(); $('#editor-status').textContent = error.message; }
    finally { $('#editor-text').disabled = false; }
  });

  const renderHistory = () => {
    const container = $('#history-events');
    container.replaceChildren();
    const query = $('#timeline-search').value.toLowerCase();
    for (const group of history?.groups || []) {
      const wholeGroup = group.text.toLowerCase().includes(query);
      const events = group.events.filter((action, index) => wholeGroup || `${index + 1} ${action.text}`.toLowerCase().includes(query));
      if (!wholeGroup && !events.length) continue;
      const details = element('details', '', 'history-group');
      details.open = !!query || group.id === 'wip' || expanded.has(group.id);
      const summary = element('summary', group.text);
      summary.addEventListener('click', () => { if (details.open) expanded.delete(group.id); else expanded.add(group.id); });
      details.append(summary);
      details.append(button(group.action ? 'View commit changes' : 'Working tree', () => api.openSnapshot(group.action), 'history-event'));
      for (const action of events) {
        const index = group.events.indexOf(action) + 1;
        details.append(button(`Δ${index} · ${action.text}`, () => api.openSnapshot(action), 'history-event'));
      }
      container.append(details);
    }
    if (!container.children.length) container.append(element('p', history?.message || 'No matching history.', 'empty-timeline'));
    $('#history-status').textContent = history?.truncated ? 'Showing up to 2,001 recent entries per history source.' : '';
  };
  const refreshHistory = async (force = false) => {
    const session = api.active();
    if (!timelineEnabled() || $('#timeline-source').value !== 'project' || (!force && (document.hidden || $('#view-timeline').hidden || $('#inspector').hidden))) return;
    const request = ++historyRequest;
    if (historySession !== session.id) { history = undefined; historySession = session.id; actions.clear(); $('#history-events').textContent = 'Loading project history…'; }
    try {
      const result = await api.command({ type: 'history', sessionId: session.id }, { silent: true });
      if (request !== historyRequest || api.active()?.id !== session.id || !timelineEnabled()) return;
      if (JSON.stringify(result) === JSON.stringify(history)) return;
      history = result; actions.clear();
      for (const group of history.groups) for (const action of [...(group.action ? [group.action] : []), ...group.events]) actions.set(action.id, action);
      renderHistory();
    } catch { if (request === historyRequest) $('#history-status').textContent = 'Timeline is unavailable for this project.'; }
  };
  $('#timeline-source').addEventListener('change', () => {
    renderTimelineStatus();
    refreshHistory(true);
  });
  $('#history-refresh').addEventListener('click', () => refreshHistory(true));
  $('#timeline-search').addEventListener('input', () => { api.renderTimeline(); renderHistory(); });
  setInterval(refreshHistory, 4000);
  const snapshotPosition = () => {
    const selection = api.snapshotSelection();
    const list = selection?.actionId?.startsWith('history:') ? [...actions.values()] : api.active()?.actions.filter((action) => action.kind === 'checkpoint' && action.files?.length) || [];
    const index = list.findIndex((action) => action.id === selection?.actionId);
    return { list, index };
  };
  const updateNavigation = () => {
    const { list, index } = snapshotPosition();
    $('#snapshot-prev').disabled = index <= 0;
    $('#snapshot-next').disabled = index < 0 || index >= list.length - 1;
  };
  const moveSnapshot = (offset) => {
    const { list, index } = snapshotPosition();
    if (index >= 0 && list[index + offset]) api.openSnapshot(list[index + offset]);
  };
  $('#snapshot-prev').addEventListener('click', () => moveSnapshot(-1));
  $('#snapshot-next').addEventListener('click', () => moveSnapshot(1));
  return { openSearch, openEditor, actions, refreshHistory, renderTimelineStatus, timelineEnabled, editorStatus, updateNavigation };
}
