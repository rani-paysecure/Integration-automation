import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface MockServer {
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

type Handler = (req: RecordedRequest) => {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** Tiny in-process HTTP server used to self-test the API client layer offline. */
export async function startMockServer(handler: Handler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const { status, body, headers } = handler(recorded);
      const payload = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
