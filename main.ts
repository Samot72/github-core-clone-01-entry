// main.ts — the entry <-> env lifecycle, as the harness contract settles it.
//
//   1. MAKEFUN_ENV_URL names the harness origin. Without it there is nobody to
//      register with, so the process exits 1 at once.
//   2. Build the forge server (app.ts) and listen(0): the kernel picks a free
//      port. Port 8080 belongs to the harness — never bind it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register until the harness takes
//      it: 200 is the normal answer, 409 means another entry registered first
//      (not this process's problem), 400/405 are contract errors and end the
//      program. Anything else is retried with backoff, since the harness may
//      still be starting.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//   5. Close the server and exit 0; the harness then writes its export.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (see the header for the status contract). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server bound no port');
  process.stderr.write(`[entry] listening on port ${address.port}\n`);
  await register(address.port);
  process.stderr.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  process.stderr.write('[entry] done\n');
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

void main();
