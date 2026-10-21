/**
 * The `electron` module of the React Native port.
 *
 * `metro.config.js` maps the bare import `electron` onto this file, therefore
 * the original (unmodified) Electron sources can `require('electron')` and
 * get the shims of this directory.
 *
 * Every API is exported both as a named export and through the default
 * export, because the original code uses both styles:
 *
 *   const {app, BrowserWindow} = require('electron');
 *   require('electron').ipcMain.handle(...)
 */
import {app} from './app';
import {BrowserWindow} from './browserWindow';
import {contextBridge} from './contextBridge';
import {dialog} from './dialog';
import {ipcMain} from './ipcMain';
import {ipcRenderer} from './ipcRenderer';
import {nativeTheme} from './nativeTheme';
import {screen} from './screen';
import {shell} from './shell';
import {webContents} from './webContents';
import {
  autoUpdater,
  clipboard,
  globalShortcut,
  Menu,
  Notification,
  powerMonitor,
  protocol,
  session,
  systemPreferences,
  Tray,
  utilityProcess,
  webUtils,
} from './misc';

export {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  contextBridge,
  dialog,
  globalShortcut,
  ipcMain,
  ipcRenderer,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  utilityProcess,
  webContents,
  webUtils,
};

export default {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  contextBridge,
  dialog,
  globalShortcut,
  ipcMain,
  ipcRenderer,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  utilityProcess,
  webContents,
  webUtils,
};
