import { networkInterfaces } from 'node:os'

export interface Iface {
  name: string
  ip: string
  mac: string
}

export function listInterfaces(): Iface[] {
  const out: Iface[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address, mac: a.mac })
    }
  }
  return out
}

export function findInterface(ip: string): Iface | undefined {
  const all = listInterfaces()
  return ip ? all.find((i) => i.ip === ip) : all[0]
}
