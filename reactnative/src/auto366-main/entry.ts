/**
 * The entry point of the ported Auto366 application.
 *
 * The React Native UI (`App.tsx`) calls `startAuto366()` once, which boots
 * the original Electron main process inside the React Native runtime.
 */
import {bootstrapE2RN, type BootstrapResult} from '../bootstrap/E2RNMainBootstrap';

export type {BootstrapResult};

/** Boots the ported application (idempotent). */
export async function startAuto366(): Promise<BootstrapResult> {
  return bootstrapE2RN();
}

export default startAuto366;
