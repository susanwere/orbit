import { DomainError } from "@orbit/domain";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";

export interface MuseVoiceOptions {
  auth: AuthVerifier;
  authorization: ProjectAuthorizationService;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function readMuseTranscript(value: unknown): string {
  if (typeof value !== "object" || value === null) throw new DomainError("invalid_model_response", "Muse Voice returned invalid transcription.");
  const result = value as Record<string, unknown>;
  const transcript = result.transcript ?? result.text;
  if (typeof transcript !== "string") throw new DomainError("invalid_model_response", "Muse Voice returned no transcript.");
  return transcript.trim().slice(0, 10_000);
}

export async function registerMuseVoiceRoutes(app: FastifyInstance, options: MuseVoiceOptions) {
  app.post<{
    Params: { projectId: string };
    Body: { audioBase64?: unknown };
  }>("/projects/:projectId/voice/transcribe", { bodyLimit: 8_000_000 }, async (request) => {
    const principal = options.auth.verify(request.headers.authorization);
    await options.authorization.authorize(principal.id, request.params.projectId, "review");
    const encoded = request.body?.audioBase64;
    if (typeof encoded !== "string" || !encoded || encoded.length > 8_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      throw new DomainError("validation", "Provide a short WAV recording.");
    const audio = Buffer.from(encoded, "base64");
    if (audio.length < 44 || audio.length > 6_000_000 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE")
      throw new DomainError("validation", "Audio must be a short WAV recording.");
    if (audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 ||
        ![16000, 24000].includes(audio.readUInt32LE(24)) || audio.readUInt16LE(34) !== 16)
      throw new DomainError("validation", "Use mono 16-bit PCM WAV at 16 or 24 kHz.");
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify({
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "PUSH_TO_TALK",
      keywords: ["Orbit", "Muse Spark", "Muse Code", "GitHub"],
    })], { type: "application/json" }));
    form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "intent.wav");
    const response = await (options.fetchImpl ?? fetch)(
      `${(options.baseUrl ?? "https://api.meta.ai/v1").replace(/\/$/, "")}/asr/transcribe`,
      { method: "POST", headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" }, body: form, signal: AbortSignal.timeout(35_000) },
    );
    if (!response.ok) throw new DomainError("model_api_error", `Muse Voice transcription failed (HTTP ${response.status}).`);
    const result: unknown = await response.json();
    return { transcript: readMuseTranscript(result) };
  });
}
