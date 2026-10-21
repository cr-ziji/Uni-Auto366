/**
 * `uuid` polyfill for React Native.
 *
 * Only the pieces the desktop sources rely on are implemented: `v4()` (random
 * UUID) and `validate()`. `v1()` needs a MAC address and a clock sequence,
 * which do not exist on mobile, therefore it reports the limitation instead of
 * returning a bogus value.
 */
import {randomBytes} from './crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Generates a RFC 4122 version 4 (random) UUID. */
export function v4(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Not supported on mobile (requires a stable node identifier). */
export function v1(): string {
  throw new Error('uuid.v1() is not supported on React Native');
}

/** `true` when the given value is a well formed UUID. */
export function validate(value: string): boolean {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Not supported on mobile. */
export function v3(): string {
  throw new Error('uuid.v3() is not supported on React Native');
}

/** Not supported on mobile. */
export function v5(): string {
  throw new Error('uuid.v5() is not supported on React Native');
}

/** Not supported on mobile. */
export function v6(): string {
  throw new Error('uuid.v6() is not supported on React Native');
}

/** Not supported on mobile. */
export function v7(): string {
  throw new Error('uuid.v7() is not supported on React Native');
}

export default {v1, v3, v4, v5, v6, v7, validate};
