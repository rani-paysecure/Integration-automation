/** Which customer the session is created for. */
export type SessionCustomer =
  | { readonly mode: 'new'; readonly body: Record<string, unknown> }
  | { readonly mode: 'existing'; readonly customerId: string };

/** Create customer – POST response (only the fields the flow relies on; the rest is kept). */
export interface CustomerCreated {
  readonly customerId: string;
  readonly merchantCustomerId?: string;
  readonly brandID?: string;
  readonly [field: string]: unknown;
}

/** Create session – POST response. `sessionUrl` is the hosted payment page (same card form as the cashier). */
export interface SessionCreated {
  readonly sessionUrl: string;
  readonly sessionId: string;
  readonly customerId?: string;
  readonly brandId?: string;
  readonly expiryOn?: number;
  readonly createdOn?: number;
  readonly [field: string]: unknown;
}
