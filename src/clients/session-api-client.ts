import { Endpoints } from '../constants/endpoints';
import type { ApiResponse } from '../types/api.types';
import type { CustomerCreated, SessionCreated } from '../types/session.types';
import { BaseApiClient, type BaseApiClientOptions } from './base-api-client';
import type { CallOptions } from './base-api-client';

/** Session payment API: create customer (POST) → create session (POST, needs the customerId). */
export class SessionApiClient extends BaseApiClient {
  constructor(options: BaseApiClientOptions) {
    super({ ...options, logger: options.logger.child('session-api') });
  }

  /** `merchantCustomerId` must be unique for every customer. Accepts any object for negative cases. */
  createCustomer(
    customer: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<ApiResponse<CustomerCreated>> {
    return this.post<CustomerCreated>(Endpoints.customers.collection, {
      ...options,
      data: customer,
    });
  }

  /** Creates the payment session for a customer; the answer carries `sessionUrl` and `sessionId`. */
  createSession(
    session: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<ApiResponse<SessionCreated>> {
    return this.post<SessionCreated>(Endpoints.sessions.collection, {
      ...options,
      data: session,
    });
  }
}
