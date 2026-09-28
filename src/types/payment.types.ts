/**
 * Request contracts for the payment integration.
 * Response contracts are inferred from the Zod schemas in `src/schemas`.
 */
export type PaymentMethodType = 'card' | 'bank_transfer' | 'wallet';

export interface CardDetails {
  readonly cardNumber: string;
  readonly expiryMonth: string;
  readonly expiryYear: string;
  readonly cvv: string;
  readonly holderName: string;
}

export interface CustomerDetails {
  readonly customerId?: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone?: string;
  readonly country: string;
}

export interface CreatePaymentRequest {
  /** Minor units (e.g. cents). */
  readonly amount: number;
  readonly currency: string;
  readonly merchantId: string;
  readonly merchantReference: string;
  readonly description?: string;
  readonly paymentMethod: {
    readonly type: PaymentMethodType;
    readonly card?: CardDetails;
  };
  readonly customer: CustomerDetails;
  readonly callbackUrl?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface RefundPaymentRequest {
  readonly amount: number;
  readonly reason?: string;
}
