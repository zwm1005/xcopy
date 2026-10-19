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
