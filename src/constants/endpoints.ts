/**
 * Central registry of API endpoint paths (relative to API_BASE_URL).
 * Keep paths here – never hard-code them in tests or clients.
 *
 * NOTE: the payment paths below are a starting template. Align them with the
 * actual integration contract of the service under test.
 */
const encode = (value: string): string => encodeURIComponent(value);

export const Endpoints = {
  health: '/health',
  purchases: {
    /** Trailing slash is part of the contract. */
    collection: '/v1/purchases/',
    byId: (purchaseId: string) => `/v1/purchases/${encode(purchaseId)}/`,
  },
  payments: {
    collection: '/v1/payments',
    byId: (paymentId: string) => `/v1/payments/${encode(paymentId)}`,
    capture: (paymentId: string) => `/v1/payments/${encode(paymentId)}/capture`,
    refund: (paymentId: string) => `/v1/payments/${encode(paymentId)}/refunds`,
    cancel: (paymentId: string) => `/v1/payments/${encode(paymentId)}/cancel`,
  },
} as const;
