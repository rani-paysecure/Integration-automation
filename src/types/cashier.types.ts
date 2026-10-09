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
  readonly action: 'none' | 'otp' | 'manual' | 'flow';
  /** OTP to type; empty = read the "(OTP: 1234)" hint shown on test ACS pages. */
  readonly otp: string;
  /** Text of the submit button; empty = Submit / Continue / Verify / Confirm / OK. */
  readonly submit: string;
  /** action "flow": ids on the 3DS flows page. */
  readonly flowId?: string;
  readonly scenarioId?: string;
  /** action "flow": the scenario's steps, resolved from settings (values filled in). */
  readonly flow?: ResolvedThreeDsFlow | undefined;
}

export type ThreeDsAction = 'waitText' | 'fill' | 'click' | 'select' | 'check' | 'wait' | 'expire';

/** One bank's 3DS scenario, ready to run on the 3DS page. */
export interface ResolvedThreeDsFlow {
  readonly bank: string;
  readonly scenario: string;
  readonly outcome: 'success' | 'failure' | 'pending' | 'timeout' | 'other';
  readonly steps: readonly {
    readonly action: ThreeDsAction;
    readonly target: string;
    /** Value with {detail} placeholders filled in. */
    readonly value: string;
    /** Shown in the report instead of the value (secrets / customer data are not printed). */
    readonly shown: string;
  }[];
}

/** What happened on the 3DS challenge page, when one was shown. */
/**
 * What a bank's 3DS page shows – read by the test so the launcher can create a Dynamic 3DS flow
 * from it ("Create 3DS flow from this page"). Labels, option texts and button texts only:
 * never what is typed into a field.
 */
export interface ThreeDsPageCapture {
  /** Page address without query string (no session tokens). */
  readonly url: string;
  readonly host: string;
  readonly heading: string;
  readonly dropdowns: readonly {
    readonly label: string;
    readonly name: string;
    readonly options: readonly string[];
  }[];
  readonly inputs: readonly {
    readonly label: string;
    readonly name: string;
    readonly type: string;
  }[];
  readonly buttons: readonly string[];
  readonly capturedAt: string;
  /** JPEG of the page when it was read. */
  readonly screenshot?: Buffer;
}

export interface ChallengeResult {
  readonly shown: boolean;
  readonly host: string;
  readonly action: 'none' | 'otp' | 'manual' | 'flow';
  /** e.g. "OTP entered, Submit pressed" / "completed by tester" / "not handled". */
  readonly detail: string;
  /** The OTP was typed and submitted (not just shown). */
  readonly answered?: boolean;
  /** The 3DS page could not be completed – the payment stops waiting soon instead of timing out. */
  readonly stuck?: boolean;
  /** The 3DS page as the test saw it (for "Create 3DS flow from this page"). */
  readonly page?: ThreeDsPageCapture;
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
