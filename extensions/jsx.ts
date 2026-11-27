import type { JSXNode } from '@oh-my-pi/pi-tui';
import { jsx, type JSX as PiJSX } from '@oh-my-pi/pi-tui/jsx-runtime';

// Compiled omp 19.2 routes only imports written in the source to its own pi-tui, not the runtime import
// that jsxImportSource injects. So .tsx files use this classic factory: pragmas jsxRuntime classic, jsx h.
// Bun reads those pragmas from every comment in a .tsx file, so never write them anywhere else.
export function h(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: JSXNode[]
): JSXNode {
  return jsx(
    type as never,
    {
      ...props,
      children: children.length === 1 ? children[0] : children,
    } as never,
  );
}

export declare namespace h {
  namespace JSX {
    type Element = PiJSX.Element;
    type ElementType = PiJSX.ElementType;
    type ElementChildrenAttribute = PiJSX.ElementChildrenAttribute;
    type IntrinsicAttributes = PiJSX.IntrinsicAttributes;
    type IntrinsicElements = PiJSX.IntrinsicElements;
  }
}
