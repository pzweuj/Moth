import type { ReaderSettings } from "./settings";

/**
 * CSS injected into each section document by the paginator via `setStyles`.
 * Uses concrete values because CSS custom properties do not cross iframe
 * boundaries.
 */
export function readerCss({
  fontSize,
  lineHeight,
}: ReaderSettings, theme: "light" | "dark"): string {
  const dark = theme === "dark";
  const foreground = dark ? "#e8eee5" : "#27312d";
  const background = dark ? "#101615" : "#f5f5ef";
  const link = dark ? "#b8d59e" : "#315c42";
  return `
:root {
  color-scheme: ${dark ? "dark" : "light"};
}
html {
  background: ${background};
  color: ${foreground};
  -ms-overflow-style: none;
  scrollbar-width: none;
}
html::-webkit-scrollbar,
body::-webkit-scrollbar {
  display: none;
  height: 0;
  width: 0;
}
body {
  margin: 0;
  padding: 0;
  /* Keep the reading face local so the reader never depends on a remote font request. */
  font-family: "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "Source Han Serif", "STSong", "Songti SC", "SimSun", "NSimSun", Georgia, serif;
  font-size: ${fontSize}px !important;
  line-height: ${lineHeight};
  overflow-wrap: break-word;
  -ms-overflow-style: none;
  scrollbar-width: none;
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
