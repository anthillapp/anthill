import "@testing-library/jest-dom/vitest";

/**
 * jsdom shims required by @xyflow/react. React Flow measures nodes with a
 * ResizeObserver and uses DOMMatrix/getBBox for the viewport transform; jsdom
 * implements none of them.
 *
 * Known limitation: because jsdom has no layout, React Flow never gets real node
 * measurements, so it renders node elements but not the SVG edge paths between
 * them. Edge behaviour is therefore tested at the document level
 * (`document.test.ts`), not through the DOM.
 */

/**
 * jsdom has no `PointerEvent`, so Testing Library's `fireEvent.pointerDown`
 * falls back to a bare `Event` and silently drops `clientX`/`clientY`. Anything
 * that reads pointer coordinates then sees `undefined` and quietly computes
 * `NaN` — which a test can easily assert its way past. Extending `MouseEvent`
 * gives pointer events the coordinates they carry in a browser.
 */
class PointerEventMock extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyMock {
  m22 = 1;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
    if (scale) this.m22 = Number(scale);
  }
}

globalThis.PointerEvent ??= PointerEventMock as unknown as typeof PointerEvent;
globalThis.ResizeObserver ??=
  ResizeObserverMock as unknown as typeof ResizeObserver;
(globalThis as Record<string, unknown>).DOMMatrixReadOnly ??=
  DOMMatrixReadOnlyMock;

Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetHeight: {
    get() {
      return Number.parseFloat(this.style?.height) || 40;
    },
    configurable: true,
  },
  offsetWidth: {
    get() {
      return Number.parseFloat(this.style?.width) || 150;
    },
    configurable: true,
  },
});

(globalThis.SVGElement as unknown as { prototype: Record<string, unknown> })
  .prototype.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 });
