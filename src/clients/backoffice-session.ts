import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';

export type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

/**
 * Where a back-office session (cookies) is shared between Playwright workers.
 *
 * The dashboard allows ONE active session per user: every new login ends the
 * previous one. All workers of a run therefore reuse a single login instead
 * of logging in themselves.
 */
export interface SessionStore {
  read(): StorageState | undefined;
  write(state: StorageState): void;
  /** Runs `fn` while holding an exclusive cross-process lock. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

const LOCK_TIMEOUT_MS = 90_000;
const STALE_LOCK_MS = 120_000;
const POLL_MS = 250;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** File-based store: `<file>` holds the state, `<file>.lock/` is the mutex. */
export class FileSessionStore implements SessionStore {
  private readonly lockDir: string;

  constructor(private readonly file: string) {
    this.lockDir = `${file}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  read(): StorageState | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as StorageState;
    } catch {
      return undefined;
    }
  }

  write(state: StorageState): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    for (;;) {
      try {
        fs.mkdirSync(this.lockDir);
        break;
      } catch {
        const age =
          Date.now() - (fs.statSync(this.lockDir, { throwIfNoEntry: false })?.mtimeMs ?? 0);
        if (age > STALE_LOCK_MS) fs.rmSync(this.lockDir, { recursive: true, force: true });
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
          throw new Error('Timed out waiting for the back-office login lock');
        }
        await sleep(POLL_MS);
      }
    }
    try {
      return await fn();
    } finally {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    }
  }
}

/** In-memory store (single process, e.g. unit tests). */
export class MemorySessionStore implements SessionStore {
  private state: StorageState | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  read(): StorageState | undefined {
    return this.state;
  }

  write(state: StorageState): void {
    this.state = state;
  }

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
