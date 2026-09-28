/** Card as typed on the cashier page. */
export interface CashierCard {
  readonly number: string;
  /** `MM/YY` */
  readonly expiry: string;
  readonly cvv: string;
  readonly holderName: string;
}

/** Where the cashier sent the customer after PAY. */
export type CashierOutcome =
  | 'success-redirect'
  | 'failure-redirect'
  | 'pending-redirect'
  /** PAY was rejected by the cashier API (e.g. "Invalid card details"); no redirect. */
  | 'rejected'
  /** Navigated somewhere else, e.g. a 3DS challenge page. */
  | 'other-page'
  | 'timeout';

export interface CashierPaymentResult {
  readonly outcome: CashierOutcome;
  readonly finalUrl: string;
  /** Message returned by the cashier API when PAY was rejected. */
  readonly apiMessage: string;
  /** Hosts passed through after PAY, e.g. a 3DS / PSP authentication page. */
  readonly visitedPages: readonly string[];
}

/** A card scenario to run through the cashier, with its expected result. */
export interface CashierCardScenario {
  readonly id: string;
  readonly label: string;
  readonly card: CashierCard;
  readonly expected: {
    readonly outcome: CashierOutcome;
    /** Accepted final purchase statuses, e.g. ['PAID']. */
    readonly statuses: readonly string[];
  };
}
