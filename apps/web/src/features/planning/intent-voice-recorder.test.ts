import { afterEach, describe, expect, it, vi } from "vitest";
import { recordIntentVoice } from "./intent-voice-recorder.js";

afterEach(() => vi.unstubAllGlobals());

describe("intent voice recorder", () => {
  it("excludes paused audio and time, resumes capture, and releases the microphone on stop", async () => {
    const stopTrack = vi.fn();
    const processor: {
      onaudioprocess?: (event: AudioProcessingEvent) => void;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    } = { connect: vi.fn(), disconnect: vi.fn() };
    const closeContext = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
      },
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        sampleRate = 16000;
        destination = {};
        createMediaStreamSource() {
          return { connect: vi.fn(), disconnect: vi.fn() };
        }
        createScriptProcessor() {
          return processor;
        }
        close = closeContext;
      },
    );
    const onAudioLevel = vi.fn();
    const session = await recordIntentVoice(vi.fn(), onAudioLevel);
    const inputSamples = new Float32Array(4096).fill(0.1);
    const event = {
      inputBuffer: { getChannelData: () => inputSamples },
      outputBuffer: { getChannelData: () => new Float32Array(4096) },
    } as unknown as AudioProcessingEvent;
    processor.onaudioprocess?.(event);
    session.setPaused(true);
    processor.onaudioprocess?.(event);
    expect(onAudioLevel).toHaveBeenCalledTimes(1);
    session.setPaused(false);
    processor.onaudioprocess?.(event);
    expect(onAudioLevel).toHaveBeenLastCalledWith(expect.any(Number), 8192 / 16000);
    const recording = await session.stop();
    expect(recording.size).toBe(44 + 8192 * 2);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
  });
});
