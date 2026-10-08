import { expect, test } from '@playwright/test';
import type { HttpExchange } from '@app-types/api.types';
import { collapsePolls } from '@utils/exchanges';

const call = (method: 'GET' | 'POST', url: string, status: string, at: string): HttpExchange => ({
  timestamp: at,
  request: { method, url, headers: {} },
  response: {
    status: 202,
    statusText: 'Accepted',
    headers: {},
    body: { status, updated_on: at },
    durationMs: 400,
  },
});

test.describe('Report: HTTP calls', () => {
  test('repeated status polls collapse into one entry; status changes stay visible', () => {
    const url = 'https://test4/api/v1/purchases/p1/';
    const xs = [
      call('POST', 'https://test4/api/v1/purchases/', 'CREATED', 't0'),
      call('GET', url, 'PENDING', 't1'),
      call('GET', url, 'PENDING', 't2'),
      call('GET', url, 'PENDING', 't3'),
      call('GET', url, 'PAID', 't4'),
      call('GET', url, 'PAID', 't5'),
    ];
    const out = collapsePolls(xs);
    expect(
      out.map((x) => [
        x.request.method,
        (x.response?.body as { status: string }).status,
        x.repeats ?? 1,
        x.lastAt ?? x.timestamp,
      ]),
    ).toEqual([
      ['POST', 'CREATED', 1, 't0'],
      ['GET', 'PENDING', 3, 't3'],
      ['GET', 'PAID', 2, 't5'],
    ]);
  });
});
