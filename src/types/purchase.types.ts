/** Request contract for POST /v1/purchases/ (hosted checkout / cashier). */
export const CARD_PAYMENT_METHODS = ['VISA', 'MASTERCARD'] as const;
export type CardPaymentMethod = (typeof CARD_PAYMENT_METHODS)[number];

export interface PurchaseClient {
  readonly email: string;
  readonly country: string;
  readonly city: string;
  readonly stateCode: string;
  readonly street_address: string;
  readonly zip_code: string;
  readonly date_of_birth: string;
  readonly phone: string;
  readonly full_name: string;
}

export interface PurchaseProduct {
  readonly name: string;
  readonly price: number;
}

export interface CreatePurchaseRequest {
  readonly client: PurchaseClient;
  readonly purchase: {
    readonly currency: string;
    readonly products: readonly PurchaseProduct[];
    readonly total: number;
  };
  readonly platform: string;
  readonly brand_id: string;
  readonly send_receipt: boolean;
  readonly skip_capture: boolean;
  readonly success_redirect: string;
  readonly pending_redirect: string;
  readonly failure_redirect: string;
  readonly success_callback: string;
  readonly failure_callback: string;
  /** Card scheme, e.g. `VISA`. Typed as string so field tests can send invalid values. */
  readonly paymentMethod: string;
}
