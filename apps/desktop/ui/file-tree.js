export function buildTree(paths) {
  const root = { children: new Map() };
  for (const path of paths) {
    let parent = root;
    const parts = path.split('/');
    parts.forEach((name, index) => {
      if (!parent.children.has(name)) parent.children.set(name, { name, path: parts.slice(0, index + 1).join('/'), children: new Map() });
      parent = parent.children.get(name);
      if (index === parts.length - 1) parent.file = true;
    });
  }
  return root;
}

const states = new WeakMap();
export function renderFileTree(container, options) {
  let state = states.get(container);
  if (!state) { state = { expanded: new Set(), collapsed: new Set() }; states.set(container, state); }
  state.options = options;
  const expansion = options.expansion || state;
  const query = (options.query || '').toLowerCase();
  const paths = options.files.filter((path) => (!options.changedOnly || options.changed.includes(path)) && path.toLowerCase().includes(query));
  const root = buildTree(paths);
  container.replaceChildren();
  container.classList.add('file-tree');
  const visit = (parent, target, depth) => {
    const sorted = [...parent.children.values()].sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (entry.file) {
        const row = document.createElement('button');
        row.type = 'button'; row.dataset.path = entry.path; row.title = entry.path;
        row.className = `${options.changed.includes(entry.path) ? 'changed ' : ''}${options.selected === entry.path ? 'selected' : ''}`;
        row.setAttribute('aria-current', options.selected === entry.path ? 'true' : 'false');
        const icon = document.createElement('span'); icon.className = 'icon icon-code'; icon.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span'); name.className = 'tree-name'; name.textContent = entry.name;
        row.append(icon, name);
        const orders = options.orders?.[entry.path];
        if (orders?.length) { const badge = document.createElement('small'); badge.textContent = orders.map((order) => `Δ${order}`).join(', '); badge.title = 'Recorded changes touching this file'; row.append(badge); }
        if (options.changed.includes(entry.path)) { const badge = document.createElement('small'); badge.textContent = options.deleted?.includes(entry.path) ? 'D' : 'M'; badge.title = badge.textContent === 'D' ? 'Deleted' : 'Changed'; row.append(badge); }
        row.addEventListener('click', () => options.select(entry.path));
        target.append(row);
      } else {
        const folder = document.createElement('details'); folder.dataset.folder = entry.path;
        folder.open = !!query || expansion.expanded.has(entry.path) || (!expansion.collapsed.has(entry.path) && (depth < 1 || options.selected?.startsWith(`${entry.path}/`)));
        const summary = document.createElement('summary');
        const icon = document.createElement('span'); icon.className = 'icon icon-folder-open'; icon.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span'); name.className = 'tree-name'; name.textContent = entry.name;
        summary.title = entry.path;
        summary.append(icon, name);
        summary.addEventListener('click', () => {
          (folder.open ? expansion.collapsed : expansion.expanded).add(entry.path);
          (folder.open ? expansion.expanded : expansion.collapsed).delete(entry.path);
        });
        const children = document.createElement('div'); children.className = 'tree-children';
        visit(entry, children, depth + 1); folder.append(summary, children); target.append(folder);
      }
    }
  };
  visit(root, container, 0);
  if (!paths.length) { const empty = document.createElement('p'); empty.className = 'empty-timeline'; empty.textContent = query ? 'No matching files.' : 'No files to show.'; container.append(empty); }
}
export function updateFileTree(container, changes) {
  const state = states.get(container);
  if (state) renderFileTree(container, { ...state.options, ...changes });
}
