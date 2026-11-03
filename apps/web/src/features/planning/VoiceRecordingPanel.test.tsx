import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VoiceRecordingPanel } from "./VoiceRecordingPanel.js";

describe("Voice recording panel", () => {
  it("provides accessible cancel and stop controls with live audio levels", () => {
    const markup = renderToStaticMarkup(
      <VoiceRecordingPanel
        phase="recording"
        levels={[0, 0.5, 1]}
        onCancel={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(markup).toContain('aria-label="Cancel voice recording"');
    expect(markup).toContain('aria-label="Stop recording and transcribe"');
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Listening…");
    expect(markup).toContain('aria-label="Pause voice recording"');
    expect(markup).toContain("00:00");
    expect(markup).toContain("height:40px");
  });

  it("shows elapsed recording time and offers resume while paused", () => {
    const markup = renderToStaticMarkup(
      <VoiceRecordingPanel
        phase="recording"
        levels={[]}
        elapsedSeconds={24}
        isPaused
        onTogglePause={vi.fn()}
        onCancel={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(markup).toContain("00:24");
    expect(markup).toContain('aria-label="Resume voice recording"');
    expect(markup).toContain("Recording paused.");
  });
  it.each(["starting", "transcribing"] as const)("prevents stopping again while %s", (phase) => {
    const markup = renderToStaticMarkup(
      <VoiceRecordingPanel phase={phase} levels={[]} onCancel={vi.fn()} onStop={vi.fn()} />,
    );
    expect(markup).toMatch(/aria-label="Stop recording and transcribe"[^>]*disabled=""/);
    expect(markup).toContain(
      phase === "starting" ? "Requesting microphone access…" : "Muse Voice is transcribing…",
    );
  });
});
