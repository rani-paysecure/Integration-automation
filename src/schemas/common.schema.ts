import { z } from 'zod';

/** Generic error envelope. Align field names with the real API contract. */
export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z
    .array(
      z.object({
        field: z.string().optional(),
        message: z.string(),
      }),
    )
    .optional(),
  correlationId: z.string().optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const isoDateTime = z.iso.datetime({ offset: true });
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO-4217 currency code');
