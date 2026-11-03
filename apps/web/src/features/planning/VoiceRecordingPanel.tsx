interface VoiceRecordingPanelProps {
  readonly phase: "starting" | "recording" | "transcribing";
  readonly levels: readonly number[];
  readonly elapsedSeconds?: number;
  readonly isPaused?: boolean;
  readonly onTogglePause?: () => void;
  readonly onCancel: () => void;
  readonly onStop: () => void;
}

/** Live audio levels are decorative; recording status and controls remain accessible. */
export function VoiceRecordingPanel({
  phase,
  levels,
  elapsedSeconds = 0,
  isPaused = false,
  onTogglePause,
  onCancel,
  onStop,
}: VoiceRecordingPanelProps) {
  const waveformLevels = [...Array<number>(Math.max(0, 56 - levels.length)).fill(0), ...levels];
  return (
    <div className="composer-recording-panel" data-phase={phase}>
      <div className="composer-recording-indicator">
        {phase === "recording" ? (
          <>
            <span className="composer-recording-dot" aria-hidden="true" />
            <span aria-label="Recording duration">
              {String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:
              {String(elapsedSeconds % 60).padStart(2, "0")}
            </span>
          </>
        ) : (
          <span>
            {phase === "transcribing"
              ? "✦ Muse Voice is transcribing…"
              : "Requesting microphone access…"}
          </span>
        )}
      </div>
      <div className="composer-recording-wave" aria-hidden="true">
        {waveformLevels.map((level, index) => (
          <span key={index} style={{ height: `${3 + level * 37}px` }} />
        ))}
      </div>
      <div className="composer-recording-controls">
        {phase === "recording" && (
          <button
            type="button"
            aria-label={isPaused ? "Resume voice recording" : "Pause voice recording"}
            aria-pressed={isPaused}
            onClick={onTogglePause}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              {isPaused ? <path d="m7 4 14 8-14 8Z" /> : <path d="M6 4h4v16H6zm8 0h4v16h-4Z" />}
            </svg>
          </button>
        )}
        <button
          type="button"
          className="composer-recording-stop"
          aria-label="Stop recording and transcribe"
          hidden={phase !== "recording"}
          disabled={phase !== "recording"}
          onClick={onStop}
          autoFocus
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
        {phase === "transcribing" && (
          <span className="composer-transcribing-spinner" aria-hidden="true" />
        )}
        <button
          type="button"
          className="composer-recording-cancel"
          aria-label="Cancel voice recording"
          onClick={onCancel}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </div>
      <p role="status" className="canvas-empty-label">
        {phase === "starting"
          ? "Requesting microphone access…"
          : phase === "transcribing"
            ? "Muse Voice is transcribing…"
            : isPaused
              ? "Recording paused."
              : "Listening… Stop when you’re ready."}
      </p>
    </div>
  );
}
