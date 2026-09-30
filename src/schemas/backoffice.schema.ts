import { z } from 'zod';

/**
 * Transaction as returned by the dashboard search (POST /trans/getAllTrans).
 * Loose on purpose – only the fields the PSP checks rely on are declared.
 */
export const backofficeTransactionSchema = z.looseObject({
  purchaseId: z.string(),
  status: z.string(),
  brand_id: z.string().optional(),
  paymentMethod: z.string().optional(),
  errorMsg: z.string().optional(),
  errorCode: z.string().optional(),
  merchantName: z.string().optional(),
  created_on: z.number().optional(),
  fx_Currency: z.string().optional(),
  fx_Amount: z.union([z.number(), z.string()]).optional(),
  purchase: z.looseObject({
    currency: z.string(),
    total: z.number(),
  }),
  transaction_data: z
    .looseObject({
      attempts: z
        .array(
          z.looseObject({
            type: z.string().optional(),
            successful: z.boolean().optional(),
            payment_method: z.string().optional(),
            error: z.looseObject({ message: z.string().optional() }).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

/**
 * Bank / PSP record for a purchase (GET /trans/getBankTrans?purchaseId=…).
 * `paymentInfo` is the request sent to the PSP, `response` the PSP answer(s);
 * both are PSP-specific, so they are kept as unknown.
 */
export const bankTransactionSchema = z.looseObject({
  orderId: z.string().optional(),
  subOrderId: z.string().optional(),
  /** Transaction ID at the PSP. */
  paymentTransId: z.string().optional(),
  bankId: z.union([z.number(), z.string()]).optional(),
  bankName: z.string().optional(),
  midName: z.string().optional(),
  merchantId: z.union([z.number(), z.string()]).optional(),
  currency: z.string().optional(),
  amt: z.union([z.number(), z.string()]).optional(),
  matchedRuleName: z.string().optional(),
  /** Masked request of the payment call (Main.createPayload, transaction call). */
  paymentInfo: z.unknown().optional(),
  /** Masked request of the refund call. */
  cancelInfo: z.unknown().optional(),
  response: z.unknown().optional(),
  allOtherRequest3ds: z.array(z.unknown()).optional(),
  refundamt: z.union([z.number(), z.string()]).optional(),
  response3ds: z.array(z.unknown()).optional(),
  allOtherRequest: z.array(z.unknown()).optional(),
  beforeCasCading: z.array(z.unknown()).optional(),
  previousRetry: z.array(z.unknown()).optional(),
});

/** Webhook PGS sent to the merchant (GET /admin/getWebhookResponse?pid=…). */
export const merchantWebhookSchema = z.looseObject({
  purchaseId: z.string().optional(),
  callback_url: z.string().optional(),
  transactionStatus: z.string().optional(),
  callTime: z.number().optional(),
  /** "Successful", "Fail-<http code>", "Error", "Error-Processing". */
  callStatus: z.string().optional(),
  channel: z.string().optional(),
});

/**
 * Refund history of a purchase (GET /trans/getPurchaseRefundDetails/<pid>).
 * The raw answer is the whole purchase incl. customer PII – only these
 * fields are kept.
 */
export const refundDetailsSchema = z.object({
  status: z.string().optional(),
  status_history: z
    .array(z.looseObject({ status: z.string().optional(), timestamp: z.number().optional() }))
    .optional(),
  totalRefunded: z.number().nullish(),
  refundable_amount: z.number().nullish(),
  refund_availability: z.unknown().optional(),
  refunds: z
    .array(
      z.looseObject({
        refundId: z.string().nullish(),
        amount: z.number().nullish(),
        status: z.string().nullish(),
        reason: z.string().nullish(),
        createdOn: z.number().nullish(),
      }),
    )
    .nullish(),
});

export type MerchantWebhook = z.infer<typeof merchantWebhookSchema>;
export type RefundDetails = z.infer<typeof refundDetailsSchema>;
/** PSP webhook received by PGS – headers and body are never kept (they hold signatures). */
export interface PspWebhook {
  readonly pspName: string;
  /** consumed / Already_Consumed / zombied */
  readonly status: string;
  readonly receiveTime: string;
}
/** One line of the Transaction Log – only the event label is kept (the text holds customer data). */
export interface TransLogEntry {
  /** Epoch seconds. */
  readonly at: number;
  /** e.g. `webhook:IN`, `webhook:OUT:paid`, `custRedirect`, `getPurchase:OUT`. */
  readonly event: string;
}
export type BackofficeTransaction = z.infer<typeof backofficeTransactionSchema>;
export type BankTransaction = z.infer<typeof bankTransactionSchema>;
