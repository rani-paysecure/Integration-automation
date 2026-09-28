import { randomUUID } from 'node:crypto';

/** Unique, human-readable reference such as `AUTO-QA-lx3k9a-1f2e3d4c`. */
export function uniqueReference(prefix = 'AUTO'): string {
  const time = Date.now().toString(36);
  const random = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${prefix}-${time}-${random}`.toUpperCase();
}

export function correlationId(): string {
  return randomUUID();
}

export function idempotencyKey(): string {
  return randomUUID();
}
