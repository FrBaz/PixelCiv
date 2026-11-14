/**
 * Aides des tests de l'interface, sans DOM : un composant sans hook se déplie en arbre
 * d'éléments, dont on lit les textes, les attributs, les clés et les gestionnaires.
 */
import type { ComponentChildren, VNode } from 'preact';

/** Un élément de l'arbre déplié, et ce qu'on en lit. */
export type Rendered = VNode<Record<string, unknown> & { children?: ComponentChildren }>;

function isVNode(node: unknown): node is Rendered {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

/**
 * Déplie les composants de l'arbre `node` en éléments du DOM ; ceux de `opaque`, qui ont
 * des hooks (le portrait), restent tels quels.
 */
export function expand(node: unknown, opaque: readonly unknown[] = []): unknown {
  if (Array.isArray(node)) return node.map((child) => expand(child, opaque));
  if (!isVNode(node)) return node;
  if (typeof node.type === 'function') {
    if (opaque.includes(node.type)) return node;
    const component = node.type as (props: unknown) => unknown;
    return expand(component(node.props), opaque);
  }
  return { ...node, props: { ...node.props, children: expand(node.props.children, opaque) } };
}

/** Texte d'un arbre déplié, ses morceaux séparés d'une espace. */
export function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    const parts = node.map(textOf);
    return parts.filter((text) => text !== '').join(' ');
  }
  return isVNode(node) ? textOf(node.props.children) : '';
}

/** Éléments d'un arbre déplié qui vérifient `test`, dans l'ordre du document. */
export function findAll(node: unknown, test: (element: Rendered) => boolean): Rendered[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, test));
  if (!isVNode(node)) return [];
  return [...(test(node) ? [node] : []), ...findAll(node.props.children, test)];
}

/** Boutons d'un arbre déplié. */
export function buttons(node: unknown): Rendered[] {
  return findAll(node, (element) => element.type === 'button');
}

/** Appelle le gestionnaire `name` d'un élément (onClick, onKeyDown…), avec `event`. */
export function fire(element: Rendered | undefined, name: string, event: unknown = {}): void {
  const handler = element?.props[name];
  if (typeof handler !== 'function') throw new Error(`pas de ${name}`);
  (handler as (event: unknown) => void)(event);
}

/** Un document imité, pour le focus : l'élément qui l'a, et le corps de la page. */
export class FakeDocument {
  readonly body: FakeElement;
  activeElement: FakeElement;

  constructor() {
    this.body = new FakeElement(this, 'body');
    this.activeElement = this.body;
  }
}

/**
 * Un élément imité, qui prend le focus comme dans un navigateur : seulement s'il est dans
 * la page et affiché. Un élément caché (display: none) n'a pas de boîte.
 */
export class FakeElement {
  isConnected = true;
  displayed = true;
  readonly ownerDocument: FakeDocument;
  readonly name: string;

  constructor(ownerDocument: FakeDocument, name: string) {
    this.ownerDocument = ownerDocument;
    this.name = name;
  }

  focus(): void {
    if (this.isConnected && this.displayed) this.ownerDocument.activeElement = this;
  }

  getClientRects(): { readonly length: number } {
    return { length: this.isConnected && this.displayed ? 1 : 0 };
  }

  /** Le rendu retire l'élément de la page : s'il avait le focus, le corps de la page le prend. */
  remove(): void {
    this.isConnected = false;
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }
}

/** Attend l'image suivante, après le rendu : sous Node, la tâche suivante (dialog.ts). */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
