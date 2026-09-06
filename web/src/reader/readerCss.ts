import type { ReaderSettings } from "./settings";

/**
 * CSS injected into each section document by the paginator via `setStyles`.
 * Uses concrete values because CSS custom properties do not cross iframe
 * boundaries.
 */
export function readerCss({
  fontSize,
  lineHeight,
  margin,
  theme,
}: ReaderSettings): string {
  const dark = theme === "dark";
  const sepia = theme === "sepia";
  const foreground = dark ? "#d8d3cc" : sepia ? "#3b3229" : "#1f2328";
  const background = dark ? "#14161a" : sepia ? "#f2e8d5" : "#fbfaf7";
  const link = dark ? "lightblue" : "#3b5bdb";
  return `
:root {
  color-scheme: ${dark ? "dark" : "light"};
}
html {
  background: ${background};
  color: ${foreground};
}
body {
  margin: 0;
  padding: 0 ${margin}px;
  font-size: ${fontSize}px;
  line-height: ${lineHeight};
  overflow-wrap: break-word;
}
p, li, blockquote, dd {
  line-height: ${lineHeight};
  margin: 0 0 0.9em 0;
  text-align: justify;
}
h1, h2, h3, h4 {
  line-height: 1.35;
  margin: 1em 0 0.5em 0;
}
h1 { font-size: 1.4em; }
h2 { font-size: 1.2em; }
h3 { font-size: 1.05em; }
a:link { color: ${link}; }
img, svg, video {
  max-width: 100%;
  height: auto;
}
pre {
  white-space: pre-wrap !important;
}
`;
}
