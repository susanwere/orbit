import { useRef, useState } from "react";

interface CanvasComposerProps {
  readonly isPreview?: boolean;
  readonly draftIdea: string;
  readonly onDraftChange: (draftIdea: string) => void;
  readonly onOpenIntent: () => void;
  readonly onSubmitIntent?: (statement: string, files: readonly File[]) => Promise<void>;
}

/** Editable canvas draft. Generation remains on Intent until this entry point is connected. */
export function CanvasComposer({
  isPreview = false,
  draftIdea,
  onDraftChange,
  onOpenIntent,
  onSubmitIntent,
}: CanvasComposerProps) {
  const [attachments, setAttachments] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ready =
    !isPreview &&
    Boolean(draftIdea.trim()) &&
    draftIdea.length <= 10000 &&
    !submitting &&
    Boolean(onSubmitIntent);

  async function submit() {
    if (!ready || !onSubmitIntent) return;
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await onSubmitIntent(draftIdea.trim(), attachments);
    } catch (cause) {
      setSubmissionError(cause instanceof Error ? cause.message : "Could not submit intent.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="canvas-empty-state" aria-labelledby="canvas-empty-heading">
      <div
        className="canvas-view-controls canvas-composer-view-controls"
        role="toolbar"
        aria-label="Composer preview controls"
        title="Pan, fit and zoom are available in the Workflow graph"
      >
        <div>
          <button type="button" disabled aria-label="Pan preview" aria-pressed="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 13V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-4a1.5 1.5 0 0 1 3 0v7c0 5-3 7-7 7-3 0-5-2-6-4l-3-5a1.5 1.5 0 0 1 2-2l2 2Z" />
            </svg>
          </button>
          <button type="button" disabled aria-label="Fit preview">
            <span aria-hidden="true">⌗</span>
          </button>
          <button type="button" disabled aria-label="Expand preview">
            <span aria-hidden="true">⛶</span>
          </button>
        </div>
        <div>
          <button type="button" disabled aria-label="Zoom preview out">
            −
          </button>
          <output aria-label="Preview zoom">100%</output>
          <button type="button" disabled aria-label="Zoom preview in">
            ＋
          </button>
        </div>
      </div>
      <span className="canvas-empty-spark" aria-hidden="true">
        <svg width="42" height="42" viewBox="0 0 40 40" fill="currentColor">
          <path d="m18 6 4 10 10 4-10 4-4 10-4-10-10-4 10-4ZM32 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" />
        </svg>
      </span>
      <h2 id="canvas-empty-heading">What do you want to build?</h2>
      <p>
        Describe your idea and let Muse Spark turn it into a plan with
        <br className="canvas-empty-desktop-break" /> work items, workflows, and approvals.
      </p>
      <label className="canvas-empty-label" htmlFor="canvas-project-idea">
        Canvas project idea
      </label>
      <div className="canvas-composer-input">
        <textarea
          id="canvas-project-idea"
          value={draftIdea}
          onChange={(event) => onDraftChange(event.target.value)}
          maxLength={10000}
          rows={1}
          placeholder={"e.g. Build a landing page that shows “Hello World”"}
          aria-describedby="canvas-draft-help"
        />
      </div>
      {!isPreview && (
        <div className="canvas-composer-attachments">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx,.md,.txt"
            multiple
            disabled={submitting}
            aria-label="Attach supporting documents"
            onChange={(event) => {
              const incoming = Array.from(event.target.files ?? []);
              const combined = [...attachments, ...incoming].filter(
                (file, index, all) =>
                  all.findIndex(
                    (item) =>
                      item.name === file.name &&
                      item.size === file.size &&
                      item.lastModified === file.lastModified,
                  ) === index,
              );
              const validExtension = /\.(pdf|docx|md|txt)$/i;
              if (
                combined.length > 10 ||
                combined.some(
                  (file) =>
                    !validExtension.test(file.name) || file.size < 1 || file.size > 5 * 1024 * 1024,
                )
              ) {
                setSubmissionError("Choose up to 10 PDF, DOCX, Markdown or TXT files, 5 MB each.");
              } else {
                setAttachments(combined);
                setSubmissionError(null);
              }
              event.target.value = "";
            }}
          />
          {attachments.map((file, index) => (
            <span key={file.name + file.lastModified + index} className="canvas-attachment-chip">
              {file.name}
              <button
                type="button"
                disabled={submitting}
                aria-label={`Remove ${file.name}`}
                onClick={() => setAttachments((items) => items.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {submissionError && (
        <p className="intent-error" role="alert">
          {submissionError}
        </p>
      )}
      <div className="canvas-composer-actions">
        <button
          type="button"
          className="canvas-composer-voice"
          disabled
          aria-label="Voice input (coming soon)"
          title="Voice input is not available yet"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <rect x="9" y="2" width="6" height="13" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
          </svg>
        </button>
        <button
          type="button"
          className="canvas-composer-generate"
          onClick={() => {
            void submit();
          }}
          disabled={!ready}
          aria-describedby="canvas-draft-help"
        >
          <span aria-hidden="true">✦</span> {submitting ? "Submitting…" : "Generate plan"}
        </button>
      </div>
      <p id="canvas-draft-help" className="canvas-empty-help">
        {isPreview ? (
          "Preview only. Your saved intent and plan are unchanged."
        ) : (
          <>Attach supporting documents and generate your plan here.</>
        )}
      </p>
      <ul className="canvas-composer-benefits" aria-label="Workflow capabilities">
        <li>
          <span aria-hidden="true">
            <FeatureIcon kind="ideas" />
          </span>
          Turn ideas into a plan
        </li>
        <li>
          <span aria-hidden="true">
            <FeatureIcon kind="workflows" />
          </span>
          Organize into workflows
        </li>
        <li>
          <span aria-hidden="true">
            <FeatureIcon kind="execution" />
          </span>
          Execute with agents
        </li>
      </ul>
      {!isPreview && (
        <div className="canvas-composer-minimap" aria-label="Workflow minimap placeholder">
          <svg width="130" height="50" viewBox="0 0 130 50" fill="none" aria-hidden="true">
            <path d="M37 25h13v-14h18M50 25v14h18" stroke="#8b5cc2" />
            <rect x="3" y="17" width="34" height="16" rx="3" fill="#5d2c8a33" stroke="#a46ee3" />
            <rect x="68" y="3" width="34" height="16" rx="3" fill="#5d2c8a33" stroke="#a46ee3" />
            <rect x="68" y="31" width="34" height="16" rx="3" fill="#5d2c8a33" stroke="#a46ee3" />
          </svg>
          <small>No workflow nodes yet</small>
        </div>
      )}
    </section>
  );
}

function FeatureIcon({ kind }: { readonly kind: "ideas" | "workflows" | "execution" }) {
  const paths = {
    ideas: "m14 2-9 12h7l-2 8 9-12h-7l2-8Z",
    workflows: "m3 7 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 17l9 5 9-5",
    execution: "m6 3 15 9-15 9V3Z",
  };
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
