import { z } from 'zod';

/**
 * Error envelope returned by the purchase API, e.g.
 * `{"message":"Authorization header missing","code":"authentication_failed"}`.
 */
export const purchaseErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
});

/** Purchase created (HTTP 202). Loose object – unknown extra fields are allowed. */
export const purchaseCreatedSchema = z.looseObject({
  purchaseId: z.string().min(1),
  status: z.string().min(1),
  type: z.literal('purchase'),
  brand_id: z.string().min(1),
  paymentMethod: z.string(),
  checkout_url: z.url(),
  merchantRef: z.string(),
  created_on: z.number().int().positive(),
  client: z.looseObject({
    email: z.string(),
    country: z.string(),
  }),
  purchase: z.looseObject({
    currency: z.string().length(3),
    total: z.number(),
    products: z.array(z.looseObject({ name: z.string(), price: z.number() })).min(1),
  }),
});

export type PurchaseError = z.infer<typeof purchaseErrorSchema>;
export type PurchaseCreated = z.infer<typeof purchaseCreatedSchema>;
