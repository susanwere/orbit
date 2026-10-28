import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const SHA256_HEX_LENGTH = 64;

export function verifyGitHubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith(SIGNATURE_PREFIX) || !secret) {
    return false;
  }

  const suppliedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (
    suppliedHex.length !== SHA256_HEX_LENGTH ||
    !/^[0-9a-f]+$/i.test(suppliedHex)
  ) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(suppliedHex, "hex");

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
