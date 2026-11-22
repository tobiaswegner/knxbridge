import dgram from 'node:dgram'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Config } from './config'
import { findInterface } from './netif'
import { TunnelServer } from './knx/tunnelServer'
import { SVC, decodeFrame, encodeFrame, parseIndividualAddress, formatGroupAddress, formatIndividualAddress, type DeviceInfo } from './knx/frames'
import { parseCemi, toConfirmation, toIndication, L_DATA_IND } from './knx/cemi'

export interface BridgeStatus {
  running: boolean
  routingUp: boolean
  tunnelUp: boolean
  client: string | null
  tunnelPort: number | null
  rxRouting: number
  txRouting: number
  rxTunnel: number
  txTunnel: number
  error: string | null
}

export interface TelegramLog {
  time: number
  dir: 'routing→tunnel' | 'tunnel→routing'
  source: string
  dest: string
}

const DISCOVERY_GROUP = '224.0.23.12'
const DISCOVERY_PORT = 3671

export class Bridge extends EventEmitter {
  private routing: dgram.Socket | null = null
  private tunnel: dgram.Socket | null = null
  private discovery: dgram.Socket | null = null
  private server: TunnelServer | null = null
  private ownIps = new Set<string>()
  private recentSent = new Map<string, number>() // hash -> timestamp
  private status: BridgeStatus = this.blank()

  private blank(): BridgeStatus {
    return { running: false, routingUp: false, tunnelUp: false, client: null, tunnelPort: null, rxRouting: 0, txRouting: 0, rxTunnel: 0, txTunnel: 0, error: null }
  }

  getStatus(): BridgeStatus {
    return { ...this.status }
  }

  private update(p: Partial<BridgeStatus>): void {
    this.status = { ...this.status, ...p }
    this.emit('status', this.getStatus())
  }

  private log(msg: string): void {
    this.emit('log', msg)
  }

  async start(cfg: Config): Promise<void> {
    await this.stop()
    this.status = this.blank()
    this.cfg = cfg
    try {
      const rIf = findInterface(cfg.routingInterface)
      const tIf = findInterface(cfg.tunnelInterface)
      if (!rIf || !tIf) throw new Error('No usable IPv4 network interface found')
      this.ownIps = new Set([rIf.ip, tIf.ip])
      const ia = parseIndividualAddress(cfg.tunnelAddress) as number
      const device: DeviceInfo = {
        name: cfg.deviceName,
        individualAddress: ia & 0xff00, // device itself: <area.line.0>
        multicastIp: cfg.multicastAddress,
        mac: Buffer.from(tIf.mac.split(':').map((h) => parseInt(h, 16))),
        serial: Buffer.from([0x00, 0xfe, 0x4b, 0x42, 0x00, 0x01])
      }

      // Tunnel server (bind first: port 0 means the OS picks a random port)
      this.tunnel = await this.bindUdp(cfg.tunnelPort, tIf.ip, false)
      const tunnelPort = this.tunnel.address().port
      this.server = new TunnelServer({
        serverIp: tIf.ip,
        port: tunnelPort,
        clientAddress: ia,
        device,
        send: (buf, ip, port) => this.tunnel?.send(buf, port, ip),
        onCemi: (cemi) => this.fromTunnel(cemi, ia, cfg),
        onConnection: (c) => this.update({ client: c ? `${c.address}:${c.port}` : null }),
        log: (m) => this.log(m)
      })
      this.tunnel.on('message', (m, r) => this.server?.handle(m, { address: r.address, port: r.port }))
      this.server.start()
      this.update({ tunnelUp: true, tunnelPort })

      // Discovery (multicast SEARCH_REQUEST on 224.0.23.12:3671)
      try {
        this.discovery = await this.bindUdp(DISCOVERY_PORT, process.platform === 'win32' ? '0.0.0.0' : DISCOVERY_GROUP, true)
        this.discovery.addMembership(DISCOVERY_GROUP, tIf.ip)
        this.discovery.on('message', (m, r) => {
          const f = decodeFrame(m)
          if (f?.service === SVC.SEARCH_REQUEST) this.server?.handle(m, { address: r.address, port: r.port })
        })
        // responses to discovery must come from the tunnel socket (advertised endpoint)
      } catch (e) {
        this.log(`Discovery socket unavailable: ${(e as Error).message}`)
      }

      // Routing
      this.routing = await this.bindUdp(cfg.multicastPort, process.platform === 'win32' ? '0.0.0.0' : cfg.multicastAddress, true)
      this.routing.addMembership(cfg.multicastAddress, rIf.ip)
      this.routing.setMulticastInterface(rIf.ip)
      this.routing.setMulticastTTL(16)
      this.routing.setMulticastLoopback(true)
      this.routing.on('message', (m, r) => this.fromRouting(m, r.address))
      this.update({ running: true, routingUp: true })
      this.log(`Bridge started (routing ${cfg.multicastAddress}:${cfg.multicastPort} on ${rIf.ip}, tunnel ${tIf.ip}:${tunnelPort})`)
    } catch (e) {
      const msg = (e as Error).message
      await this.stop()
      this.update({ error: msg })
      this.log(`Start failed: ${msg}`)
    }
  }

  private cfg: Config | null = null

  async stop(): Promise<void> {
    this.server?.stop()
    this.server = null
    for (const s of [this.routing, this.tunnel, this.discovery]) {
      try { s?.close() } catch { /* already closed */ }
    }
    this.routing = this.tunnel = this.discovery = null
    if (this.status.running || this.status.tunnelUp) this.log('Bridge stopped')
    this.status = { ...this.blank(), error: this.status.error }
    this.emit('status', this.getStatus())
  }

  private bindUdp(port: number, addr: string, reuse: boolean): Promise<dgram.Socket> {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: reuse })
      s.once('error', reject)
      s.bind(port, addr, () => {
        s.removeListener('error', reject)
        s.on('error', (e) => this.log(`Socket error: ${e.message}`))
        resolve(s)
      })
    })
  }

  private hash(cemi: Buffer): string {
    return createHash('sha1').update(cemi).digest('hex')
  }

  private fromRouting(msg: Buffer, fromIp: string): void {
    const f = decodeFrame(msg)
    if (!f) return
    if (f.service === SVC.ROUTING_LOST_MESSAGE || f.service === SVC.ROUTING_BUSY) {
      this.log(`Routing flow control message received (0x${f.service.toString(16)})`)
      return
    }
    if (f.service !== SVC.ROUTING_INDICATION) return
    // Loop prevention: drop what we sent ourselves
    const h = this.hash(f.body)
    const now = Date.now()
    for (const [k, t] of this.recentSent) if (now - t > 2000) this.recentSent.delete(k)
    if (this.recentSent.has(h) && this.ownIps.has(fromIp)) return
    const info = parseCemi(f.body)
    if (!info || info.code !== L_DATA_IND) return
    this.status.rxRouting++
    if (!this.server?.connected) { this.emit('status', this.getStatus()); return }
    this.server.sendCemi(f.body)
    this.status.txTunnel++
    this.emitTelegram('routing→tunnel', info.source, info.dest, info.isGroup)
    this.emit('status', this.getStatus())
  }

  private fromTunnel(cemi: Buffer, clientIa: number, _cfg: Config): void {
    const info = parseCemi(cemi)
    if (!info) return
    this.status.rxTunnel++
    // confirm to the client, then publish on routing as indication
    this.server?.sendCemi(toConfirmation(cemi))
    const ind = toIndication(cemi, clientIa)
    this.recentSent.set(this.hash(ind), Date.now())
    const cfg = this.cfg
    if (cfg && this.routing) {
      this.routing.send(encodeFrame(SVC.ROUTING_INDICATION, ind), cfg.multicastPort, cfg.multicastAddress)
      this.status.txRouting++
    }
    this.emitTelegram('tunnel→routing', info.source || clientIa, info.dest, info.isGroup)
    this.emit('status', this.getStatus())
  }

  private emitTelegram(dir: TelegramLog['dir'], src: number, dst: number, group: boolean): void {
    const t: TelegramLog = { time: Date.now(), dir, source: formatIndividualAddress(src), dest: group ? formatGroupAddress(dst) : formatIndividualAddress(dst) }
    this.emit('telegram', t)
  }
}
