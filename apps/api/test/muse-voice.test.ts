import { describe, expect, it } from "vitest";
import { readMuseTranscript } from "../src/modules/voice/muse-voice-routes.js";

describe("Muse Voice transcription", () => {
  it("returns the trimmed transcript for the Composer", () => {
    expect(readMuseTranscript({ transcript: "  Build a React job board.  " })).toBe(
      "Build a React job board.",
    );
  });

  it("supports plain text transcription response fields", () => {
    expect(readMuseTranscript({ text: "Create a search experience." })).toBe(
      "Create a search experience.",
    );
  });

  it("does not silently treat a malformed result as a successful transcript", () => {
    expect(() => readMuseTranscript({ turns: [] })).toThrow();
    expect(() => readMuseTranscript(null)).toThrow();
  });

  it("bounds transcription to the Intent draft limit", () => {
    expect(readMuseTranscript({ transcript: "A".repeat(12_000) })).toHaveLength(10_000);
  });
});
