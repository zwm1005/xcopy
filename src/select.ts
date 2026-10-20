// Keep the native select as the value/event source; present one accessible combobox.
const controls = new WeakMap<HTMLSelectElement, SelectControl>();
let nextId = 0;
let openedControl: SelectControl | undefined;

export function enhanceSelect(select: HTMLSelectElement): SelectControl | undefined {
  if (typeof HTMLElement.prototype.showPopover !== 'function') {
    return undefined;
  }
  const existing = controls.get(select);
  if (existing) {
    return existing;
  }
  const control = new SelectControl(select);
  controls.set(select, control);
  return control;
}

export function syncSelect(select: HTMLSelectElement): void {
  controls.get(select)?.sync();
}

class SelectControl {
  private readonly trigger = document.createElement('button');
  private readonly value = document.createElement('span');
  private readonly menu = document.createElement('div');
  private active = -1;
  private opened = false;
  private search = '';
  private searchedAt = 0;

  constructor(private readonly select: HTMLSelectElement) {
    this.trigger.type = 'button';
    this.trigger.className = 'sc-select-trigger';
    this.trigger.setAttribute('role', 'combobox');
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.value.className = 'sc-select-value';
    const arrow = document.createElement('span');
    arrow.className = 'sc-select-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    this.trigger.append(this.value, arrow);
    this.menu.id = `sc-select-${++nextId}`;
    this.menu.className = 'sc-select-menu';
    this.menu.setAttribute('role', 'listbox');
    this.menu.setAttribute('popover', 'manual');
    this.trigger.setAttribute('aria-controls', this.menu.id);
    select.after(this.trigger);
    document.body.append(this.menu);
    select.classList.add('sc-select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    this.trigger.addEventListener('click', () => {
      if (this.opened) {
        this.close();
      } else {
        this.open();
      }
    });
    this.trigger.addEventListener('keydown', event => this.onKey(event));
    this.menu.addEventListener('mousedown', event => event.preventDefault());
    this.menu.addEventListener('click', event => {
      const option = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-select-index]') : null;
      if (option) {
        this.choose(Number(option.dataset.selectIndex));
      }
    });
    this.menu.addEventListener('beforetoggle', event => {
      if ((event as ToggleEvent).newState === 'closed') {
        this.opened = false;
        this.trigger.setAttribute('aria-expanded', 'false');
        this.trigger.removeAttribute('aria-activedescendant');
      }
    });
    document.addEventListener('focusin', event => {
      if (event.target !== this.trigger && !this.menu.contains(event.target as Node)) {
        this.close();
      }
    });
    document.addEventListener('pointerdown', event => {
      const target = event.target as Node;
      if (!this.trigger.contains(target) && !this.menu.contains(target)) {
        this.close();
      }
    });
    document.addEventListener('scroll', event => {
      if (this.opened && event.target !== this.menu) {
        this.close();
      }
    }, true);
    window.addEventListener('resize', () => this.close());
    select.addEventListener('change', () => this.sync());
    this.sync();
  }

  sync(): void {
    const activeValue = this.menu.children[this.active]?.getAttribute('data-value');
    const label = this.select.getAttribute('aria-label') || '';
    this.value.textContent = this.select.selectedOptions[0]?.textContent || '';
    this.trigger.title = this.value.textContent;
    this.trigger.disabled = this.select.disabled || !this.select.options.length;
    this.trigger.setAttribute('aria-label', label);
    this.menu.setAttribute('aria-label', label);
    this.menu.replaceChildren(...[...this.select.options].map((option, index) => {
      const row = document.createElement('div');
      row.id = `${this.menu.id}-${index}`;
      row.className = 'sc-select-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.selected));
      row.setAttribute('aria-disabled', String(option.disabled));
      row.dataset.selectIndex = String(index);
      row.dataset.value = option.value;
      row.textContent = option.text;
      return row;
    }));
    if (this.trigger.disabled) {
      this.close();
    } else if (this.opened) {
      const index = [...this.select.options].findIndex(option => option.value === activeValue && !option.disabled);
      this.activate(index >= 0 ? index : this.select.selectedIndex);
      this.position();
    }
  }

  private open(): void {
    if (this.trigger.disabled) {
      return;
    }
    this.sync();
    openedControl?.close();
    this.menu.showPopover();
    this.opened = true;
    openedControl = this;
    this.search = '';
    this.trigger.setAttribute('aria-expanded', 'true');
    this.position();
    const selected = this.select.selectedIndex;
    this.activate(selected >= 0 && !this.select.options[selected].disabled ? selected : this.enabled()[0]);
  }

  private close(): void {
    if (this.opened) {
      this.menu.hidePopover();
      openedControl = undefined;
    }
  }

  private enabled(): number[] {
    return [...this.select.options].flatMap((option, index) => option.disabled ? [] : [index]);
  }

  private activate(index: number | undefined): void {
    this.active = index ?? -1;
    for (const [position, row] of [...this.menu.children].entries()) {
      row.toggleAttribute('data-active', position === this.active);
    }
    const option = this.menu.children[this.active];
    if (option) {
      this.trigger.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else {
      this.trigger.removeAttribute('aria-activedescendant');
    }
  }

  private choose(index: number): void {
    const option = this.select.options[index];
    if (!option || option.disabled || this.select.disabled) {
      return;
    }
    const changed = this.select.selectedIndex !== index;
    this.select.selectedIndex = index;
    this.close();
    this.sync();
    this.trigger.focus({ preventScroll: true });
    if (changed) {
      this.select.dispatchEvent(new Event('input', { bubbles: true }));
      this.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  private position(): void {
    const rect = this.trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, this.select.hasAttribute('data-locale') ? 164 : 240), document.documentElement.clientWidth - 24);
    const below = innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const desired = Math.min(this.select.options.length * 40 + 12, 280);
    const upwards = below < desired && above > below;
    const height = Math.min(desired, Math.max(0, upwards ? above : below));
    const start = this.select.hasAttribute('data-locale') ? rect.right - width : rect.left;
    this.menu.style.width = `${width}px`;
    this.menu.style.maxHeight = `${height}px`;
    this.menu.style.left = `${Math.max(12, Math.min(start, document.documentElement.clientWidth - width - 12))}px`;
    this.menu.style.top = `${upwards ? rect.top - height - 6 : rect.bottom + 6}px`;
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Tab' || event.key === 'Escape') {
      if (this.opened && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      this.close();
      return;
    }
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (this.opened) {
        this.choose(this.active);
      } else {
        this.open();
      }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const wasOpen = this.opened;
      if (!wasOpen) {
        this.open();
      }
      const enabled = this.enabled();
      if (event.key === 'Home' || event.key === 'End') {
        this.activate(event.key === 'Home' ? enabled[0] : enabled.at(-1));
      } else if (wasOpen) {
        const current = enabled.indexOf(this.active);
        this.activate(enabled[Math.max(0, Math.min(enabled.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))]);
      }
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
      event.preventDefault();
      if (!this.opened) {
        this.open();
      }
      this.search = (Date.now() - this.searchedAt < 600 ? this.search : '') + event.key.toLocaleLowerCase();
      this.searchedAt = Date.now();
      const match = this.enabled().find(index => this.select.options[index].text.toLocaleLowerCase().startsWith(this.search));
      if (match !== undefined) {
        this.activate(match);
      }
    }
  }
}
