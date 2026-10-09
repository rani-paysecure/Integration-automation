/**
 * Central registry of API endpoint paths (relative to API_BASE_URL).
 * Keep paths here – never hard-code them in tests or clients.
 */
const encode = (value: string): string => encodeURIComponent(value);

export const Endpoints = {
  /** Back-office dashboard (session-cookie auth, served from BASE_URL). */
  backoffice: {
    loginPage: '/',
    login: '/j_spring_security_check',
    transactionsPage: '/admin/transacAdmin',
    /** Transaction search (POST, query-string filters). */
    transactions: '/trans/getAllTrans',
    /** PSP request/response + bank transaction for one purchase. */
    bankTransaction: '/trans/getBankTrans',
    fieldValidationRules: '/admin/getFieldValidationRules',
    /** Service config value by name (approved version), e.g. COMMON_GATEWAY_BLACKLISTED_LOGGING_KEYS. */
    serviceConfig: '/serviceConfiguration/name/',
    /** Webhooks PGS sent to the merchant for a purchase (Transaction log → Webhook out). */
    merchantWebhooks: '/admin/getWebhookResponse',
    /** Webhooks PGS received from PSPs (PSP Webhook log → Webhook in). */
    pspWebhooks: '/admin/pspWebhookLog/data',
    /** Reports → Transaction Log: every logged call of a purchase (`webhook:IN`, `webhook:OUT:paid`, …). */
    transLog: '/admin/v2/getTransLog',
    /** Purchase with refund history (Reports → transaction → refunds). */
    /** Merchant → KYC configuration: `{ bankMidId }` of the KYC provider MID (null = KYC off). */
    kycConfig: '/admin/getKycConfig',
    /** KYC provider MIDs (Sumsub …) selectable in the KYC configuration. */
    kycMids: '/admin/getPaymentBankMIDForKYC',
    refundDetails: (purchaseId: string) => `/trans/getPurchaseRefundDetails/${encode(purchaseId)}`,
  },
  purchases: {
    /** Trailing slash is part of the contract. */
    collection: '/v1/purchases/',
    byId: (purchaseId: string) => `/v1/purchases/${encode(purchaseId)}/`,
    /** GET = full refund, POST {amount, reason} = partial (or full) refund. */
    refund: (purchaseId: string) => `/v1/purchases/${encode(purchaseId)}/refund`,
    /** S2S card payment: POST with `?s2s=true` (card + browser data, merchant key). */
    s2s: (purchaseId: string) => `/v1/p/${encode(purchaseId)}/`,
  },
  /** Session payment. Both paths confirmed against test4 (no trailing slash). */
  customers: {
    collection: '/v1/customer',
  },
  sessions: {
    collection: '/v1/createSession',
  },
} as const;
