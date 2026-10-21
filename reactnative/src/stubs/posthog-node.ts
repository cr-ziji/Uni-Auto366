/**
 * Stub for the desktop `posthog-node` package.
 *
 * `modules/app/analytics.js` sends usage events to PostHog. The events are
 * optional, therefore the stub keeps the API surface (so that the original
 * module runs unmodified) but does not send anything.
 *
 * The calls are logged on the debug channel, which makes it easy to see in
 * the log file which events WOULD have been sent.
 *
 * NOTE: if the analytics must actually work on mobile, this stub has to be
 * replaced by a real implementation on top of the `https` polyfill - the
 * PostHog capture endpoint is a plain HTTP POST.
 */
import {EventEmitter} from 'events';

export interface PostHogOptions {
  host?: string;
  flushAt?: number;
  flushInterval?: number;
  disabled?: boolean;
  [key: string]: any;
}

export interface CapturePayload {
  event?: string;
  distinctId?: string;
  properties?: Record<string, any>;
  [key: string]: any;
}

export class PostHog extends EventEmitter {
  readonly apiKey: string;
  readonly options: PostHogOptions;

  constructor(apiKey: string, options: PostHogOptions = {}) {
    super();
    this.apiKey = apiKey;
    this.options = options ?? {};
  }

  capture(payload: CapturePayload | string, properties?: Record<string, any>): void {
    const event = typeof payload === 'string' ? payload : payload?.event;
    console.log(`[E2RN] analytics (not sent): ${event ?? 'unknown event'}`, properties ?? payload);
  }

  identify(payload: CapturePayload | string): void {
    const distinctId = typeof payload === 'string' ? payload : payload?.distinctId;
    console.log(`[E2RN] analytics identify (not sent): ${distinctId ?? 'unknown'}`);
  }

  alias(_from: string, _to: string): void {
    // No-op.
  }

  groupIdentify(): void {
    // No-op.
  }

  isFeatureEnabled(): boolean {
    return false;
  }

  async flush(): Promise<void> {
    // Nothing is buffered.
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }
}

export default {PostHog};
