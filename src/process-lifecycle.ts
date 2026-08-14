import type { ChildProcess } from "node:child_process";

/** Observe the point where a child and all of its stdio handles are closed. */
export function observeChildClose(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once("close", () => resolve());
    proc.once("error", () => resolve());
  });
}

export async function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function forceCloseAfter(
  proc: ChildProcess,
  closed: Promise<void>,
  timeoutMs = 1_000,
): Promise<void> {
  if (await resolvesWithin(closed, timeoutMs)) return;
  await forceClose(proc, closed, timeoutMs);
}

export async function forceClose(
  proc: ChildProcess,
  closed: Promise<void>,
  timeoutMs = 1_000,
): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  await resolvesWithin(closed, timeoutMs);
}
