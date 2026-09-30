/** Card as typed on the cashier page. */
export interface CashierCard {
  readonly number: string;
  /** `MM/YY` */
  readonly expiry: string;
  readonly cvv: string;
  readonly holderName: string;
  /** Handling of a 3DS challenge (bank OTP page); absent = none. */
  readonly challenge?: ChallengeSetting;
}

export interface ChallengeSetting {
  readonly action: 'none' | 'otp' | 'manual';
  /** OTP to type; empty = read the "(OTP: 1234)" hint shown on test ACS pages. */
  readonly otp: string;
  /** Text of the submit button; empty = Submit / Continue / Verify / Confirm / OK. */
  readonly submit: string;
}

/** What happened on the 3DS challenge page, when one was shown. */
export interface ChallengeResult {
  readonly shown: boolean;
  readonly host: string;
  readonly action: 'none' | 'otp' | 'manual';
  /** e.g. "OTP entered, Submit pressed" / "completed by tester" / "not handled". */
  readonly detail: string;
  /** The OTP was typed and submitted (not just shown). */
  readonly answered?: boolean;
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
  /** Browser data the cashier sent to PGS with PAY (query of POST /npv/…) and the real screen. */
  readonly browserData?: BrowserData;
  /** Present when a 3DS challenge page was shown. */
  readonly challenge?: ChallengeResult;
  /** The challenge page was opened again after the OTP was submitted. */
  readonly challengeReshown?: boolean;
  /** One entry per time the challenge page re-opened (screenshot + page details), for the report. */
  readonly reshownEvidence?: readonly ReshownEvidence[];
}

/** What the re-opened 3DS challenge page looked like (attached to the test as artifacts). */
export interface ReshownEvidence {
  /** 1 = re-opened after the first OTP submit, 2 = after the re-entered OTP. */
  readonly attempt: number;
  readonly at: string;
  readonly pageUrl: string;
  readonly frameUrl: string;
  /** Visible text of the challenge page. */
  readonly text: string;
  readonly screenshot?: Buffer;
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

/** Device data the cashier collects in the browser and sends to PGS (forwarded to PSPs for 3DS). */
export interface BrowserData {
  /** Values sent on PAY: sw/sh screen, cd colour depth, pd pixel depth, uo timezone offset (min), ije Java enabled. */
  readonly sent: Readonly<Record<string, string>>;
  /** window.screen of the (emulated) device, read just before PAY. */
  readonly screen: { readonly width: number; readonly height: number };
}
