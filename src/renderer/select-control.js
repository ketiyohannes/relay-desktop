/** Themed menus backed by existing select values and events. */
export function installThemedSelects() {
  const controls = [];
  for (const select of document.querySelectorAll('select[data-themed-select]')) {
    const wrapper = document.createElement('span'); wrapper.className = 'themed-select';
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'select-trigger';
    const value = document.createElement('span');
    const caret = document.createElement('span'); caret.className = 'icon icon-caret-right dropdown-caret'; caret.setAttribute('aria-hidden', 'true');
    trigger.append(value, caret);
    const menu = document.createElement('div'); menu.className = 'select-menu'; menu.id = `${select.id}-menu`; menu.popover = 'auto';
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', select.getAttribute('aria-label') || 'Options');
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', menu.id);
    const refresh = () => {
      value.textContent = select.selectedOptions[0]?.textContent || 'Select';
      trigger.disabled = select.disabled;
      trigger.setAttribute('aria-label', `${select.getAttribute('aria-label') || 'Select'}: ${value.textContent}`);
      for (const option of menu.children) option.setAttribute('aria-selected', String(option.dataset.value === select.value));
    };
    const position = () => {
      const box = trigger.getBoundingClientRect();
      menu.style.minWidth = `${Math.max(box.width, 170)}px`;
      menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${box.bottom + menu.offsetHeight + 8 > window.innerHeight ? Math.max(8, box.top - menu.offsetHeight - 6) : box.bottom + 6}px`;
    };
    const open = () => {
      menu.showPopover(); position();
      (menu.querySelector('[aria-selected="true"]') || menu.firstChild)?.focus();
    };
    for (const option of select.options) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'select-option'; button.textContent = option.textContent; button.dataset.value = option.value;
      const mark = document.createElement('span'); mark.className = 'icon icon-check-circle'; mark.setAttribute('aria-hidden', 'true'); button.append(mark);
      button.setAttribute('role', 'option'); button.disabled = option.disabled;
      button.addEventListener('click', () => { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); refresh(); menu.hidePopover(); trigger.focus(); });
      button.addEventListener('keydown', (event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const options = [...menu.querySelectorAll('button:not(:disabled)')];
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (options.indexOf(button) + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[index]?.focus();
      });
      menu.append(button);
    }
    trigger.addEventListener('click', () => { if (menu.matches(':popover-open')) menu.hidePopover(); else open(); });
    trigger.addEventListener('keydown', (event) => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } });
    menu.addEventListener('toggle', (event) => trigger.setAttribute('aria-expanded', String(event.newState === 'open')));
    select.after(wrapper); wrapper.append(trigger, menu); select.hidden = true;
    select.addEventListener('change', refresh);
    window.addEventListener('resize', () => { if (menu.matches(':popover-open')) position(); });
    controls.push(refresh); refresh();
  }
  window.addEventListener('relay-select-refresh', () => { for (const refresh of controls) refresh(); });
}
