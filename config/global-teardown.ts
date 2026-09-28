import fs from 'node:fs';

/** Removes this run's shared back-office session (session cookies). */
export default function globalTeardown(): void {
  const dir = process.env.BACKOFFICE_SESSION_DIR;
  if (dir?.includes('backoffice')) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
