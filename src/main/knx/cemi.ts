export const L_DATA_REQ = 0x11
export const L_DATA_CON = 0x2e
export const L_DATA_IND = 0x29

export interface CemiInfo {
  code: number
  source: number
  dest: number
  isGroup: boolean
  hopCount: number
}

export function parseCemi(buf: Buffer): CemiInfo | null {
  if (buf.length < 2) return null
  const code = buf[0]
  if (code !== L_DATA_REQ && code !== L_DATA_CON && code !== L_DATA_IND) return null
  const o = 2 + buf[1]
  if (buf.length < o + 7) return null
  const ctrl2 = buf[o + 1]
  return {
    code,
    source: buf.readUInt16BE(o + 2),
    dest: buf.readUInt16BE(o + 4),
    isGroup: (ctrl2 & 0x80) !== 0,
    hopCount: (ctrl2 >> 4) & 7
  }
}

export function withCode(buf: Buffer, code: number): Buffer {
  const c = Buffer.from(buf)
  c[0] = code
  return c
}

/** Build L_Data.con for a received L_Data.req (ctrl1 bit0 = confirm: 0 = ok). */
export function toConfirmation(req: Buffer): Buffer {
  const c = withCode(req, L_DATA_CON)
  const o = 2 + c[1]
  c[o] &= 0xfe
  return c
}

/** Convert a tunnel L_Data.req to a routing-ready L_Data.ind (fills in source address if 0). */
export function toIndication(req: Buffer, fallbackSource: number): Buffer {
  const c = withCode(req, L_DATA_IND)
  const o = 2 + c[1]
  if (c.readUInt16BE(o + 2) === 0) c.writeUInt16BE(fallbackSource, o + 2)
  return c
}
