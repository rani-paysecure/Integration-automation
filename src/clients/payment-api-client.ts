import { Endpoints } from '../constants/endpoints';
import { Headers } from '../constants/http';
import type { ApiResponse, RequestOptions } from '../types/api.types';
import type { CreatePaymentRequest, RefundPaymentRequest } from '../types/payment.types';
import type { PaymentResponse, RefundResponse } from '../schemas/payment.schema';
import { idempotencyKey } from '../utils/id-generator';
import { BaseApiClient, type BaseApiClientOptions } from './base-api-client';

/** Per-call options exposed to tests (auth/headers overrides for negative cases). */
export type CallOptions = Pick<RequestOptions, 'headers' | 'skipAuth' | 'timeoutMs'>;

/**
 * Payment integration API.
 * Every method maps to exactly one endpoint; no assertions live here.
 */
export class PaymentApiClient extends BaseApiClient {
  constructor(options: BaseApiClientOptions) {
    super({ ...options, logger: options.logger.child('payment-api') });
  }

  createPayment(
    payment: CreatePaymentRequest | Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<ApiResponse<PaymentResponse>> {
    return this.post<PaymentResponse>(Endpoints.payments.collection, {
      ...options,
      data: payment,
      headers: { [Headers.IDEMPOTENCY_KEY]: idempotencyKey(), ...options.headers },
    });
  }

  getPayment(paymentId: string, options: CallOptions = {}): Promise<ApiResponse<PaymentResponse>> {
    return this.get<PaymentResponse>(Endpoints.payments.byId(paymentId), options);
  }

  listPayments(
    params: { merchantReference?: string; status?: string; limit?: number } = {},
    options: CallOptions = {},
  ): Promise<ApiResponse<{ items: PaymentResponse[] }>> {
    return this.get(Endpoints.payments.collection, { ...options, params: { ...params } });
  }

  capturePayment(
    paymentId: string,
    amount?: number,
    options: CallOptions = {},
  ): Promise<ApiResponse<PaymentResponse>> {
    return this.post<PaymentResponse>(Endpoints.payments.capture(paymentId), {
      ...options,
      data: amount === undefined ? {} : { amount },
    });
  }

  refundPayment(
    paymentId: string,
    refund: RefundPaymentRequest,
    options: CallOptions = {},
  ): Promise<ApiResponse<RefundResponse>> {
    return this.post<RefundResponse>(Endpoints.payments.refund(paymentId), {
      ...options,
      data: refund,
      headers: { [Headers.IDEMPOTENCY_KEY]: idempotencyKey(), ...options.headers },
    });
  }

  cancelPayment(
    paymentId: string,
    options: CallOptions = {},
  ): Promise<ApiResponse<PaymentResponse>> {
    return this.post<PaymentResponse>(Endpoints.payments.cancel(paymentId), options);
  }
}
