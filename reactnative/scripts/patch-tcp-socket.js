#!/usr/bin/env node
/**
 * Patches `react-native-tcp-socket` in two places.
 *
 * 1. Keystore password (native TLS server)
 *
 *   `SSLCertificateHelper.createServerSocketFactory()` hardcodes
 *   `"".toCharArray()` as the PKCS#12 password. Android's BouncyCastle provider
 *   cannot load a keystore with an empty password:
 *
 *     - an encrypted keystore fails with `password empty`;
 *     - an unencrypted one fails with
 *       `OpenSSLRSAPrivateCrtKey cannot be cast to PKCS12BagAttributeCarrier`.
 *
 *   So the MITM keystore simply cannot be opened without a real password. This
 *   script lets the TLS options carry one (`tls: {keystore, password}`), which
 *   is what `src/stubs/http-mitm-proxy.ts` passes.
 *
 * 2. SNI (native TLS client)
 *
 *   `startTLS()` creates the SSL socket with `socket.getInetAddress()
 *   .getHostAddress()` as the peer host - an *IP literal*. The platform then
 *   omits the TLS server name indication, and CDNs that route by hostname
 *   (Cloudflare / Supabase / ...) abort the handshake with
 *   `handshake_failure`. The patch forwards the optional `servername` option
 *   to `SSLParameters.setServerNames()`.
 *
 * The patch is applied to `node_modules` on `postinstall` and is idempotent.
 * If the upstream source changes, the script fails loudly instead of silently
 * producing a build whose HTTPS interception does not work.
 *
 * Usage:
 *   node scripts/patch-tcp-socket.js [--check]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE = 'react-native-tcp-socket';
const JAVA_DIR = path.join(
  __dirname,
  '..',
  'node_modules',
  PACKAGE,
  'android',
  'src',
  'main',
  'java',
  'com',
  'asterinet',
  'react',
  'tcpsocket',
);

/** Every edit: [file, marker that must be present after patching, from, to]. */
const EDITS = [
  {
    file: 'SSLCertificateHelper.java',
    done: 'createServerSocketFactory(Context context, @NonNull final String keyStoreResourceUri, @NonNull final char[] password)',
    from:
      '    static SSLServerSocketFactory createServerSocketFactory(Context context, @NonNull final String keyStoreResourceUri) throws GeneralSecurityException, IOException {\n' +
      '        char[] password = "".toCharArray();\n',
    to:
      '    static SSLServerSocketFactory createServerSocketFactory(Context context, @NonNull final String keyStoreResourceUri, @NonNull final char[] password) throws GeneralSecurityException, IOException {\n',
  },
  {
    file: 'TcpSocketServer.java',
    done: 'SSLCertificateHelper.createServerSocketFactory(context, keystoreResourceUri, keyStorePassword)',
    from:
      '            SSLServerSocketFactory ssf = SSLCertificateHelper.createServerSocketFactory(context, keystoreResourceUri);\n',
    to:
      '            // The keystore password is optional; an empty one only works for\n' +
      '            // keystores that do not need decryption (see scripts/patch-tcp-socket.js).\n' +
      '            String keyStorePasswordOption = tlsOptions.hasKey("password") ? tlsOptions.getString("password") : null;\n' +
      '            char[] keyStorePassword = keyStorePasswordOption == null ? new char[0] : keyStorePasswordOption.toCharArray();\n' +
      '            SSLServerSocketFactory ssf = SSLCertificateHelper.createServerSocketFactory(context, keystoreResourceUri, keyStorePassword);\n',
  },
  {
    file: 'TcpSocketClient.java',
    done: 'import java.util.Collections;',
    from: 'import java.util.Arrays;\n',
    to: 'import java.util.Arrays;\nimport java.util.Collections;\n',
  },
  {
    file: 'TcpSocketClient.java',
    done: 'import javax.net.ssl.SNIHostName;',
    from: 'import javax.net.ssl.SSLSocket;\nimport javax.net.ssl.SSLSocketFactory;\n',
    to:
      'import javax.net.ssl.SNIHostName;\n' +
      'import javax.net.ssl.SSLParameters;\n' +
      'import javax.net.ssl.SSLSocket;\n' +
      'import javax.net.ssl.SSLSocketFactory;\n',
  },
  {
    file: 'TcpSocketClient.java',
    done: 'applyServerName((SSLSocket) socket, tlsOptions);',
    from:
      '        socket.connect(new InetSocketAddress(remoteInetAddress, port), connectTimeout);\n' +
      '        if (socket instanceof SSLSocket) ((SSLSocket) socket).startHandshake();\n',
    to:
      '        socket.connect(new InetSocketAddress(remoteInetAddress, port), connectTimeout);\n' +
      '        if (socket instanceof SSLSocket) {\n' +
      '            applyServerName((SSLSocket) socket, tlsOptions);\n' +
      '            ((SSLSocket) socket).startHandshake();\n' +
      '        }\n',
  },
  {
    file: 'TcpSocketClient.java',
    done: 'private static void applyServerName(SSLSocket sslSocket, ReadableMap tlsOptions) {',
    from: '    private boolean containsKey(ReadableArray array, String key) {\n',
    to:
      '    /**\n' +
      '     * Sends SNI. The SSL socket is created with the peer *IP* as its host,\n' +
      '     * so the platform would omit the server name and CDNs that route by\n' +
      '     * hostname (Cloudflare / Supabase / ...) abort the handshake.\n' +
      '     */\n' +
      '    private static void applyServerName(SSLSocket sslSocket, ReadableMap tlsOptions) {\n' +
      '        if (tlsOptions == null || !tlsOptions.hasKey("servername")) return;\n' +
      '        String serverName = tlsOptions.getString("servername");\n' +
      '        if (serverName == null || serverName.isEmpty()) return;\n' +
      '        try {\n' +
      '            SSLParameters sslParameters = sslSocket.getSSLParameters();\n' +
      '            sslParameters.setServerNames(Collections.singletonList(new SNIHostName(serverName)));\n' +
      '            sslSocket.setSSLParameters(sslParameters);\n' +
      '        } catch (IllegalArgumentException ignored) {\n' +
      '            // IP literals are not valid SNI host names.\n' +
      '        }\n' +
      '    }\n' +
      '\n' +
      '    private boolean containsKey(ReadableArray array, String key) {\n',
  },
  {
    file: 'TcpSocketClient.java',
    done: 'applyServerName(sslSocket, tlsOptions);',
    from:
      '        sslSocket.setUseClientMode(true);\n' +
      '        sslSocket.startHandshake();\n',
    to:
      '        sslSocket.setUseClientMode(true);\n' +
      '        applyServerName(sslSocket, tlsOptions);\n' +
      '        sslSocket.startHandshake();\n',
  },
];

function main() {
  const checkOnly = process.argv.includes('--check');
  let changed = 0;

  for (const edit of EDITS) {
    const file = path.join(JAVA_DIR, edit.file);
    if (!fs.existsSync(file)) {
      throw new Error(`${PACKAGE} is not installed: ${file} is missing`);
    }
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes(edit.done)) {
      continue;
    }
    if (!source.includes(edit.from)) {
      throw new Error(
        `${edit.file} does not match the expected upstream source - ` +
          'review scripts/patch-tcp-socket.js before upgrading ' +
          PACKAGE,
      );
    }
    if (checkOnly) {
      process.stdout.write(`[patch-tcp-socket] ${edit.file} is NOT patched\n`);
      process.exitCode = 1;
      continue;
    }
    fs.writeFileSync(file, source.replace(edit.from, edit.to), 'utf8');
    changed += 1;
    process.stdout.write(`[patch-tcp-socket] patched ${edit.file}\n`);
  }

  if (checkOnly) {
    return;
  }
  process.stdout.write(
    changed
      ? `[patch-tcp-socket] ${changed} file(s) patched\n`
      : '[patch-tcp-socket] already patched\n',
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[patch-tcp-socket] failed: ${error && error.message ? error.message : error}\n`,
  );
  process.exit(1);
}
