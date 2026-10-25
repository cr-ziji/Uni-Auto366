#!/usr/bin/env node
/**
 * Generates the MITM certificate authority and the PKCS#12 keystore that the
 * native TLS server (`react-native-tcp-socket`) uses to terminate HTTPS.
 *
 * Why a keystore and not PEM files?
 *
 *   `react-native-tcp-socket` creates its TLS server from a PKCS#12 keystore
 *   that ships inside the APK (`res/raw`), because the private key has to be
 *   handed to the platform `SSLContext` - JavaScript cannot reach the native
 *   key material. Android cannot open a PKCS#12 file with an empty password,
 *   so the export below uses a real one (`auto366-mitm`) and
 *   `scripts/patch-tcp-socket.js` teaches the library to accept it.
 *
 * Outputs:
 *
 *   certs/auto366-ca.key          CA private key (never ships to a device)
 *   certs/auto366-ca.pem          CA certificate (install this on the client)
 *   certs/auto366-mitm.key        leaf private key
 *   certs/auto366-mitm.pem        leaf certificate (signed by the CA)
 *   android/app/src/main/res/raw/auto366_mitm.p12   leaf key + chain, password `auto366-mitm`
 *   src/mitm/ca-certificate.ts    the CA certificate as a JS string (install flow)
 *
 * The CA is only created once. Re-running the script keeps the existing CA, so
 * a certificate that was already installed on a phone keeps working; pass
 * `--force` to rotate it.
 *
 * Usage:
 *   node scripts/generate-mitm-cert.js [--force] [--out-dir <dir>]
 */
'use strict';

const {execFileSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CERT_DIR = path.join(PROJECT_ROOT, 'certs');
const ANDROID_RAW_DIR = path.join(PROJECT_ROOT, 'android', 'app', 'src', 'main', 'res', 'raw');
const KEYSTORE_NAME = 'auto366_mitm';
/**
 * Password of the PKCS#12 keystore.
 *
 * `react-native-tcp-socket` used to hardcode an empty password, which Android
 * cannot load (see scripts/patch-tcp-socket.js); the patched version reads the
 * password from the TLS options. This is a build-time constant, not a secret:
 * the keystore itself ships inside the APK.
 */
const KEYSTORE_PASSWORD = 'auto366-mitm';
const TS_OUTPUT = path.join(PROJECT_ROOT, 'src', 'mitm', 'ca-certificate.ts');

/** The names the MITM proxy has to be able to impersonate. */
const DNS_NAMES = [
  'localhost',
  'up366.cn',
  '*.up366.cn',
  'up366.com',
  '*.up366.com',
  'cyril.zone',
  '*.cyril.zone',
  '*.366.cyril.zone',
];

function parseArgs(argv) {
  const options = {force: false, certDir: DEFAULT_CERT_DIR};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg === '--out-dir' || arg === '-o') {
      options.certDir = path.resolve(argv[++i] || '');
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/generate-mitm-cert.js [--force] [--out-dir <dir>]\n',
      );
      process.exit(0);
    }
  }
  return options;
}

function openssl(args, options = {}) {
  return execFileSync('openssl', args, {encoding: 'utf8', stdio: 'pipe', ...options});
}

function run(args, cwd) {
  openssl(args, {cwd});
}

function writeOpensslConfig(file) {
  const altNames = DNS_NAMES.map(
    (name, index) => `DNS.${index + 1} = ${name}`,
  ).join('\n');
  fs.writeFileSync(
    file,
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      '[dn]',
      'CN = Auto366 MITM',
      'O = Auto366',
      '[ext]',
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = @alt_names`,
      '[alt_names]',
      altNames,
      '',
    ].join('\n'),
    'utf8',
  );
}

function build(options) {
  const certDir = options.certDir;
  fs.mkdirSync(certDir, {recursive: true});
  fs.mkdirSync(ANDROID_RAW_DIR, {recursive: true});

  const caKey = path.join(certDir, 'auto366-ca.key');
  const caPem = path.join(certDir, 'auto366-ca.pem');
  const leafKey = path.join(certDir, 'auto366-mitm.key');
  const leafCsr = path.join(certDir, 'auto366-mitm.csr');
  const leafPem = path.join(certDir, 'auto366-mitm.pem');
  const keystore = path.join(ANDROID_RAW_DIR, `${KEYSTORE_NAME}.p12`);

  const haveCa = fs.existsSync(caKey) && fs.existsSync(caPem);
  if (haveCa && !options.force) {
    process.stdout.write(`[mitm-cert] reusing the existing CA in ${certDir}\n`);
  } else {
    if (haveCa) {
      process.stdout.write('[mitm-cert] --force: rotating the CA\n');
    }
    process.stdout.write('[mitm-cert] creating the certificate authority\n');
    run(
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', caKey, '-out', caPem,
        '-days', '3650',
        '-subj', '/CN=Auto366 MITM CA/O=Auto366',
        '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-addext', 'subjectKeyIdentifier=hash',
      ],
      certDir,
    );
  }

  // The leaf is always re-signed: it is cheap and keeps the SAN list in sync
  // with the script.
  const configFile = path.join(certDir, 'auto366-mitm.cnf');
  writeOpensslConfig(configFile);

  process.stdout.write('[mitm-cert] creating the leaf certificate\n');
  run(
    [
      'req', '-new', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', leafKey, '-out', leafCsr,
      '-config', configFile,
    ],
    certDir,
  );
  run(
    [
      'x509', '-req', '-in', leafCsr,
      '-CA', caPem, '-CAkey', caKey, '-CAcreateserial',
      '-out', leafPem,
      '-days', '3650',
      '-sha256',
      '-extfile', configFile, '-extensions', 'ext',
    ],
    certDir,
  );

  // A real (non-empty) password is required: Android's PKCS#12 provider cannot
  // open a keystore with an empty password. `scripts/patch-tcp-socket.js` lets
  // the TLS server read the password from its options.
  process.stdout.write(`[mitm-cert] packaging ${KEYSTORE_NAME}.p12\n`);
  run(
    [
      'pkcs12', '-export',
      '-inkey', leafKey, '-in', leafPem, '-certfile', caPem,
      '-name', KEYSTORE_NAME,
      '-out', keystore,
      '-passout', `pass:${KEYSTORE_PASSWORD}`,
    ],
    certDir,
  );

  const caCertificate = fs.readFileSync(caPem, 'utf8').trim();
  fs.mkdirSync(path.dirname(TS_OUTPUT), {recursive: true});
  fs.writeFileSync(
    TS_OUTPUT,
    [
      '/**',
      ' * Generated by scripts/generate-mitm-cert.js - do not edit by hand.',
      ' *',
      ' * The certificate authority of the HTTPS interception. It has to be',
      ' * installed on the CLIENT (the browser / app that uses the proxy),',
      ' * otherwise every intercepted HTTPS connection is rejected.',
      ' */',
      `export const CA_CERTIFICATE_PEM = ${JSON.stringify(`${caCertificate}\n`)};`,
      '',
      '/** File name that `CertificateManager` writes the CA certificate to. */',
      'export const CA_CERTIFICATE_FILE = \'Auto366-MITM-CA.pem\';',
      '',
      `export const MITM_KEYSTORE_RESOURCE = ${JSON.stringify(KEYSTORE_NAME)};`,
      '',
      `export const MITM_KEYSTORE_PASSWORD = ${JSON.stringify(KEYSTORE_PASSWORD)};`,
      '',
      'export default {',
      '  CA_CERTIFICATE_PEM,',
      '  CA_CERTIFICATE_FILE,',
      '  MITM_KEYSTORE_RESOURCE,',
      '  MITM_KEYSTORE_PASSWORD,',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  const caInfo = openssl(['x509', '-in', caPem, '-noout', '-subject', '-dates']).trim();
  process.stdout.write(`[mitm-cert] CA: ${caInfo.replace(/\n/g, ' | ')}\n`);
  process.stdout.write(`[mitm-cert] keystore: ${path.relative(PROJECT_ROOT, keystore)}\n`);
  process.stdout.write(
    `[mitm-cert] install ${path.relative(PROJECT_ROOT, caPem)} on the client to trust the interception\n`,
  );
  process.stdout.write(`[mitm-cert] written to ${path.relative(PROJECT_ROOT, TS_OUTPUT)}\n`);
}

try {
  build(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(
    `[mitm-cert] failed: ${error && error.message ? error.message : error}\n`,
  );
  if (error && error.stderr) {
    process.stderr.write(String(error.stderr));
  }
  process.exit(1);
}
