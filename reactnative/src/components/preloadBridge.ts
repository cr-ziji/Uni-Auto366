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

  // The page is served from http://127.0.0.1:<asset port>, so every request to
  // another origin is cross-origin and needs CORS headers from the server. The
  // rule-set API (366.cyril.qzz.io) does not send them for the download
  // endpoints, which broke "get extension rule set" / upload / download even
  // though the desktop build had no such restriction.
  //
  // Cross-origin calls are therefore relayed through a same-origin endpoint of
  // the asset server; the main context issues the real request with the Node
  // http shim and streams the answer back unchanged.
  var PROXY_PATH = '/__e2rn/proxy';

  function isSameOrigin(url) {
    try {
      var parsed = new URL(url, window.location.href);
      return parsed.origin === window.location.origin;
    } catch (error) {
      return true;
    }
  }

  function copyHeaders(source) {
    var headers = {};
    if (!source) { return headers; }
    if (typeof Headers !== 'undefined' && source instanceof Headers) {
      source.forEach(function (value, name) { headers[name] = value; });
      return headers;
    }
    if (Array.isArray(source)) {
      for (var index = 0; index < source.length; index += 1) {
        headers[String(source[index][0])] = String(source[index][1]);
      }
      return headers;
    }
    for (var name in source) {
      if (Object.prototype.hasOwnProperty.call(source, name)) {
        headers[name] = String(source[name]);
      }
    }
    return headers;
  }

  function installFetchRelay() {
    var nativeFetch = window.fetch;
    if (typeof nativeFetch !== 'function' || window.__E2RN_FETCH_RELAY__) { return; }
    window.__E2RN_FETCH_RELAY__ = true;

    window.fetch = function (input, init) {
      var url = '';
      if (typeof input === 'string') { url = input; }
      else if (input && typeof input.url === 'string') { url = input.url; }
      // Kept free of regular expressions and escapes on purpose: this source is
      // itself a template literal, so a regex written with escaped slashes would
      // ship broken and take the whole injected script down with a syntax error.
      var lowerUrl = url.toLowerCase();
      var isHttp = lowerUrl.indexOf('http://') === 0 || lowerUrl.indexOf('https://') === 0;
      if (!isHttp || isSameOrigin(url)) {
        return nativeFetch.apply(window, arguments);
      }
      try {
        var options = init || {};
        var body = options.body;
        // FormData / Blob / ArrayBuffer are encoded by the browser while sending
        // the same-origin request; the relay forwards the body (and the
        // generated content-type, boundary included) untouched.
        return nativeFetch.call(window, PROXY_PATH + '?url=' + encodeURIComponent(url), {
          method: options.method || (input && input.method) || 'GET',
          headers: copyHeaders(options.headers),
          body: body,
          mode: 'same-origin',
          credentials: options.credentials || 'omit',
          cache: 'no-store'
        });
      } catch (error) {
        console.warn('[e2rn] fetch relay failed, using a direct request', error);
        return nativeFetch.apply(window, arguments);
      }
    };
  }

  installFetchRelay();
})();`;

export default PRELOAD_BRIDGE_SOURCE;
