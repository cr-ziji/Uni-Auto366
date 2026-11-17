/**
 * Start-up gate.
 *
 * The WebView is created by the ported Electron main process, but its page
 * starts running JavaScript as soon as the WebView exists. Every call the page
 * makes (`electronAPI.call`, `get-ui-mode`, ...) is an `ipcRenderer.invoke`,
 * which reaches the in-process bus *before* `main.js` has registered its
 * handlers when boot is slow. The bus then has no listener, `emitAsync`
 * resolves `undefined`, and the renderer sees a request that never gets a real
 * answer - previously reported as "IPC timeout".
 *
 * This module is a tiny promise gate that lets the bridge hold those calls back
 * until the boot finished. It deliberately has no imports, so both the
 * bootstrap and the bridge can use it without creating a cycle.
 */
type GateState = 'idle' | 'running' | 'done';

let state: GateState = 'idle';
let releaseGate: (() => void) | null = null;
let gate: Promise<void> = Promise.resolve();

/** Called by the bootstrap before the first stage runs. */
export function beginStartup(): void {
  if (state !== 'idle') {
    return;
  }
  state = 'running';
  gate = new Promise<void>(resolve => {
    releaseGate = resolve;
  });
}

/** Marks the boot as finished (successful or not); idempotent. */
export function markStartupComplete(): void {
  state = 'done';
  if (releaseGate) {
    const release = releaseGate;
    releaseGate = null;
    release();
  }
}

/**
 * Resolves once the boot has finished, or after `timeoutMs`.
 *
 * The timeout is a safety net only: a boot that never finishes must not turn
 * every renderer call into a hang. When the boot never started (tests, or a
 * host without the bootstrap) this resolves immediately.
 */
export async function whenStartupComplete(timeoutMs = 60000): Promise<void> {
  if (state !== 'running') {
    return;
  }
  await Promise.race([
    gate,
    new Promise<void>(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

/** `true` while the boot is still running. */
export function isStartupPending(): boolean {
  return state === 'running';
}

export default {beginStartup, markStartupComplete, whenStartupComplete, isStartupPending};
