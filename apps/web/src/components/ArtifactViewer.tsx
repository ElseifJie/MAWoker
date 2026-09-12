import { Check, Copy, Download, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ArtifactSummary } from "../api.js";
import {
  artifactDownloadUrl,
  artifactKind,
  canPreview,
  parseCsv,
  type ArtifactKind,
} from "../artifacts.js";
import { Button, IconButton, Spinner } from "../ui/index.js";
import { Markdown } from "./Markdown.js";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "text"; text: string }
  | { status: "blob"; url: string }
  | { status: "buffer"; data: ArrayBuffer };

function CsvTable({ text }: { text: string }) {
  const rows = parseCsv(text);
  if (rows.length === 0) return <p className="muted">Empty file.</p>;
  const [head, ...body] = rows;
  return (
    <div className="artifact-viewer__scroll">
      <table className="artifact-table">
        <thead>
          <tr>
            {head!.map((cell, index) => (
              <th key={index} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Slides are laid out for this width until the real panel width is measured. */
const FALLBACK_DOC_WIDTH = 720;
const MIN_DOC_WIDTH = 240;
/**
 * The document page reserves a stable scrollbar gutter; slide canvases are
 * rendered that much narrower so a vertical scrollbar can never push them into
 * a horizontal one. Over-reserving only leaves a sliver, whereas under-reserving
 * clips the slide's right edge.
 */
const SCROLLBAR_ALLOWANCE = 16;

/**
 * Word and PowerPoint are converted to HTML and shown in a sandboxed iframe.
 * The frame keeps `allow-same-origin` (so blob images resolve) but deliberately
 * omits `allow-scripts`, so markup derived from the file can never execute. The
 * heavy parsers are imported on demand, keeping them out of the initial bundle.
 *
 * Slides are rasterised to a fixed pixel canvas, so the width they are rendered
 * at has to match the panel; a ResizeObserver re-renders when the panel is
 * resized, which is what keeps the preview from overflowing horizontally.
 */
function OfficeDocument({
  kind,
  data,
  title,
}: {
  kind: "word" | "slides";
  data: ArrayBuffer;
  title: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const measured = Math.round(host.clientWidth);
      if (measured <= 0) return;
      // Ignore sub-pixel churn; a re-render is not free.
      setWidth((current) =>
        Math.abs(current - measured) >= 16 ? measured : current,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    setHtml(null);
    setFailed(false);

    const render = async () => {
      try {
        const body =
          kind === "word"
            ? await renderWord(data)
            : await renderSlides(data, width || FALLBACK_DOC_WIDTH);
        if (active) setHtml(body);
      } catch {
        if (active) setFailed(true);
      }
    };
    // Debounce the re-render so a panel drag does not reparse the deck per frame.
    const timer = setTimeout(() => void render(), kind === "slides" ? 90 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, kind, width]);

  return (
    <div className="artifact-viewer__document" ref={hostRef}>
      {failed ? (
        <p className="artifact-viewer__note">
          Preview failed. Download the file instead.
        </p>
      ) : html === null ? (
        <p className="artifact-viewer__note">
          <Spinner size={14} aria-hidden="true" />
          Rendering document…
        </p>
      ) : (
        <iframe
          className="artifact-viewer__frame artifact-viewer__frame--document"
          sandbox="allow-same-origin"
          srcDoc={html}
          title={title}
        />
      )}
    </div>
  );
}

async function renderWord(data: ArrayBuffer): Promise<string> {
  const { renderAsync } = await import("docx-preview");
  const container = document.createElement("div");
  await renderAsync(data, container, undefined, {
    className: "docx",
    inWrapper: true,
    breakPages: true,
    // Let the page flow to the panel width instead of its own page size, which
    // would otherwise overflow a narrow side panel.
    ignoreWidth: true,
  });
  return `<style>${documentStyles()}</style>${container.innerHTML}`;
}

async function renderSlides(data: ArrayBuffer, width: number): Promise<string> {
  const { pptxToHtml } = await import("@jvmr/pptx-to-html");
  const target = Math.max(
    MIN_DOC_WIDTH,
    Math.round(width - SCROLLBAR_ALLOWANCE),
  );
  const slides = await pptxToHtml(data, {
    width: target,
    height: Math.round((target * 9) / 16),
    scaleToFit: true,
    letterbox: false,
  });
  const pages = slides
    .map((slide) => `<div class="pptx-page">${slide}</div>`)
    .join("");
  return `<style>${documentStyles()}</style>${pages}`;
}

function documentStyles(): string {
  return (
    // No body padding: the slide width is measured from the frame's content
    // box, so any padding here would push it into a horizontal scrollbar.
    "body{margin:0;background:#fff;font-family:system-ui,sans-serif}" +
    // A stable gutter keeps the slide width and the visible area in step; the
    // slide is pre-sized narrower by SCROLLBAR_ALLOWANCE to fill it.
    "html{scrollbar-gutter:stable}" +
    ".pptx-page{width:100%;margin:0 0 12px;overflow:hidden;border-radius:6px;background:#fff}" +
    ".pptx-page:last-child{margin-bottom:0}" +
    ".pptx-page .slide-container{max-width:100%;margin-inline:auto}" +
    ".docx-wrapper{background:transparent;padding:8px}" +
    ".docx-wrapper>section.docx{width:100%!important;min-width:0!important;box-sizing:border-box}"
  );
}

function previewOf(
  kind: ArtifactKind,
  state: LoadState,
  artifact: ArtifactSummary,
) {
  if (kind === "image" && state.status === "blob") {
    return (
      <img
        className="artifact-viewer__image"
        src={state.url}
        alt={artifact.name}
      />
    );
  }
  if (kind === "pdf" && state.status === "blob") {
    return (
      <iframe
        className="artifact-viewer__frame artifact-viewer__frame--document"
        src={state.url}
        title={artifact.name}
      />
    );
  }
  if ((kind === "word" || kind === "slides") && state.status === "buffer") {
    return (
      <OfficeDocument kind={kind} data={state.data} title={artifact.name} />
    );
  }
  if (state.status !== "text") return null;
  if (kind === "markdown") {
    return (
      <div className="artifact-viewer__scroll">
        <Markdown>{state.text}</Markdown>
      </div>
    );
  }
  if (kind === "csv") return <CsvTable text={state.text} />;
  if (kind === "html") {
    return (
      <iframe
        className="artifact-viewer__frame"
        sandbox="allow-scripts"
        srcDoc={state.text}
        title={artifact.name}
      />
    );
  }
  return <pre className="artifact-viewer__pre">{state.text}</pre>;
}

/**
 * Inline preview of one artifact. Content is fetched through the API on the
 * session cookie and held only in memory; object URLs are revoked on close, so
 * no long-lived public URL is ever produced.
 *
 * Rendered HTML goes into an iframe sandboxed with `allow-scripts` and
 * deliberately *not* `allow-same-origin` — that combination would give the frame
 * our origin and let it remove its own sandbox.
 */
export function ArtifactViewer({
  artifact,
  onClose,
}: {
  artifact: ArtifactSummary;
  onClose: () => void;
}) {
  const kind = artifactKind(artifact);
  const previewable = canPreview(artifact);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [copied, setCopied] = useState(false);
  const artifactId = artifact.id;

  useEffect(() => {
    if (!previewable) return;
    let active = true;
    let objectUrl: string | undefined;
    setState({ status: "loading" });

    const asBlob = kind === "image" || kind === "pdf";
    const asBuffer = kind === "word" || kind === "slides";

    void fetch(artifactDownloadUrl(artifactId), { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        if (asBlob) {
          objectUrl = URL.createObjectURL(await response.blob());
          if (active) setState({ status: "blob", url: objectUrl });
          return;
        }
        if (asBuffer) {
          const data = await response.arrayBuffer();
          if (active) setState({ status: "buffer", data });
          return;
        }
        const text = await response.text();
        if (active) setState({ status: "text", text });
      })
      .catch(() => {
        if (active) setState({ status: "error" });
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, kind, previewable]);

  async function copyName() {
    try {
      await navigator.clipboard.writeText(artifact.name);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      className="artifact-viewer"
      aria-label={`Preview of ${artifact.name}`}
    >
      <header className="artifact-viewer__header">
        <span className="artifact-viewer__name" title={artifact.name}>
          {artifact.name}
        </span>
        <IconButton label="Close preview" size="small" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </IconButton>
      </header>

      <div className="artifact-viewer__actions">
        <a
          className="ui-button ui-button--secondary ui-button--compact"
          href={artifactDownloadUrl(artifact.id)}
          download
        >
          <Download size={14} aria-hidden="true" />
          Download
        </a>
        <Button
          variant="secondary"
          size="compact"
          onClick={() => void copyName()}
        >
          {copied ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Copy size={14} aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy name"}
        </Button>
        {state.status === "blob" && kind === "image" ? (
          <a
            className="ui-button ui-button--secondary ui-button--compact"
            href={state.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={14} aria-hidden="true" />
            Open
          </a>
        ) : null}
      </div>

      {!previewable ? (
        <p className="artifact-viewer__note">
          Preview unavailable. Download to open.
        </p>
      ) : state.status === "loading" ? (
        <p className="artifact-viewer__note">
          <Spinner size={14} aria-hidden="true" />
          Loading…
        </p>
      ) : state.status === "error" ? (
        <p className="artifact-viewer__note">
          Preview failed. Download the file instead.
        </p>
      ) : (
        previewOf(kind, state, artifact)
      )}
    </section>
  );
}
