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
  /* Keep the reading face local so offline books never depend on a remote font request. */
  font-family: "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "Source Han Serif", "STSong", "Songti SC", "SimSun", "NSimSun", Georgia, serif;
  font-size: ${fontSize}px !important;
  line-height: ${lineHeight};
  overflow-wrap: break-word;
}
/* A number of books carry fixed inline sizes on every paragraph. Override
   those values while retaining the semantic heading scale below. */
body :where(p, li, blockquote, dd, dt, div, span, section, article, pre, code) {
  font-size: inherit !important;
}
body p[style*="font-size"],
body li[style*="font-size"],
body blockquote[style*="font-size"],
body dd[style*="font-size"],
body dt[style*="font-size"],
body div[style*="font-size"],
body span[style*="font-size"],
body section[style*="font-size"],
body article[style*="font-size"],
body pre[style*="font-size"],
body code[style*="font-size"] {
  font-size: inherit !important;
}
p, li, blockquote, dd {
  font-size: 1em !important;
  line-height: ${lineHeight};
  margin: 0 0 0.9em 0;
  text-align: justify;
}
h1, h2, h3, h4 {
  font-family: inherit;
  font-weight: 650;
  line-height: 1.35;
  margin: 1em 0 0.5em 0;
}
h1 { font-size: 1.4em !important; }
h2 { font-size: 1.2em !important; }
h3 { font-size: 1.05em !important; }
h4 { font-size: 1em !important; }
sup, sub { font-size: .72em !important; line-height: 0; }
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
