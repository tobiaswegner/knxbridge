import type React from 'react'
import { useEffect, useRef, useState } from 'react'

/* eslint-disable @typescript-eslint/no-explicit-any */
const knx = (window as any).knx

interface Config {
  multicastAddress: string; multicastPort: number; routingInterface: string
  tunnelInterface: string; tunnelPort: number; tunnelAddress: string; deviceName: string
  autoStart: boolean; startMinimized: boolean; launchAtLogin: boolean
}
interface Status {
  running: boolean; tunnelPort: number | null; routingUp: boolean; tunnelUp: boolean; client: string | null
  rxRouting: number; txRouting: number; rxTunnel: number; txTunnel: number; error: string | null
}

export function App(): React.JSX.Element {
  const [cfg, setCfg] = useState<Config | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [ifaces, setIfaces] = useState<{ name: string; ip: string }[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const paused = useRef(false)
  const [pause, setPause] = useState(false)
  paused.current = pause

  useEffect(() => {
    knx.getConfig().then(setCfg)
    knx.listInterfaces().then(setIfaces)
    knx.getStatus().then(setStatus)
    const push = (s: string): void => { if (!paused.current) setLines((l) => [...l.slice(-499), s]) }
    const t = (d: number): string => new Date(d).toLocaleTimeString()
    const offs = [
      knx.onStatus(setStatus),
      knx.onLog((l: any) => push(`${t(l.time)}  ${l.msg}`)),
      knx.onTelegram((x: any) => push(`${t(x.time)}  ${x.dir}  ${x.source} → ${x.dest}`))
    ]
    return () => offs.forEach((o: () => void) => o())
  }, [])

  if (!cfg) return <div />
  const set = <K extends keyof Config>(k: K, v: Config[K]): void => { setSaved(false); setCfg({ ...cfg, [k]: v }) }
  const text = (k: keyof Config, label: string): React.JSX.Element => (
    <>
      <label>{label}</label>
      <input value={String(cfg[k])} onChange={(e) => set(k, (typeof cfg[k] === 'number' ? Number(e.target.value) : e.target.value) as never)} />
      {errors[k] && <div className="err">{errors[k]}</div>}
    </>
  )
  const iface = (k: 'routingInterface' | 'tunnelInterface', label: string): React.JSX.Element => (
    <>
      <label>{label}</label>
      <select value={cfg[k]} onChange={(e) => set(k, e.target.value)}>
        <option value="">Auto</option>
        {ifaces.map((i) => <option key={i.ip} value={i.ip}>{i.name} ({i.ip})</option>)}
      </select>
      {errors[k] && <div className="err">{errors[k]}</div>}
    </>
  )
  const check = (k: 'autoStart' | 'startMinimized' | 'launchAtLogin', label: string): React.JSX.Element => (
    <label><input type="checkbox" checked={cfg[k]} onChange={(e) => set(k, e.target.checked)} />{label}</label>
  )
  const save = async (): Promise<void> => {
    const r = await knx.saveConfig(cfg)
    setErrors(r.errors); setSaved(r.ok)
  }

  return (
    <div className="wrap">
      <div className="card">
        <h2>Settings</h2>
        {text('deviceName', 'Device name')}
        {text('multicastAddress', 'Routing multicast address')}
        {text('multicastPort', 'Routing multicast port')}
        {iface('routingInterface', 'Routing network interface')}
        {iface('tunnelInterface', 'Tunnel server network interface')}
        {text('tunnelPort', 'Tunnel server port (0 = random)')}
        {text('tunnelAddress', 'Tunnel client individual address')}
        <hr />
        {check('autoStart', 'Start bridge on launch')}
        {check('startMinimized', 'Start minimized to tray')}
        {check('launchAtLogin', 'Launch at login')}
        <p><button onClick={save}>Save</button>{saved && <span>Saved{status?.running ? ' – bridge restarted' : ''}</span>}</p>
      </div>
      <div>
        <div className="card">
          <h2>Status</h2>
          <p>
            <button onClick={() => (status?.running ? knx.stop() : knx.start())}>{status?.running ? 'Stop' : 'Start'}</button>
          </p>
          <div><span className={`dot ${status?.routingUp ? 'on' : ''}`} />Routing</div>
          <div><span className={`dot ${status?.tunnelUp ? 'on' : ''}`} />Tunnel server{status?.tunnelPort ? ` (port ${status.tunnelPort})` : ''}</div>
          <div><span className={`dot ${status?.client ? 'on' : ''}`} />Client: {status?.client ?? 'none'}</div>
          <div>Routing rx/tx: {status?.rxRouting ?? 0} / {status?.txRouting ?? 0} · Tunnel rx/tx: {status?.rxTunnel ?? 0} / {status?.txTunnel ?? 0}</div>
          {status?.error && <div className="err">{status.error}</div>}
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Log</h2>
          <div className="log">{lines.map((l, i) => <div key={i}>{l}</div>)}</div>
          <p><button onClick={() => setPause(!pause)}>{pause ? 'Resume' : 'Pause'}</button><button onClick={() => setLines([])}>Clear</button></p>
        </div>
      </div>
    </div>
  )
}
