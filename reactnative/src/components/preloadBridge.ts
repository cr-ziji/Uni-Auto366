/**
 * Page side of the E2RN bridge.
 *
 * The script below is evaluated inside the WebView. It installs the two
 * functions the React Native side talks to:
 *
 *   window.__E2RN_RECEIVE__(payload)  - called by React Native (events and
 *                                       the results of `ipcRenderer.invoke`)
 *   window.__E2RN_SEND__(payload)     - sends an arbitrary payload to
 *                                       React Native
 *
 * On top of that it exposes `window.__E2RN__`, the tiny transport that the
 * injected Electron stub (see `src/runtime/preload.ts`) is built on:
 * `invoke`, `send`, `on`, `once`, `removeListener` and `removeAllListeners`.
 *
 * The source is part of `buildPreloadScript()` so that the desktop preload
 * (`contextBridge.exposeInMainWorld('electronAPI', ...)`) can already talk to
 * React Native while it is being evaluated.
 */
export const PRELOAD_BRIDGE_SOURCE = `(function () {
  if (window.__E2RN_BRIDGE_INSTALLED__) { return; }
  window.__E2RN_BRIDGE_INSTALLED__ = true;

  var PROTOCOL_VERSION = 1;
  var BRIDGE_MESSAGE = '__E2RN_BRIDGE__';
  var INVOKE_TIMEOUT_MS = 30000;

  var sequence = 0;
  var pending = {};
  var listeners = {};
  var senderEvent = {senderId: 0, ports: []};

  function windowId() {
    try { return window.__E2RN_WINDOW_ID__ ? String(window.__E2RN_WINDOW_ID__) : undefined; }
    catch (error) { return undefined; }
  }

  function post(message) {
    try {
      if (message.windowId === undefined) {
        var id = windowId();
        if (id !== undefined) { message.windowId = id; }
      }
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      } else {
        console.warn('[e2rn] ReactNativeWebView is unavailable - IPC calls will fail.');
      }
    } catch (error) {
      console.error('[e2rn] postMessage failed', error);
    }
  }

  function invoke(channel, args) {
    return new Promise(function (resolve, reject) {
      var id = String(++sequence);
      pending[id] = {resolve: resolve, reject: reject};
      post({
        marker: BRIDGE_MESSAGE,
        version: PROTOCOL_VERSION,
        type: 'invoke',
        channel: channel,
        args: args || [],
        id: id
      });
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error('IPC timeout: ' + channel));
        }
      }, INVOKE_TIMEOUT_MS);
    });
  }

  function send(channel, args) {
    post({
      marker: BRIDGE_MESSAGE,
      version: PROTOCOL_VERSION,
      type: 'send',
      channel: channel,
      args: args || []
    });
  }

  function on(channel, listener) {
    if (typeof channel !== 'string' || typeof listener !== 'function') { return; }
    var bucket = listeners[channel] || (listeners[channel] = []);
    bucket.push(listener);
  }

  function once(channel, listener) {
    if (typeof channel !== 'string' || typeof listener !== 'function') { return; }
    var wrapper = function (event) {
      var args = Array.prototype.slice.call(arguments, 1);
      removeListener(channel, wrapper);
      listener.apply(null, [event].concat(args));
    };
    on(channel, wrapper);
  }

  function removeListener(channel, listener) {
    var bucket = listeners[channel];
    if (!bucket) { return; }
    for (var index = 0; index < bucket.length; index += 1) {
      if (bucket[index] === listener) {
        bucket.splice(index, 1);
        break;
      }
    }
    if (bucket.length === 0) { delete listeners[channel]; }
  }

  function removeAllListeners(channel) {
    if (channel === undefined) {
      listeners = {};
    } else {
      delete listeners[channel];
    }
  }

  function dispatch(channel, args) {
    var bucket = listeners[channel];
    if (!bucket || bucket.length === 0) { return; }
    var list = bucket.slice();
    var payload = Array.prototype.slice.call(args || []);
    for (var index = 0; index < list.length; index += 1) {
      try {
        list[index].apply(null, [senderEvent].concat(payload));
      } catch (error) {
        console.error('[e2rn] IPC listener for "' + channel + '" failed', error);
      }
    }
  }

  window.__E2RN_SEND__ = function (payload) {
    post(payload);
  };

  window.__E2RN_RECEIVE__ = function (payload) {
    if (!payload) { return; }
    if (payload.type === 'reply') {
      var entry = pending[payload.id];
      if (!entry) { return; }
      delete pending[payload.id];
      if (payload.ok) {
        entry.resolve(payload.value);
      } else {
        entry.reject(new Error(payload.error || 'IPC call failed'));
      }
      return;
    }
    if (payload.type === 'event') {
      dispatch(payload.channel, payload.args);
    }
  };

  window.__E2RN__ = {
    invoke: invoke,
    send: send,
    on: on,
    once: once,
    removeListener: removeListener,
    removeAllListeners: removeAllListeners,
    post: post
  };
})();`;

export default PRELOAD_BRIDGE_SOURCE;
