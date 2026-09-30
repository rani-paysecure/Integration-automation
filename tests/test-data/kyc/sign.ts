import { createHmac } from 'node:crypto';

/**
 * Sumsub signs the webhook with HMAC-SHA256 over the raw request bytes, hex, in
 * `x-payload-digest`. The algorithm is named in `x-payload-digest-alg`.
 *
 * Our side verifies against `x-raw-body` — the exact bytes received, never a
 * re-serialised object — so a test that signs a pretty-printed string and sends a
 * compact one will fail for the wrong reason. Always sign and send the same buffer:
 * build it once with `payload()` and pass it straight through.
 */
export function payload(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body), 'utf8');
}

export function digest(raw: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

export interface SignedWebhook {
  raw: Buffer;
  headers: Record<string, string>;
}

export function signed(body: unknown, secret: string): SignedWebhook {
  const raw = payload(body);
  return {
    raw,
    headers: {
      'Content-Type': 'application/json',
      'x-payload-digest': digest(raw, secret),
      'x-payload-digest-alg': 'HMAC_SHA256_HEX',
    },
  };
}

/** Same body, a digest that will not match — for the rejection case. */
export function misSigned(body: unknown): SignedWebhook {
  const raw = payload(body);
  return {
    raw,
    headers: {
      'Content-Type': 'application/json',
      'x-payload-digest': digest(raw, 'definitely-not-the-secret'),
      'x-payload-digest-alg': 'HMAC_SHA256_HEX',
    },
  };
}

/**
 * A Sumsub `applicantReviewed` event.
 *
 * `applicantId` is what correlates the event to our record — KycOrchestrationService
 * looks it up as providerReferenceId, newest record first, because a resubmission
 * reuses the same applicant at the provider.
 */
export function applicantReviewed(
  applicantId: string,
  answer: 'GREEN' | 'RED',
  rejectType: 'FINAL' | 'RETRY' = 'FINAL',
): Record<string, unknown> {
  return {
    applicantId,
    inspectionId: applicantId,
    correlationId: `e2e-${Date.now()}`,
    externalUserId: `e2e-${applicantId}`,
    levelName: 'id-and-liveness',
    type: 'applicantReviewed',
    reviewResult: {
      reviewAnswer: answer,
      ...(answer === 'RED'
        ? { reviewRejectType: rejectType, rejectLabels: ['UNSATISFACTORY_PHOTOS'] }
        : {}),
    },
    reviewStatus: 'completed',
    createdAtMs: new Date().toISOString(),
  };
}
