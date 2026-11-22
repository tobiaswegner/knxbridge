// KNXnet/IP frame encoding/decoding (pure functions).
export const SVC = {
  SEARCH_REQUEST: 0x0201,
  SEARCH_RESPONSE: 0x0202,
  DESCRIPTION_REQUEST: 0x0203,
  DESCRIPTION_RESPONSE: 0x0204,
  CONNECT_REQUEST: 0x0205,
  CONNECT_RESPONSE: 0x0206,
  CONNECTIONSTATE_REQUEST: 0x0207,
  CONNECTIONSTATE_RESPONSE: 0x0208,
  DISCONNECT_REQUEST: 0x0209,
  DISCONNECT_RESPONSE: 0x020a,
  TUNNELING_REQUEST: 0x0420,
  TUNNELING_ACK: 0x0421,
  ROUTING_INDICATION: 0x0530,
  ROUTING_LOST_MESSAGE: 0x0531,
  ROUTING_BUSY: 0x0532
} as const

export const E_NO_ERROR = 0x00
export const E_CONNECTION_ID = 0x21
export const E_CONNECTION_TYPE = 0x22
export const E_NO_MORE_CONNECTIONS = 0x24

export interface Frame {
  service: number
  body: Buffer
}

export interface Hpai {
  ip: string
  port: number
}

export function encodeFrame(service: number, body: Buffer): Buffer {
  const h = Buffer.alloc(6)
  h[0] = 0x06
  h[1] = 0x10
  h.writeUInt16BE(service, 2)
  h.writeUInt16BE(6 + body.length, 4)
  return Buffer.concat([h, body])
}

export function decodeFrame(buf: Buffer): Frame | null {
  if (buf.length < 6 || buf[0] !== 0x06 || buf[1] !== 0x10) return null
  const total = buf.readUInt16BE(4)
  if (total < 6 || total > buf.length) return null
  return { service: buf.readUInt16BE(2), body: buf.subarray(6, total) }
}

export function encodeHpai(h: Hpai): Buffer {
  const b = Buffer.alloc(8)
  b[0] = 8
  b[1] = 0x01 // UDP
  const parts = h.ip.split('.').map(Number)
  for (let i = 0; i < 4; i++) b[2 + i] = parts[i] ?? 0
  b.writeUInt16BE(h.port, 6)
  return b
}

export function decodeHpai(buf: Buffer, off = 0): Hpai | null {
  if (buf.length < off + 8 || buf[off] !== 8) return null
  return { ip: `${buf[off + 2]}.${buf[off + 3]}.${buf[off + 4]}.${buf[off + 5]}`, port: buf.readUInt16BE(off + 6) }
}

export function ipToBuf(ip: string): Buffer {
  return Buffer.from(ip.split('.').map(Number))
}

export function parseIndividualAddress(s: string): number | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const [a, l, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (a > 15 || l > 15 || d > 255) return null
  return (a << 12) | (l << 8) | d
}

export function formatIndividualAddress(n: number): string {
  return `${n >> 12}.${(n >> 8) & 0xf}.${n & 0xff}`
}

export function formatGroupAddress(n: number): string {
  return `${n >> 11}/${(n >> 8) & 7}/${n & 0xff}`
}

// --- Discovery bodies ---

export interface DeviceInfo {
  name: string
  individualAddress: number
  multicastIp: string
  mac: Buffer
  serial: Buffer
}

export function encodeDeviceInfoDib(d: DeviceInfo): Buffer {
  const b = Buffer.alloc(54)
  b[0] = 54
  b[1] = 0x01 // DEVICE_INFO
  b[2] = 0x02 // KNX TP1
  b[3] = 0x00 // programming mode off
  b.writeUInt16BE(d.individualAddress, 4)
  b.writeUInt16BE(0, 6)
  d.serial.copy(b, 8, 0, 6)
  ipToBuf(d.multicastIp).copy(b, 14)
  d.mac.copy(b, 18, 0, 6)
  Buffer.from(d.name, 'latin1').copy(b, 24, 0, 29)
  return b
}

export function encodeSuppSvcDib(): Buffer {
  // Core, Device Mgmt, Tunneling, Routing - all v1
  return Buffer.from([10, 0x02, 0x02, 0x01, 0x03, 0x01, 0x04, 0x01, 0x05, 0x01])
}

export function encodeSearchResponse(ctrl: Hpai, d: DeviceInfo): Buffer {
  return encodeFrame(
    SVC.SEARCH_RESPONSE,
    Buffer.concat([encodeHpai(ctrl), encodeDeviceInfoDib(d), encodeSuppSvcDib()])
  )
}

export function encodeDescriptionResponse(d: DeviceInfo): Buffer {
  return encodeFrame(SVC.DESCRIPTION_RESPONSE, Buffer.concat([encodeDeviceInfoDib(d), encodeSuppSvcDib()]))
}

// --- Connection bodies ---

export function encodeConnectResponse(channel: number, status: number, data?: Hpai, ia?: number): Buffer {
  if (status !== E_NO_ERROR || !data) return encodeFrame(SVC.CONNECT_RESPONSE, Buffer.from([channel, status]))
  const crd = Buffer.alloc(4)
  crd[0] = 4
  crd[1] = 0x04 // tunnel connection
  crd.writeUInt16BE(ia ?? 0, 2)
  return encodeFrame(SVC.CONNECT_RESPONSE, Buffer.concat([Buffer.from([channel, status]), encodeHpai(data), crd]))
}

export function encodeStateResponse(channel: number, status: number): Buffer {
  return encodeFrame(SVC.CONNECTIONSTATE_RESPONSE, Buffer.from([channel, status]))
}

export function encodeDisconnect(service: number, channel: number, status: number, ctrl?: Hpai): Buffer {
  return encodeFrame(service, Buffer.concat([Buffer.from([channel, status]), ctrl ? encodeHpai(ctrl) : Buffer.alloc(0)]))
}

export function encodeTunnelingRequest(channel: number, seq: number, cemi: Buffer): Buffer {
  return encodeFrame(SVC.TUNNELING_REQUEST, Buffer.concat([Buffer.from([4, channel, seq & 0xff, 0]), cemi]))
}

export function encodeTunnelingAck(channel: number, seq: number, status = 0): Buffer {
  return encodeFrame(SVC.TUNNELING_ACK, Buffer.from([4, channel, seq & 0xff, status]))
}

export interface TunnelingBody {
  channel: number
  seq: number
  cemi: Buffer
}

export function decodeTunnelingRequest(body: Buffer): TunnelingBody | null {
  if (body.length < 5 || body[0] !== 4) return null
  return { channel: body[1], seq: body[2], cemi: body.subarray(4) }
}
