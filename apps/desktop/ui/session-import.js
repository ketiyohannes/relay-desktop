const $ = (selector) => document.querySelector(selector);
const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; };

export function installSessionImport(api) {
  let items = [], selected, preview, request = 0, loading = false;
  const dialog = $('#import-dialog');
  const render = () => {
    const query = $('#import-search').value.trim().toLowerCase();
    const list = $('#import-sessions'); list.replaceChildren();
    for (const item of items.filter((item) => `${item.name} ${item.project} ${item.sessionId}`.toLowerCase().includes(query))) {
      const row = text('button', '', `import-session${selected?.id === item.id ? ' selected' : ''}`); row.type = 'button';
      row.setAttribute('aria-pressed', String(selected?.id === item.id));
      row.append(text('strong', item.name), text('small', item.project || 'No project recorded'), text('small', `${new Date(item.updated).toLocaleString()}${item.importedSessionId ? ' · Imported' : ''}`));
      row.addEventListener('click', () => choose(item)); list.append(row);
    }
    if (!list.children.length) list.append(text('p', loading ? 'Loading sessions…' : 'No matching sessions.', 'muted'));
    $('#import-confirm').disabled = !preview || loading || api.busy();
    $('#import-confirm').textContent = selected?.importedSessionId ? 'Open in Relay' : 'Import session';
  };
  const choose = async (item) => {
    const token = ++request; selected = item; preview = undefined; render();
    $('#import-preview').textContent = 'Reading conversation…'; $('#import-warnings').textContent = '';
    $('#import-project').value = item.project;
    try {
      const result = await api.command({ type: 'external_preview', sourceId: item.id });
      if (token !== request || !dialog.open) return;
      preview = result;
      $('#import-project').value = result.source.project;
      $('#import-warnings').textContent = result.warnings.join(' ');
      api.renderConversation(result, $('#import-preview'));
    } catch (error) { if (token === request) $('#import-preview').textContent = error.message; }
    finally { if (token === request) render(); }
  };
  const load = async () => {
    const token = ++request; selected = undefined; preview = undefined; items = []; loading = true;
    $('#import-load').disabled = true; $('#import-status').textContent = 'Reading local sessions…';
    $('#import-preview').textContent = 'Select a session to preview its conversation.'; $('#import-warnings').textContent = ''; render();
    try {
      const result = await api.command({ type: 'external_sessions', provider: $('#import-provider').value, path: $('#import-path').value.trim() || undefined });
      if (token !== request || !dialog.open) return;
      items = result.items;
      $('#import-status').textContent = `${items.length} sessions · ${result.path}${result.warnings.length ? '\n' + result.warnings.join('\n') : ''}`;
    } catch (error) { if (token === request) $('#import-status').textContent = error.message; }
    finally { if (token === request) { loading = false; $('#import-load').disabled = false; render(); } }
  };
  $('#import-button').addEventListener('click', () => {
    $('#import-profiles').replaceChildren();
    for (const account of api.state().accounts) if (account.configDir) $('#import-profiles').append(new Option(account.name, account.configDir));
    dialog.showModal(); load();
  });
  $('#import-provider').addEventListener('change', () => { $('#import-path').value = ''; load(); });
  $('#import-load').addEventListener('click', load);
  $('#import-path').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); load(); } });
  $('#import-search').addEventListener('input', render);
  $('#import-folder').addEventListener('click', () => api.browse('import', $('#import-project').value || undefined));
  $('#import-confirm').addEventListener('click', async () => {
    if (!preview || !selected) return;
    const source = selected;
    $('#import-confirm').disabled = true;
    try {
      const project = $('#import-project').value.trim();
      const result = source.importedSessionId ? { importedSessionId: source.importedSessionId } : await api.command({ type: 'import_session', sourceId: source.id, ...(project && project !== preview.source.project ? { project } : {}) });
      await api.command({ type: 'state' });
      dialog.close(); api.selectSession(result.importedSessionId);
    } catch (error) { $('#import-warnings').textContent = error.message; }
    finally { render(); }
  });
  dialog.addEventListener('close', () => { request++; loading = false; $('#import-load').disabled = false; });
}
