/**
 * Records a short push-to-talk clip as mono 16-bit PCM WAV at 16 kHz.
 * Audio remains in memory; callers choose whether to submit it for transcription.
 */
export async function recordIntentVoice(
  onStarted: () => void,
): Promise<{ stop: () => Promise<Blob>; cancel: () => void }> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture requires HTTPS or localhost.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = new AudioContext();
  try {
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    let listening = true;
    processor.onaudioprocess = (event) => {
      if (!listening) return;
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      event.outputBuffer.getChannelData(0).fill(0);
    };
    source.connect(processor);
    processor.connect(context.destination);
    const cleanup = () => {
      listening = false;
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
    };
    onStarted();
    return {
      cancel: cleanup,
      stop: async () => {
        cleanup();
        const frames = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        if (frames < context.sampleRate / 4) throw new Error("Recording too short. Speak for at least a moment.");
        const duration = frames / context.sampleRate;
        if (duration > 60) throw new Error("Record at most 60 seconds per clip.");
        const outputFrames = Math.floor(duration * 16000);
        const wav = new ArrayBuffer(44 + outputFrames * 2);
        const view = new DataView(wav);
        const write = (position: number, text: string) => {
          for (let i = 0; i < text.length; i++) view.setUint8(position + i, text.charCodeAt(i));
        };
        write(0, "RIFF"); view.setUint32(4, wav.byteLength - 8, true); write(8, "WAVE");
        write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
        view.setUint32(28, 32000, true); view.setUint16(32, 2, true);
        view.setUint16(34, 16, true); write(36, "data");
        view.setUint32(40, outputFrames * 2, true);
        const flattened = new Float32Array(frames);
        let offset = 0;
        for (const chunk of chunks) { flattened.set(chunk, offset); offset += chunk.length; }
        for (let i = 0; i < outputFrames; i++) {
          const position = i * context.sampleRate / 16000;
          const left = Math.floor(position);
          const fraction = position - left;
          const sample = (flattened[left] ?? 0) * (1 - fraction) + (flattened[Math.min(left + 1, frames - 1)] ?? 0) * fraction;
          const value = Math.max(-1, Math.min(1, sample));
          view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
        }
        return new Blob([wav], { type: "audio/wav" });
      },
    };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw error;
  }
}

export async function encodeVoice(blob: Blob): Promise<string> {
  const data = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < data.length; i += 32768) {
    binary += String.fromCharCode(...data.subarray(i, i + 32768));
  }
  return btoa(binary);
}
