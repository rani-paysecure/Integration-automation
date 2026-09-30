/**
 * Wire shapes of the KYC module (org.pgs.service.kyc). The /kyc/* endpoints are
 * snake_case; the legacy customer endpoints are camelCase – kept apart on purpose.
 */

/** Mirrors org.pgs.service.kyc.dto.api.KycRecordView. */
export interface KycRecordView {
  kyc_id: string;
  customer_id: string | null;
  merchant_cust_id: string | null;
  product: string | null;
  status: KycStatus | null;
  provider_reference_id: string | null;
  decision_reasons: string | null;
  verification_url: string | null;
  message: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Absent entirely — not null — when the subject never opened the link. */
  verification_url_opened_at?: string;
  status_history: { status: string; message?: string; changed_at: string }[];
}

export type KycStatus =
  | 'CREATED'
  | 'AWAITING_USER'
  | 'KYC_PENDING'
  | 'KYC_IN_PROCESS'
  | 'MANUAL_REVIEW'
  | 'KYC_APPROVED'
  | 'KYC_REJECTED'
  | 'RESUBMISSION_REQUIRED'
  | 'KYC_EXPIRED'
  | 'KYC_FAILED'
  | 'KYC_CANCELLED';

/** KycExceptionHandler.body(...) — every /kyc/* failure looks like this. */
export interface KycErrorBody {
  status: 'fail';
  code: string;
  message: string;
}

/** The legacy /api/v1/* endpoints answer with ApiError instead (different shape). */
export interface ApiErrorBody {
  code: string;
  message: string;
  status?: string;
}

/** Mirrors org.pgs.model.api.Customer — camelCase, unlike the KYC endpoints. */
export interface Customer {
  customerId: string;
  merchantCustomerId: string;
  fullName?: string;
  emailId?: string;
  phoneNo?: string;
  dateOfBirth?: string;
  address?: string;
  city?: string;
  stateCode?: string;
  zipCode?: string;
  country?: string;
  brandID?: string;
  customerKycStatus?: string;
  kycStatus?: boolean;
}

/** Body of POST /kyc/create — snake_case. */
export interface CreateKycBody {
  customer_id?: string;
  merchant_cust_id?: string;
  country?: string;
  test?: boolean;
  success_redirect?: string;
  pending_redirect?: string;
  failure_redirect?: string;
  success_callback?: string;
  pending_callback?: string;
  failure_callback?: string;
  redirect_base_url?: string;
  link_ttl_minutes?: number;
  kyc_expiry_in_minutes?: number;
  metadata?: Record<string, unknown>;
}
