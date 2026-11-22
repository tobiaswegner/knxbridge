import { contextBridge, ipcRenderer } from 'electron'

const on = (ch: string) => (cb: (v: any) => void) => {
  const l = (_: unknown, v: unknown): void => cb(v)
  ipcRenderer.on(ch, l)
  return () => ipcRenderer.removeListener(ch, l)
}

const api = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (c: unknown) => ipcRenderer.invoke('config:save', c),
  listInterfaces: () => ipcRenderer.invoke('interfaces:list'),
  getStatus: () => ipcRenderer.invoke('bridge:status'),
  start: () => ipcRenderer.invoke('bridge:start'),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  onStatus: on('bridge:status'),
  onLog: on('bridge:log'),
  onTelegram: on('bridge:telegram')
}

contextBridge.exposeInMainWorld('knx', api)
export type KnxApi = typeof api
