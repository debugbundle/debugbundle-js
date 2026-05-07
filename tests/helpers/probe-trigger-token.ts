import { createHmac } from "node:crypto";

const PROBE_TRIGGER_TOKEN_PREFIX = "dbundle_probe_";

export interface ProbeTriggerTokenPayload {
  activation_id: string;
  label_pattern: string;
  service: string;
  environment: string;
  trigger_expires_at: string;
}

function readRequiredProbeTriggerSecret(): string {
  const secret = process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"];
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("missing DEBUGBUNDLE_PROBE_TRIGGER_SECRET");
  }

  return secret;
}

export function deriveProbeTriggerTokenKey(projectId: string): string {
  const secret = readRequiredProbeTriggerSecret();
  return createHmac("sha256", secret).update(projectId, "utf8").digest("hex");
}

export function generateProbeTriggerToken(input: {
  projectId: string;
  payload: ProbeTriggerTokenPayload;
}): { plaintext: string; key: string } {
  const key = deriveProbeTriggerTokenKey(input.projectId);
  const payloadSegment = Buffer.from(JSON.stringify(input.payload), "utf8").toString("base64url");
  const signatureSegment = createHmac("sha256", key).update(payloadSegment, "utf8").digest("base64url");

  return {
    plaintext: `${PROBE_TRIGGER_TOKEN_PREFIX}${payloadSegment}.${signatureSegment}`,
    key
  };
}