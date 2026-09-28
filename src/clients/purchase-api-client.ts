import { Endpoints } from '../constants/endpoints';
import type { PurchaseCreated } from '../schemas/purchase.schema';
import type { ApiResponse } from '../types/api.types';
import type { CreatePurchaseRequest } from '../types/purchase.types';
import { BaseApiClient, type BaseApiClientOptions } from './base-api-client';
import type { CallOptions } from './payment-api-client';

/** Purchase (hosted checkout) API – POST /v1/purchases/. */
export class PurchaseApiClient extends BaseApiClient {
  constructor(options: BaseApiClientOptions) {
    super({ ...options, logger: options.logger.child('purchase-api') });
  }

  /**
   * Creates a purchase. Accepts any object so field tests can send
   * deliberately invalid payloads.
   */
  createPurchase(
    purchase: CreatePurchaseRequest | Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<ApiResponse<PurchaseCreated>> {
    return this.post<PurchaseCreated>(Endpoints.purchases.collection, {
      ...options,
      data: purchase,
    });
  }

  getPurchase(
    purchaseId: string,
    options: CallOptions = {},
  ): Promise<ApiResponse<PurchaseCreated>> {
    return this.get<PurchaseCreated>(Endpoints.purchases.byId(purchaseId), options);
  }
}
