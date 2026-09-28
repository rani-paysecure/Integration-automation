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
  paymentInfo: z.unknown().optional(),
  response: z.unknown().optional(),
  response3ds: z.array(z.unknown()).optional(),
  allOtherRequest: z.array(z.unknown()).optional(),
  beforeCasCading: z.array(z.unknown()).optional(),
  previousRetry: z.array(z.unknown()).optional(),
});

export type BackofficeTransaction = z.infer<typeof backofficeTransactionSchema>;
export type BankTransaction = z.infer<typeof bankTransactionSchema>;
