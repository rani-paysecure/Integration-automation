import { HttpStatus } from '@constants/http';
import { expect, test } from '@fixtures/api.fixture';

test.describe('Health check', { tag: ['@smoke'] }, () => {
  test('service is reachable and healthy', async ({ healthApi }) => {
    const response = await healthApi.check();

    expect(response).toHaveStatus(HttpStatus.OK);
    expect(response).toRespondWithin(5_000);
  });
});
