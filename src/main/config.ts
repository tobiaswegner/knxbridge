import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseIndividualAddress } from './knx/frames'

export interface Config {
  multicastAddress: string
  multicastPort: number
  routingInterface: string // IPv4 of interface, '' = auto
  tunnelInterface: string // IPv4 of interface, '' = auto
  tunnelPort: number
  tunnelAddress: string // individual address assigned to tunnel client
  deviceName: string
  autoStart: boolean
  startMinimized: boolean
  launchAtLogin: boolean
}

export const defaultConfig: Config = {
  multicastAddress: '224.0.23.12',
  multicastPort: 3671,
  routingInterface: '',
  tunnelInterface: '',
  tunnelPort: 3671,
  tunnelAddress: '15.15.250',
  deviceName: 'KNX Bridge',
  autoStart: true,
  startMinimized: false,
  launchAtLogin: false
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function ipv4(s: string): number[] | null {
  const m = IPV4.exec(s)
  if (!m) return null
  const p = m.slice(1).map(Number)
  return p.every((n) => n <= 255) ? p : null
}

/** Returns a map of field -> error message; empty when valid. */
export function validateConfig(c: Config): Partial<Record<keyof Config, string>> {
  const e: Partial<Record<keyof Config, string>> = {}
  const mc = ipv4(c.multicastAddress)
  if (!mc || mc[0] < 224 || mc[0] > 239) e.multicastAddress = 'Must be an IPv4 multicast address (224.0.0.0 - 239.255.255.255)'
  else if (mc[0] === 224 && mc[1] === 0 && mc[2] === 0) e.multicastAddress = 'Link-local reserved range 224.0.0.x is not allowed'
  if (!Number.isInteger(c.multicastPort) || c.multicastPort < 1 || c.multicastPort > 65535) e.multicastPort = 'Port must be 1-65535'
  if (!Number.isInteger(c.tunnelPort) || c.tunnelPort < 0 || c.tunnelPort > 65535) e.tunnelPort = 'Port must be 0 (random) or 1-65535'
  for (const k of ['routingInterface', 'tunnelInterface'] as const) {
    if (c[k] !== '' && !ipv4(c[k])) e[k] = 'Must be an IPv4 address or empty (auto)'
  }
  if (parseIndividualAddress(c.tunnelAddress) === null) e.tunnelAddress = 'Format area.line.device, e.g. 15.15.250'
  if (!c.deviceName.trim() || c.deviceName.length > 29) e.deviceName = 'Name must be 1-29 characters'
  return e
}

/** Merge unknown/partial stored data over defaults, dropping wrong-typed values. */
export function sanitizeConfig(raw: unknown): Config {
  const out: Config = { ...defaultConfig }
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(defaultConfig) as (keyof Config)[]) {
      const v = (raw as Record<string, unknown>)[k]
      if (typeof v === typeof defaultConfig[k]) (out as unknown as Record<string, unknown>)[k] = v
    }
  }
  return out
}

export function loadConfig(file: string): Config {
  try {
    return sanitizeConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { ...defaultConfig }
  }
}

export function saveConfig(file: string, c: Config): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(c, null, 2))
}
