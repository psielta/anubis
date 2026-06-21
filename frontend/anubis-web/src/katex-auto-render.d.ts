// KaTeX ships this subpath as ESM but without bundled type declarations; declare
// a minimal type so the lazy `import('katex/contrib/auto-render')` type-checks.
declare module 'katex/contrib/auto-render' {
  interface KatexAutoRenderDelimiter {
    left: string;
    right: string;
    display: boolean;
  }
  interface KatexAutoRenderOptions {
    delimiters?: KatexAutoRenderDelimiter[];
    throwOnError?: boolean;
    [key: string]: unknown;
  }
  const renderMathInElement: (element: HTMLElement, options?: KatexAutoRenderOptions) => void;
  export default renderMathInElement;
}
