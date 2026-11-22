import { describe, it, expect } from 'vitest'
import { SVC, encodeFrame, decodeFrame, encodeHpai, decodeHpai, encodeTunnelingRequest, parseIndividualAddress, formatIndividualAddress, decodeTunnelingRequest } from '../src/main/knx/frames'
import { parseCemi, toConfirmation, toIndication, L_DATA_REQ } from '../src/main/knx/cemi'
import { TunnelServer } from '../src/main/knx/tunnelServer'
import { validateConfig, defaultConfig, sanitizeConfig } from '../src/main/config'

const cemiReq = Buffer.from([L_DATA_REQ, 0, 0xbc, 0xe0, 0x00, 0x00, 0x08, 0x01, 0x01, 0x00, 0x81])
const device = { name: 't', individualAddress: 0xff00, multicastIp: '224.0.23.12', mac: Buffer.alloc(6), serial: Buffer.alloc(6) }

function setup() {
  const sent: { buf: Buffer; ip: string; port: number }[] = []
  const cemis: Buffer[] = []
  const conns: unknown[] = []
  const s = new TunnelServer({
    serverIp: '10.0.0.1', port: 3671, clientAddress: parseIndividualAddress('15.15.250')!, device,
    send: (buf, ip, port) => sent.push({ buf, ip, port }),
    onCemi: (c) => cemis.push(c), onConnection: (c) => conns.push(c),
    heartbeatTimeoutMs: 50, ackTimeoutMs: 20
  })
  const connectReq = encodeFrame(SVC.CONNECT_REQUEST, Buffer.concat([
    encodeHpai({ ip: '10.0.0.5', port: 5000 }), encodeHpai({ ip: '10.0.0.5', port: 5001 }), Buffer.from([4, 4, 2, 0])]))
  return { s, sent, cemis, conns, connectReq }
}
const from = { address: '10.0.0.5', port: 5000 }

describe('frames', () => {
  it('round trips frame and hpai', () => {
    const f = decodeFrame(encodeFrame(SVC.ROUTING_INDICATION, Buffer.from([1, 2, 3])))
    expect(f).toEqual({ service: SVC.ROUTING_INDICATION, body: Buffer.from([1, 2, 3]) })
    expect(decodeHpai(encodeHpai({ ip: '1.2.3.4', port: 3671 }))).toEqual({ ip: '1.2.3.4', port: 3671 })
    expect(decodeFrame(Buffer.from([1, 2, 3]))).toBeNull()
  })
  it('individual addresses', () => {
    expect(formatIndividualAddress(parseIndividualAddress('15.15.250')!)).toBe('15.15.250')
    expect(parseIndividualAddress('16.0.0')).toBeNull()
  })
  it('cemi conversions', () => {
    expect(parseCemi(cemiReq)).toMatchObject({ code: L_DATA_REQ, dest: 0x0801, isGroup: true })
    expect(toConfirmation(cemiReq)[0]).toBe(0x2e)
    const ind = toIndication(cemiReq, 0xfffa)
    expect(ind[0]).toBe(0x29)
    expect(ind.readUInt16BE(4)).toBe(0xfffa)
  })
})

describe('tunnel server', () => {
  it('connects, forwards, acks, rejects second client', () => {
    const { s, sent, cemis, connectReq } = setup()
    s.handle(connectReq, from)
    expect(decodeFrame(sent[0].buf)!.service).toBe(SVC.CONNECT_RESPONSE)
    expect(decodeFrame(sent[0].buf)!.body[1]).toBe(0)
    const ch = decodeFrame(sent[0].buf)!.body[0]
    s.handle(encodeTunnelingRequest(ch, 0, cemiReq), from)
    expect(cemis).toHaveLength(1)
    s.handle(encodeTunnelingRequest(ch, 0, cemiReq), from) // duplicate
    expect(cemis).toHaveLength(1)
    expect(sent.filter((x) => decodeFrame(x.buf)!.service === SVC.TUNNELING_ACK)).toHaveLength(2)
    s.handle(connectReq, { address: '10.0.0.6', port: 6000 })
    expect(decodeFrame(sent[sent.length - 1].buf)!.body[1]).toBe(0x24)
    s.stop()
  })
  it('retransmits once then disconnects without ack', async () => {
    const { s, sent, conns, connectReq } = setup()
    s.handle(connectReq, from)
    s.sendCemi(cemiReq)
    await new Promise((r) => setTimeout(r, 80))
    const reqs = sent.filter((x) => decodeFrame(x.buf)!.service === SVC.TUNNELING_REQUEST)
    expect(reqs).toHaveLength(2)
    expect(decodeTunnelingRequest(decodeFrame(reqs[0].buf)!.body)!.seq).toBe(0)
    expect(s.connected).toBe(false)
    expect(conns[conns.length - 1]).toBeNull()
  })
})

describe('config', () => {
  it('validates defaults and rejects bad multicast', () => {
    expect(validateConfig(defaultConfig)).toEqual({})
    expect(validateConfig({ ...defaultConfig, tunnelPort: 0 })).toEqual({})
    expect(validateConfig({ ...defaultConfig, multicastPort: 0 }).multicastPort).toBeDefined()
    expect(validateConfig({ ...defaultConfig, multicastAddress: '192.168.1.1' }).multicastAddress).toBeDefined()
    expect(sanitizeConfig({ multicastPort: 'x', deviceName: 'a' })).toMatchObject({ multicastPort: 3671, deviceName: 'a' })
  })
})
