import { useEffect, useRef, useState } from "react";
import { VoiceRecordingPanel } from "./VoiceRecordingPanel.js";
import { encodeVoice, recordIntentVoice } from "./intent-voice-recorder.js";

interface CanvasComposerProps {
  readonly isPreview?: boolean;
  readonly draftIdea: string;
  readonly onDraftChange: (draftIdea: string) => void;
  readonly onOpenIntent: () => void;
  readonly onSubmitIntent?: (statement: string, files: readonly File[]) => Promise<void>;
  readonly onTranscribeVoice?: (audioBase64: string) => Promise<string>;
}

/** Create the original Intent and document-backed plan directly from the canvas. */
export function CanvasComposer({
  isPreview = false,
  draftIdea,
  onDraftChange,
  onSubmitIntent,
  onTranscribeVoice,
}: CanvasComposerProps) {
  const [attachments, setAttachments] = useState<File[]>([]);
  const [showAllAttachments, setShowAllAttachments] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const voiceSession = useRef<Awaited<ReturnType<typeof recordIntentVoice>> | null>(null);
  const [voiceState, setVoiceState] = useState<"idle" | "starting" | "recording" | "transcribing">(
    "idle",
  );
  const voiceOperation = useRef(0);
  const [isVoicePaused, setIsVoicePaused] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioLevels, setAudioLevels] = useState<readonly number[]>([]);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const previousVoiceState = useRef(voiceState);
  useEffect(() => {
    if (voiceState === "idle" && previousVoiceState.current !== "idle") draftInput.current?.focus();
    previousVoiceState.current = voiceState;
  }, [voiceState]);
  useEffect(
    () => () => {
      voiceOperation.current += 1;
      voiceSession.current?.cancel();
      voiceSession.current = null;
    },
    [],
  );
  function cancelVoice() {
    voiceOperation.current += 1;
    voiceSession.current?.cancel();
    voiceSession.current = null;
    setAudioLevels([]);
    setVoiceState("idle");
    setVoiceError(null);
  }
  async function toggleVoice() {
    if (voiceState === "recording") {
      const operation = voiceOperation.current;
      const session = voiceSession.current;
      if (!session) return;
      voiceSession.current = null;
      setVoiceState("transcribing");
      try {
        const blob = await session.stop();
        if (!onTranscribeVoice) throw new Error("Muse Voice is not configured.");
        const transcript = await onTranscribeVoice(await encodeVoice(blob));
        if (operation !== voiceOperation.current) return;
        if (!transcript) throw new Error("No speech was detected. Try recording again.");
        onDraftChange([draftIdea.trim(), transcript].filter(Boolean).join("\n").slice(0, 10000));
      } catch (cause) {
        if (operation === voiceOperation.current)
          setVoiceError(cause instanceof Error ? cause.message : "Transcription failed.");
      } finally {
        if (operation === voiceOperation.current) setVoiceState("idle");
      }
      return;
    }
    if (voiceState !== "idle" || !onTranscribeVoice) return;
    const operation = ++voiceOperation.current;
    setAudioLevels([]);
    setIsVoicePaused(false);
    setRecordingSeconds(0);
    setVoiceState("starting");
    setVoiceError(null);
    try {
      const session = await recordIntentVoice(
        () => {
          if (operation === voiceOperation.current) setVoiceState("recording");
        },
        (level, elapsedSeconds) => {
          if (operation === voiceOperation.current) {
            setAudioLevels((levels) => [...levels.slice(-55), level]);
            setRecordingSeconds(Math.floor(elapsedSeconds));
          }
        },
      );
      if (operation !== voiceOperation.current) session.cancel();
      else voiceSession.current = session;
    } catch (cause) {
      if (operation === voiceOperation.current) {
        setVoiceError(cause instanceof Error ? cause.message : "Microphone unavailable.");
        setVoiceState("idle");
      }
    }
  }
  const ready =
    !isPreview &&
    Boolean(draftIdea.trim()) &&
    draftIdea.length <= 10000 &&
    !submitting &&
    voiceState === "idle" &&
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
      <div className="canvas-composer-input" data-voice-active={voiceState !== "idle"}>
        {voiceState !== "idle" && (
          <VoiceRecordingPanel
            phase={voiceState}
            levels={audioLevels}
            elapsedSeconds={recordingSeconds}
            isPaused={isVoicePaused}
            onTogglePause={() => {
              voiceSession.current?.setPaused(!isVoicePaused);
              setIsVoicePaused(!isVoicePaused);
            }}
            onCancel={cancelVoice}
            onStop={() => {
              void toggleVoice();
            }}
          />
        )}
        <div className="canvas-composer-text-panel" hidden={voiceState !== "idle"}>
          <textarea
            ref={draftInput}
            id="canvas-project-idea"
            disabled={voiceState !== "idle" || submitting}
            value={draftIdea}
            onChange={(event) => onDraftChange(event.target.value)}
            maxLength={10000}
            rows={3}
            placeholder={"e.g. Build a landing page that shows “Hello World”"}
            aria-describedby="canvas-draft-help"
          />
        </div>
        <div className="canvas-composer-toolbar">
          <div className="canvas-composer-attachments">
            <input
              hidden
              ref={fileInput}
              type="file"
              accept=".pdf,.docx,.md,.txt"
              multiple
              disabled={submitting || isPreview || voiceState !== "idle"}
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
                      !validExtension.test(file.name) ||
                      file.size < 1 ||
                      file.size > 5 * 1024 * 1024,
                  )
                ) {
                  setSubmissionError(
                    "Choose up to 10 PDF, DOCX, Markdown or TXT files, 5 MB each.",
                  );
                } else {
                  setAttachments(combined);
                  setSubmissionError(null);
                }
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="canvas-composer-attach"
              disabled={submitting || isPreview || voiceState !== "idle"}
              onClick={() => fileInput.current?.click()}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <path d="M8 12V6a4 4 0 0 1 8 0v11a6 6 0 0 1-12 0V7m8 0v10a2 2 0 0 1-4 0V6" />
              </svg>
              Attach files
            </button>
            <div className="canvas-composer-file-list" aria-label="Selected attachments">
              {(showAllAttachments ? attachments : attachments.slice(0, 2)).map((file, index) => (
                <span
                  key={file.name + file.lastModified + index}
                  className="canvas-attachment-chip"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <path d="M14 2H5v20h14V7Zm0 0v6h5M8 13h8M8 17h5" />
                  </svg>
                  <span title={file.name}>{file.name}</span>
                  <button
                    type="button"
                    disabled={submitting || voiceState !== "idle"}
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setAttachments((items) => items.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </span>
              ))}
              {attachments.length > 2 && (
                <button
                  type="button"
                  className="canvas-composer-more"
                  disabled={submitting || voiceState !== "idle"}
                  aria-expanded={showAllAttachments}
                  onClick={() => setShowAllAttachments(!showAllAttachments)}
                >
                  {showAllAttachments ? "Show less" : `+${attachments.length - 2} more`}
                </button>
              )}
            </div>
          </div>
          <div className="canvas-composer-actions">
            <button
              type="button"
              className="canvas-composer-voice"
              disabled={isPreview || submitting || !onTranscribeVoice || voiceState !== "idle"}
              onClick={() => {
                void toggleVoice();
              }}
              aria-label={
                voiceState === "recording"
                  ? "Stop voice recording and transcribe"
                  : "Record an Intent with Muse Voice"
              }
              aria-pressed={voiceState === "recording"}
              title={
                voiceState === "recording" ? "Stop recording" : "Record an Intent with Muse Voice"
              }
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
        </div>
      </div>
      {submissionError && (
        <p className="intent-error" role="alert">
          {submissionError}
        </p>
      )}
      {voiceError && (
        <p role="alert" className="intent-error">
          {voiceError}
        </p>
      )}
      <p id="canvas-draft-help" className="canvas-empty-help">
        {isPreview ? (
          "Preview only. Your saved intent and plan are unchanged."
        ) : (
          <>Add docs, specs, or context to help Muse Spark create a better plan.</>
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
