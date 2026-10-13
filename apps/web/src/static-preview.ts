export const STATIC_PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";

/** The separate opaque-origin iframe owns these styles, never the main app. */
export function buildStaticPreview(markup: string): string {
  const document = new DOMParser().parseFromString(markup, "text/html");
  document
    .querySelectorAll(
      "script,iframe,object,embed,form,input,button,textarea,select,link,meta,base",
    )
    .forEach((node) => node.remove());
  for (const node of document.querySelectorAll("*")) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        [
          "srcdoc",
          "srcset",
          "action",
          "formaction",
          "href",
          "xlink:href",
        ].includes(name)
      )
        node.removeAttribute(attribute.name);
      if (
        name === "src" &&
        !/^(data:image\/(?:png|jpeg|gif|webp|svg\+xml);|blob:)/i.test(
          attribute.value,
        )
      )
        node.removeAttribute(attribute.name);
    }
  }
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(STATIC_PREVIEW_CSP)}">${document.head.innerHTML}</head><body>${document.body.innerHTML}</body></html>`;
}
