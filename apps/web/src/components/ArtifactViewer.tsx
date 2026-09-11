import { Check, Copy, Download, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ArtifactSummary } from "../api.js";
import {
  artifactDownloadUrl,
  artifactKind,
  canPreview,
  parseCsv,
} from "../artifacts.js";
import { Button, IconButton, Spinner } from "../ui/index.js";
import { Markdown } from "./Markdown.js";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "text"; text: string }
  | { status: "image"; url: string };

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

    void fetch(artifactDownloadUrl(artifactId), { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        if (kind === "image") {
          objectUrl = URL.createObjectURL(await response.blob());
          if (active) setState({ status: "image", url: objectUrl });
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
        {state.status === "image" ? (
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
          This file type is not previewed in the browser. Download it to open
          it.
        </p>
      ) : state.status === "loading" ? (
        <p className="artifact-viewer__note">
          <Spinner size={14} aria-hidden="true" />
          Loading preview…
        </p>
      ) : state.status === "error" ? (
        <p className="artifact-viewer__note">
          The preview could not be loaded. Download the file instead.
        </p>
      ) : kind === "image" && state.status === "image" ? (
        <img
          className="artifact-viewer__image"
          src={state.url}
          alt={artifact.name}
        />
      ) : state.status === "text" ? (
        kind === "markdown" ? (
          <div className="artifact-viewer__scroll">
            <Markdown>{state.text}</Markdown>
          </div>
        ) : kind === "csv" ? (
          <CsvTable text={state.text} />
        ) : kind === "html" ? (
          <iframe
            className="artifact-viewer__frame"
            sandbox="allow-scripts"
            srcDoc={state.text}
            title={artifact.name}
          />
        ) : (
          <pre className="artifact-viewer__pre">{state.text}</pre>
        )
      ) : null}
    </section>
  );
}
