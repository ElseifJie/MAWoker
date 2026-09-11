import { FileText } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkArtifactLinks } from "../markdown/remarkArtifactLinks.js";

const ARTIFACT_SCHEME = "artifact:";

/**
 * Renders message bodies. react-markdown escapes raw HTML unless `rehype-raw`
 * is added, and it is not: message text comes out of a sandboxed Agent that can
 * be steered by whatever it reads, so it must not be able to inject markup.
 * Captured Agent output contains real GFM tables, hence the plugin.
 */
export function Markdown({
  children,
  artifactLinks = false,
}: {
  children: string;
  artifactLinks?: boolean;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={
          artifactLinks ? [remarkGfm, remarkArtifactLinks] : [remarkGfm]
        }
        // The default transform strips unknown schemes, which would gut the
        // in-app artifact links before they reach the `a` override.
        urlTransform={(url) =>
          url.startsWith(ARTIFACT_SCHEME) ? url : defaultUrlTransform(url)
        }
        components={{
          a: (props) =>
            typeof props.href === "string" &&
            props.href.startsWith(ARTIFACT_SCHEME) ? (
              <button
                type="button"
                className="artifact-chip"
                data-artifact-path={decodeURIComponent(
                  props.href.slice(ARTIFACT_SCHEME.length),
                )}
                title={decodeURIComponent(
                  props.href.slice(ARTIFACT_SCHEME.length),
                )}
              >
                <FileText size={13} aria-hidden="true" />
                <span>{props.children}</span>
              </button>
            ) : (
              <a {...props} target="_blank" rel="noopener noreferrer" />
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
