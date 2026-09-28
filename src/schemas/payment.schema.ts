import { z } from 'zod';
import { currencyCode, isoDateTime } from './common.schema';

export const PAYMENT_STATUSES = [
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'SETTLED',
  'DECLINED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;

export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

export const paymentResponseSchema = z.object({
  paymentId: z.string().min(1),
  merchantId: z.string().min(1),
  merchantReference: z.string().min(1),
  status: paymentStatusSchema,
  amount: z.number().int().nonnegative(),
  currency: currencyCode,
  createdAt: isoDateTime,
  updatedAt: isoDateTime.optional(),
  paymentMethod: z.object({
    type: z.string(),
    /** Only masked card data may ever be returned. */
    last4: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    brand: z.string().optional(),
  }),
});

export const refundResponseSchema = z.object({
  refundId: z.string().min(1),
  paymentId: z.string().min(1),
  amount: z.number().int().positive(),
  currency: currencyCode,
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']),
  createdAt: isoDateTime,
});

export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export type PaymentResponse = z.infer<typeof paymentResponseSchema>;
export type RefundResponse = z.infer<typeof refundResponseSchema>;
