import { Endpoints } from '../constants/endpoints';
import type { ApiResponse } from '../types/api.types';
import { BaseApiClient, type BaseApiClientOptions } from './base-api-client';

export class HealthApiClient extends BaseApiClient {
  constructor(options: BaseApiClientOptions) {
    super({ ...options, logger: options.logger.child('health-api') });
  }

  check(): Promise<ApiResponse<{ status: string }>> {
    return this.get(Endpoints.health, { skipAuth: true });
  }
}
