import { DomainError } from "@orbit/domain";

/** Return only application-owned messages, never provider bodies or private inputs. */
export function planningFailureMessage(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Muse planning timed out. Please retry.";
  }
  if (error instanceof DomainError) {
    if (error.code === "invalid_model_output" || error.code === "invalid_model_response") {
      return "Muse returned an invalid plan. Please retry.";
    }
    if (error.code === "model_api_error") {
      const status = /^Meta Model API returned HTTP (\d{3})\.$/.exec(error.message)?.[1];
      if (status === "429") return "Muse is rate limited. Please wait a moment and retry.";
      if (status === "401" || status === "403") {
        return "Muse rejected the API credentials. Check the local model API configuration.";
      }
      return "Muse is temporarily unavailable. Please retry.";
    }
  }
  return "Planning failed while preparing or saving the proposal. Please retry.";
}
