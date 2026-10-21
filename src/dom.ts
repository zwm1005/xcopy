export function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) {
    throw new Error(`Required UI element missing: ${selector}`);
  }
  return node;
}
export function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}
export function errorValue(value: unknown): Error & { code?: string } {
  return value instanceof Error ? value : new Error(String(value));
}

export function text(node: Node, value: string) {
  if (node.textContent !== value) {
    node.textContent = value;
  }
}

/** Reconcile ordered records without detaching unchanged nodes or their focus. */
export function reconcileChildren(parent: HTMLElement, children: HTMLElement[]) {
  const retained = new Set(children);
  for (const child of [...parent.children]) {
    if (!retained.has(child as HTMLElement)) {
      child.remove();
    }
  }
  let next: ChildNode | null = parent.firstChild;
  for (const child of children) {
    if (child !== next) {
      parent.insertBefore(child, next);
    }
    next = child.nextSibling;
  }
}

export class ViewCache {
  private entries = new Map<string, { inputs: unknown[]; node: HTMLElement }>();
  get(key: string, inputs: unknown[], build: () => HTMLElement): HTMLElement {
    const cached = this.entries.get(key);
    if (cached && inputs.length === cached.inputs.length && inputs.every((value, index) => Object.is(value, cached.inputs[index]))) {
      return cached.node;
    }
    const node = build();
    this.entries.set(key, { inputs, node });
    return node;
  }
  prune(keys: Set<string>) {
    for (const key of this.entries.keys()) {
      if (!keys.has(key)) {
        this.entries.delete(key);
      }
    }
  }
}
