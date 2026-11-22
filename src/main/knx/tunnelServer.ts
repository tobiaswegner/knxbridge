import {
  SVC, E_NO_ERROR, E_CONNECTION_ID, E_CONNECTION_TYPE, E_NO_MORE_CONNECTIONS,
  decodeFrame, decodeHpai, encodeConnectResponse, encodeStateResponse, encodeDisconnect,
  encodeTunnelingRequest, encodeTunnelingAck, decodeTunnelingRequest, encodeSearchResponse,
  encodeDescriptionResponse, type DeviceInfo, type Hpai
} from './frames'

export interface Remote {
  address: string
  port: number
}

export interface TunnelOptions {
  serverIp: string
  port: number
  clientAddress: number // KNX individual address handed to the client
  device: DeviceInfo
  send: (buf: Buffer, ip: string, port: number) => void
  onCemi: (cemi: Buffer) => void
  onConnection: (client: Remote | null) => void
  log?: (msg: string) => void
  heartbeatTimeoutMs?: number
  ackTimeoutMs?: number
}

interface Conn {
  channel: number
  remote: Remote // data endpoint
  control: Remote
  recvSeq: number
  sendSeq: number
  lastSeen: number
  pending: { seq: number; frame: Buffer; retried: boolean; timer: ReturnType<typeof setTimeout> } | null
  queue: Buffer[]
}

/** Single-connection KNXnet/IP tunneling server. Transport-agnostic: feed datagrams to handle(). */
export class TunnelServer {
  private conn: Conn | null = null
  private nextChannel = 1
  private watchdog: ReturnType<typeof setInterval> | null = null
  private readonly hbTimeout: number
  private readonly ackTimeout: number

  constructor(private o: TunnelOptions) {
    this.hbTimeout = o.heartbeatTimeoutMs ?? 120_000
    this.ackTimeout = o.ackTimeoutMs ?? 1_000
  }

  get connected(): boolean {
    return this.conn !== null
  }

  start(): void {
    this.watchdog = setInterval(() => {
      if (this.conn && Date.now() - this.conn.lastSeen > this.hbTimeout) {
        this.o.log?.('Tunnel heartbeat timeout')
        this.drop(true)
      }
    }, Math.min(10_000, this.hbTimeout / 2))
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.drop(true)
  }

  /** Send a cEMI frame to the tunnel client (queued; one in flight at a time). */
  sendCemi(cemi: Buffer): void {
    const c = this.conn
    if (!c) return
    c.queue.push(cemi)
    this.pump(c)
  }

  handle(msg: Buffer, from: Remote): void {
    const f = decodeFrame(msg)
    if (!f) return
    switch (f.service) {
      case SVC.SEARCH_REQUEST: {
        const h = decodeHpai(f.body)
        const dest = this.endpoint(h, from)
        this.o.send(encodeSearchResponse({ ip: this.o.serverIp, port: this.o.port }, this.o.device), dest.address, dest.port)
        break
      }
      case SVC.DESCRIPTION_REQUEST: {
        const h = decodeHpai(f.body)
        const dest = this.endpoint(h, from)
        this.o.send(encodeDescriptionResponse(this.o.device), dest.address, dest.port)
        break
      }
      case SVC.CONNECT_REQUEST:
        return this.onConnect(f.body, from)
      case SVC.CONNECTIONSTATE_REQUEST: {
        const ch = f.body[0]
        const c = this.conn
        const dest = this.endpoint(decodeHpai(f.body, 2), from)
        if (!c || c.channel !== ch) {
          this.o.send(encodeStateResponse(ch, E_CONNECTION_ID), dest.address, dest.port)
        } else {
          c.lastSeen = Date.now()
          this.o.send(encodeStateResponse(ch, E_NO_ERROR), dest.address, dest.port)
        }
        break
      }
      case SVC.DISCONNECT_REQUEST: {
        const ch = f.body[0]
        const dest = this.endpoint(decodeHpai(f.body, 2), from)
        if (this.conn && this.conn.channel === ch) {
          this.o.send(encodeDisconnect(SVC.DISCONNECT_RESPONSE, ch, E_NO_ERROR), dest.address, dest.port)
          this.drop(false)
        } else {
          this.o.send(encodeDisconnect(SVC.DISCONNECT_RESPONSE, ch, E_CONNECTION_ID), dest.address, dest.port)
        }
        break
      }
      case SVC.TUNNELING_REQUEST:
        return this.onTunnelingRequest(f.body)
      case SVC.TUNNELING_ACK:
        return this.onAck(f.body)
    }
  }

  private endpoint(h: Hpai | null, from: Remote): Remote {
    if (!h || h.ip === '0.0.0.0' || h.port === 0) return from // NAT mode
    return { address: h.ip, port: h.port }
  }

  private onConnect(body: Buffer, from: Remote): void {
    const ctrl = this.endpoint(decodeHpai(body, 0), from)
    const data = this.endpoint(decodeHpai(body, 8), from)
    const cri = body.subarray(16)
    if (cri.length < 4 || cri[1] !== 0x04 || cri[2] !== 0x02) {
      // only tunnel connection, link layer
      this.o.send(encodeConnectResponse(0, E_CONNECTION_TYPE), ctrl.address, ctrl.port)
      return
    }
    if (this.conn) {
      this.o.log?.(`Rejected tunnel connect from ${from.address}: already connected`)
      this.o.send(encodeConnectResponse(0, E_NO_MORE_CONNECTIONS), ctrl.address, ctrl.port)
      return
    }
    const channel = this.nextChannel
    this.nextChannel = (this.nextChannel % 255) + 1
    this.conn = { channel, remote: data, control: ctrl, recvSeq: 0, sendSeq: 0, lastSeen: Date.now(), pending: null, queue: [] }
    this.o.send(
      encodeConnectResponse(channel, E_NO_ERROR, { ip: this.o.serverIp, port: this.o.port }, this.o.clientAddress),
      ctrl.address, ctrl.port
    )
    this.o.log?.(`Tunnel client connected: ${data.address}:${data.port} (channel ${channel})`)
    this.o.onConnection(data)
  }

  private onTunnelingRequest(body: Buffer): void {
    const t = decodeTunnelingRequest(body)
    const c = this.conn
    if (!t || !c || t.channel !== c.channel) return
    c.lastSeen = Date.now()
    const ack = (): void => this.o.send(encodeTunnelingAck(c.channel, t.seq), c.remote.address, c.remote.port)
    if (t.seq === c.recvSeq) {
      ack()
      c.recvSeq = (c.recvSeq + 1) & 0xff
      this.o.onCemi(t.cemi)
    } else if (t.seq === ((c.recvSeq - 1) & 0xff)) {
      ack() // duplicate (our ack was lost): ack again, don't forward
    }
  }

  private onAck(body: Buffer): void {
    const c = this.conn
    if (!c || body.length < 4 || body[1] !== c.channel) return
    c.lastSeen = Date.now()
    if (c.pending && c.pending.seq === body[2]) {
      clearTimeout(c.pending.timer)
      c.pending = null
      this.pump(c)
    }
  }

  private pump(c: Conn): void {
    if (c.pending || c.queue.length === 0 || this.conn !== c) return
    const cemi = c.queue.shift() as Buffer
    const seq = c.sendSeq
    c.sendSeq = (c.sendSeq + 1) & 0xff
    const frame = encodeTunnelingRequest(c.channel, seq, cemi)
    const arm = (): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        if (this.conn !== c || !c.pending) return
        if (!c.pending.retried) {
          c.pending.retried = true
          this.o.send(frame, c.remote.address, c.remote.port)
          c.pending.timer = arm()
        } else {
          this.o.log?.('No tunneling ack from client, disconnecting')
          this.drop(true)
        }
      }, this.ackTimeout)
    c.pending = { seq, frame, retried: false, timer: arm() }
    this.o.send(frame, c.remote.address, c.remote.port)
  }

  private drop(notifyClient: boolean): void {
    const c = this.conn
    if (!c) return
    if (c.pending) clearTimeout(c.pending.timer)
    this.conn = null
    if (notifyClient) {
      this.o.send(
        encodeDisconnect(SVC.DISCONNECT_REQUEST, c.channel, E_NO_ERROR, { ip: this.o.serverIp, port: this.o.port }),
        c.control.address, c.control.port
      )
    }
    this.o.log?.('Tunnel client disconnected')
    this.o.onConnection(null)
  }
}
