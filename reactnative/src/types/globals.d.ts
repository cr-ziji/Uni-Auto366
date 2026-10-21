/**
 * Ambient declarations for the CommonJS globals that the React Native bundle
 * provides to every module.
 *
 * The polyfills that have to expose a *callable* module (the desktop code does
 * `const archiver = require('archiver')` and calls the result) assign to
 * `module.exports`. TypeScript does not know that global, so it is declared
 * here.
 *
 * This file only contains type information - it is never bundled.
 */
declare var module: {exports: any};
declare var exports: any;
declare var require: any;
declare var __dirname: string;
declare var __filename: string;
