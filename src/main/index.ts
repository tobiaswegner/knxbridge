import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from 'electron'
import { join } from 'node:path'
import { Bridge } from './bridge'
import { loadConfig, saveConfig, validateConfig, sanitizeConfig, type Config } from './config'
import { listInterfaces } from './netif'

const configFile = join(app.getPath('userData'), 'config.json')
let config: Config = loadConfig(configFile)
const bridge = new Bridge()
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow(show: boolean): void {
  win = new BrowserWindow({
    width: 900,
    height: 680,
    show,
    title: 'KNX Bridge',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
}

function createTray(): void {
  // 16x16 solid placeholder icon
  const img = nativeImage.createFromBuffer(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGNgGAWjYBSMglEwCkYBAAAEEAABzrVvxQAAAABJRU5ErkJggg==', 'base64')
  )
  tray = new Tray(img)
  tray.setToolTip('KNX Bridge')
  const rebuild = (): void => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show', click: () => win?.show() },
        bridge.getStatus().running
          ? { label: 'Stop bridge', click: () => void bridge.stop() }
          : { label: 'Start bridge', click: () => void bridge.start(config) },
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit() } }
      ])
    )
  }
  rebuild()
  bridge.on('status', rebuild)
  tray.on('click', () => win?.show())
}

function applyLaunchAtLogin(): void {
  app.setLoginItemSettings({ openAtLogin: config.launchAtLogin })
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => win?.show())
  app.whenReady().then(() => {
    ipcMain.handle('config:get', () => config)
    ipcMain.handle('config:save', async (_e, raw: unknown) => {
      const next = sanitizeConfig(raw)
      const errors = validateConfig(next)
      if (Object.keys(errors).length) return { ok: false, errors }
      config = next
      saveConfig(configFile, config)
      applyLaunchAtLogin()
      if (bridge.getStatus().running) await bridge.start(config) // apply immediately
      return { ok: true, errors: {} }
    })
    ipcMain.handle('interfaces:list', () => listInterfaces())
    ipcMain.handle('bridge:status', () => bridge.getStatus())
    ipcMain.handle('bridge:start', () => bridge.start(config))
    ipcMain.handle('bridge:stop', () => bridge.stop())
    bridge.on('status', (s) => send('bridge:status', s))
    bridge.on('log', (m) => send('bridge:log', { time: Date.now(), msg: m }))
    bridge.on('telegram', (t) => send('bridge:telegram', t))

    createWindow(!config.startMinimized)
    createTray()
    applyLaunchAtLogin()
    if (config.autoStart) void bridge.start(config)
  })
  app.on('before-quit', () => { quitting = true; void bridge.stop() })
  app.on('window-all-closed', () => { /* keep running in tray */ })
}
