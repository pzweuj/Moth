/**
 * Stand-in for the vendored foliate-js `pdf.js` module. Moth does not support
 * PDFs; this stub keeps the heavy pdfjs subtree out of the module graph while
 * letting `foliate-view`'s `import("./pdf.js")` resolve (it is only reached
 * when opening a PDF, which never happens here).
 */
export async function makePDF() {
  throw new Error("PDF files are not supported.");
}
