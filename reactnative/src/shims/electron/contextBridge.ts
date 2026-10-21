/**
 * `contextBridge` - the Electron context bridge shim.
 *
 * Inside the WebView the real bridge is installed by the injected preload
 * script (see `src/runtime/preload.ts`). This module is the React Native side
 * of the same API and simply publishes an object on the global object.
 */

export interface ExposedApi {
  [key: string]: any;
}

/** Copies the own properties of the API (Electron clones the object). */
function cloneApi(api: any): ExposedApi {
  if (!api || typeof api !== 'object') {
    return api;
  }
  const result: ExposedApi = {};
  for (const key of Object.keys(api)) {
    result[key] = (api as any)[key];
  }
  return result;
}

export const contextBridge = {
  /** Publishes an API on the global object of the page. */
  exposeInMainWorld(key: string, api: ExposedApi): void {
    if (typeof key !== 'string' || !key) {
      throw new TypeError('[e2rn] contextBridge.exposeInMainWorld() needs a key');
    }
    const target = globalThis as any;
    try {
      target[key] = cloneApi(api);
    } catch (error) {
      console.error(`[e2rn] contextBridge could not expose "${key}"`, error);
    }
  },

  /** Synchronous variant - the React Native side is always synchronous. */
  exposeInMainWorldSync(key: string, api: ExposedApi): void {
    contextBridge.exposeInMainWorld(key, api);
  },
};

export default contextBridge;
