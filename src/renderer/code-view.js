// The desktop loads highlight.js and jsdiff from its own npm dependencies.
const languages = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', h: 'c', hpp: 'cpp', cs: 'csharp', html: 'xml', vue: 'xml', svg: 'xml' };

export function diffRows(view, diff = globalThis.Diff, full = false) {
  const before = view.before || '';
  const after = view.after || '';
  if (before.includes('\0') || after.includes('\0') || /^Binary files |^GIT binary patch/m.test(view.diff || '')) return { rows: [], message: 'Binary file changed. Open Files to inspect other files.' };
  let patch;
  if (!full && /^@@ /m.test(view.diff || '')) {
    try { patch = diff.parsePatch(view.diff)[0]; } catch { /* Fall back to the preserved file contents. */ }
  }
  if (!patch) patch = diff.structuredPatch(view.path || '', view.path || '', before, after, undefined, undefined, { context: full ? Infinity : 3, timeout: 100 });
  if (!patch) return { rows: [], message: 'Diff is too large to display. Use the full Before and After views.' };
  const rows = [];
  if (full && !patch.hunks.length && after) return { rows: after.replace(/\n$/, '').split('\n').map((text, index) => ({ kind: 'context', text, oldLine: index + 1, newLine: index + 1 })), message: '' };
  for (const [index, hunk] of patch.hunks.entries()) {
    if (index || hunk.oldStart > 1 || hunk.newStart > 1) rows.push({ kind: 'gap', text: 'Unchanged lines' });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const sign = line[0];
      if (sign === '\\') { rows.push({ kind: 'note', text: 'No newline at end of file' }); continue; }
      rows.push({ kind: sign === '+' ? 'added' : sign === '-' ? 'removed' : 'context', text: line.slice(1), oldLine: sign === '+' ? undefined : oldLine++, newLine: sign === '-' ? undefined : newLine++ });
    }
  }
  return { rows, message: rows.length ? '' : view.diff ? 'No text changes. File permissions or file metadata changed.' : 'No code changes in this file.' };
}

function highlightedLines(text, path) {
  const plain = () => text.split('\n').map((line) => [{ text: line, classes: '' }]);
  const extension = path.split('.').at(-1).toLowerCase();
  const language = languages[extension] || (path.split('/').at(-1).toLowerCase() === 'dockerfile' ? 'dockerfile' : extension);
  if (!globalThis.hljs?.getLanguage(language) || text.length > 250_000) return plain();
  try {
    const html = globalThis.hljs.highlight(text, { language, ignoreIllegals: true }).value;
    // Only read token text and span classes from the highlighter. Source HTML
    // never enters the live document, even when viewing untrusted code.
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const lines = [[]];
    const visit = (element, classes = '') => {
      if (element.nodeType === 3) {
        element.textContent.split('\n').forEach((part, index) => {
          if (index) lines.push([]);
          if (part) lines.at(-1).push({ text: part, classes });
        });
      } else {
        const own = element.tagName === 'SPAN' ? [...element.classList].filter((name) => /^[\w-]+$/.test(name)).join(' ') : '';
        for (const child of element.childNodes) visit(child, `${classes} ${own}`.trim());
      }
    };
    visit(parsed.body);
    return lines;
  } catch { return plain(); }
}

const preparedViews = new WeakMap();
export function renderCode(container, view, mode = 'diff', options = {}) {
  container.replaceChildren();
  container.classList.add('code-view');
  const isDiff = mode === 'diff' || mode === 'context';
  container.classList.toggle('diff-view', isDiff);
  let prepared = preparedViews.get(view);
  if (!prepared) { prepared = {}; preparedViews.set(view, prepared); }
  let rows;
  if (isDiff) {
    const result = prepared[mode] || (prepared[mode] = diffRows(view, globalThis.Diff, mode === 'context'));
    rows = result.rows;
    if (!rows.length) { container.textContent = result.message; return; }
  } else {
    const text = view[mode] || '';
    if (!text || text.includes('\0')) { container.textContent = text ? 'Binary file preserved in snapshot.' : 'File absent or empty in this version.'; return; }
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    rows = lines.map((text, index) => ({ kind: 'context', text, [mode === 'before' ? 'oldLine' : 'newLine']: index + 1 }));
  }
  const before = prepared.before || (prepared.before = highlightedLines(view.before || '', view.path || ''));
  const after = prepared.after || (prepared.after = highlightedLines(view.after || '', view.path || ''));
  const shown = options.limit ? rows.slice(0, options.limit) : rows;
  const fragment = document.createDocumentFragment();
  for (const row of shown) {
    const line = document.createElement('span');
    line.className = `code-line ${row.kind}`;
    if (row.oldLine) line.dataset.oldLine = row.oldLine;
    if (row.newLine) line.dataset.newLine = row.newLine;
    if (['gap', 'note'].includes(row.kind)) line.textContent = row.text;
    else {
      for (const number of isDiff ? [row.oldLine, row.newLine] : [row.oldLine || row.newLine]) {
        const gutter = document.createElement('span');
        gutter.className = 'line-number';
        gutter.textContent = number ?? '';
        line.append(gutter);
      }
      if (isDiff) {
        const marker = document.createElement('span');
        marker.className = 'diff-marker';
        marker.textContent = row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' ';
        line.append(marker);
      }
      const content = document.createElement('span');
      content.className = 'code-text';
      const tokens = row.newLine ? after[row.newLine - 1] : before[row.oldLine - 1];
      for (const token of tokens || [{ text: row.text, classes: '' }]) {
        const span = document.createElement('span');
        span.className = token.classes;
        span.textContent = token.text;
        content.append(span);
      }
      line.append(content);
      if ((mode === 'after' || mode === 'context') && row.newLine && view.origins?.[row.newLine - 1]) options.attachOrigin?.(line, view.origins[row.newLine - 1]);
      if (options.query && row.text.toLowerCase().includes(options.query.toLowerCase())) line.classList.add('search-match');
    }
    fragment.append(line);
  }
  if (shown.length < rows.length) {
    const more = document.createElement('span');
    more.className = 'code-line gap';
    more.textContent = `${rows.length - shown.length} more lines · Open file to view all`;
    fragment.append(more);
  }
  container.append(fragment);
  if (mode === 'context' && !options.query) container.querySelector('.added, .removed')?.scrollIntoView({ block: 'start' });
}
