/**
 * The preload script is generated as a string and only ever parsed inside the
 * WebView, so a broken escape in the embedded sources is invisible to `tsc`
 * and to Metro. A single invalid regex in there used to take the whole script
 * down (`Unexpected token 'return'`), which left `window.electronAPI`
 * undefined and made every renderer feature fail at startup.
 *
 * These tests therefore build the real script and evaluate it against a fake
 * window, which is the only place such a mistake surfaces.
 */
import {buildPreloadScript} from '../src/runtime/preload';

interface FakeWindow {
  [key: string]: any;
}

function evaluate(windowId = 'main') {
  const posted: any[] = [];
  const win: FakeWindow = {
    location: {href: 'http://127.0.0.1:17866/index.html', origin: 'http://127.0.0.1:17866'},
    ReactNativeWebView: {
      postMessage: (raw: string) => {
        posted.push(JSON.parse(raw));
      },
    },
  };
  const script = buildPreloadScript({windowId});
  // A fake timer keeps the evaluate step synchronous: `invoke` arms a 30s
  // timeout that must not keep Jest alive.
  const run = new Function('window', 'console', 'setTimeout', script);
  run(win, console, () => 0);
  return {win, posted};
}

describe('generated preload script', () => {
  it('parses as valid JavaScript', () => {
    const script = buildPreloadScript();
    expect(() => new Function(script)).not.toThrow();
  });

  it('exposes window.electronAPI', () => {
    const {win} = evaluate();
    expect(win.electronAPI).toBeDefined();
    expect(typeof win.electronAPI.call).toBe('function');
    expect(typeof win.electronAPI.on).toBe('function');
    expect(typeof win.electronAPI.getPlatform).toBe('function');
  });

  it('routes electronAPI.call through the bridge transport', () => {
    const {win, posted} = evaluate();
    win.electronAPI.call('config', 'config:migrate', {port: 8080});
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('invoke');
    expect(posted[0].channel).toBe('auto366:call');
    expect(posted[0].args).toEqual(['config', 'config:migrate', [{port: 8080}]]);
    expect(posted[0].windowId).toBe('main');
  });

  it('keeps the fetch relay usable for cross-origin requests', () => {
    const calls: any[] = [];
    // The script needs a real `fetch` to wrap; `evaluate()` uses a window
    // without one, so this case builds its own.
    const relayWindow: FakeWindow = {
      location: {href: 'http://127.0.0.1:17866/index.html', origin: 'http://127.0.0.1:17866'},
      ReactNativeWebView: {postMessage: () => {}},
      fetch: function (input: any) {
        calls.push(input);
        return 'ok';
      },
    };
    const script = buildPreloadScript({windowId: 'relay'});
    new Function('window', 'console', 'setTimeout', script)(relayWindow, console, () => 0);

    expect(relayWindow.__E2RN_FETCH_RELAY__).toBe(true);
    // Same origin stays direct, cross origin is relayed through the asset server.
    expect(relayWindow.fetch('/local.json')).toBe('ok');
    expect(calls[calls.length - 1]).toBe('/local.json');
    relayWindow.fetch('https://366.cyril.qzz.io/api/rules');
    expect(calls[calls.length - 1]).toBe(
      '/__e2rn/proxy?url=' + encodeURIComponent('https://366.cyril.qzz.io/api/rules'),
    );
  });

  it('reports the colour mode of the page, including every change', () => {
    const posted: any[] = [];
    const observers: Array<() => void> = [];
    let attribute: string | null = 'dark';

    const doc = {
      documentElement: {
        getAttribute: (name: string) => (name === 'data-theme' ? attribute : null),
      },
      addEventListener: () => {},
    };

    function FakeMutationObserver(this: any, callback: () => void) {
      this.observe = () => {
        observers.push(callback);
      };
      this.disconnect = () => {};
    }

    const win: FakeWindow = {
      location: {href: 'http://127.0.0.1:17866/index.html', origin: 'http://127.0.0.1:17866'},
      ReactNativeWebView: {postMessage: (raw: string) => posted.push(JSON.parse(raw))},
    };

    const script = buildPreloadScript({windowId: 'theme'});
    new Function('window', 'document', 'MutationObserver', 'console', 'setTimeout', script)(
      win,
      doc,
      FakeMutationObserver,
      console,
      () => 0,
    );

    // The value that is already applied is reported immediately.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({type: 'theme', theme: 'dark', windowId: 'theme'});

    // Flipping the attribute (the theme switch of the desktop UI) is reported.
    attribute = 'light';
    observers.forEach(callback => callback());
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({type: 'theme', theme: 'light'});

    // Repeated reports of the same value are filtered out.
    observers.forEach(callback => callback());
    expect(posted).toHaveLength(2);

    // A page without `data-theme` (an injected third party page) asks for
    // nothing - it must not repaint the native shell.
    attribute = null;
    observers.forEach(callback => callback());
    expect(posted).toHaveLength(2);
    expect(posted.every(message => message.type === 'theme')).toBe(true);
  });
});
