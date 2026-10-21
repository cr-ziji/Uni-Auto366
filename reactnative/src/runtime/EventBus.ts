/**
 * In-process event bus used by the E2RN runtime.
 *
 * Electron splits the application into a *main* process and a *renderer*
 * process that exchange messages through IPC channels. The React Native port
 * runs everything inside a single JavaScript context, therefore the channel
 * semantics are reproduced with a plain in-memory bus:
 *
 *   ipcMain.handle(channel, handler)  ->  bus.on(channel, handler)
 *   ipcMain.on(channel, listener)     ->  bus.on(channel, listener)
 *   ipcRenderer.invoke(channel, ...)  ->  bus.emitAsync(channel, event, ...)
 *   ipcRenderer.send(channel, ...)    ->  bus.emit(channel, event, ...)
 *
 * `emitAsync` implements the request/response part of `ipcMain.handle`: the
 * first listener that returns something other than `undefined` wins and its
 * value becomes the resolved value of the invocation.
 */

export type EventListener = (...args: any[]) => any;

/** Marker used to be able to remove a `once` wrapper by its original listener. */
interface OnceListener extends Function {
  __e2rnOriginal?: EventListener;
}

export class EventBus {
  private readonly listeners = new Map<string, EventListener[]>();

  /** Registers a listener and returns a function that removes it again. */
  on(channel: string, listener: EventListener): () => void {
    if (typeof channel !== 'string' || typeof listener !== 'function') {
      return () => {};
    }
    const bucket = this.listeners.get(channel) ?? [];
    bucket.push(listener);
    this.listeners.set(channel, bucket);
    return () => this.off(channel, listener);
  }

  /** Registers a listener that is removed automatically after the first call. */
  once(channel: string, listener: EventListener): () => void {
    if (typeof channel !== 'string' || typeof listener !== 'function') {
      return () => {};
    }
    const wrapper = ((...args: any[]) => {
      this.off(channel, wrapper as unknown as EventListener);
      return listener(...args);
    }) as OnceListener;
    wrapper.__e2rnOriginal = listener;
    return this.on(channel, wrapper as unknown as EventListener);
  }

  /** Removes a listener (the original function of a `once` wrapper works too). */
  off(channel: string, listener: EventListener): void {
    const bucket = this.listeners.get(channel);
    if (!bucket) {
      return;
    }
    let index = bucket.indexOf(listener);
    if (index < 0) {
      index = bucket.findIndex(entry => (entry as OnceListener).__e2rnOriginal === listener);
    }
    if (index >= 0) {
      bucket.splice(index, 1);
    }
    if (bucket.length === 0) {
      this.listeners.delete(channel);
    }
  }

  /** Alias of {@link off}. */
  removeListener(channel: string, listener: EventListener): void {
    this.off(channel, listener);
  }

  /** Calls every listener of the channel; listener errors are logged, not thrown. */
  emit(channel: string, ...args: any[]): void {
    const bucket = this.listeners.get(channel);
    if (!bucket || bucket.length === 0) {
      return;
    }
    for (const listener of bucket.slice()) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[e2rn] listener for "${channel}" failed`, error);
      }
    }
  }

  /**
   * Calls every listener of the channel and resolves with the first result
   * that is not `undefined`. A throwing listener rejects the promise - this is
   * what turns `ipcMain.handle` failures into `ipcRenderer.invoke` rejections.
   */
  async emitAsync(channel: string, ...args: any[]): Promise<any> {
    const bucket = this.listeners.get(channel);
    if (!bucket || bucket.length === 0) {
      return undefined;
    }
    for (const listener of bucket.slice()) {
      const result = await listener(...args);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  }

  /** Removes every listener of a channel (or of all channels). */
  removeAll(channel?: string): void {
    if (channel === undefined) {
      this.listeners.clear();
      return;
    }
    this.listeners.delete(channel);
  }

  /** Alias of {@link removeAll}. */
  removeAllListeners(channel?: string): void {
    this.removeAll(channel);
  }

  /** Number of listeners registered for a channel. */
  listenerCount(channel: string): number {
    return this.listeners.get(channel)?.length ?? 0;
  }

  /** Channels that currently have at least one listener. */
  channels(): string[] {
    return Array.from(this.listeners.keys());
  }
}

/** The single bus that connects the Electron shims with the WebView bridge. */
export const ipcBus = new EventBus();

export default ipcBus;
