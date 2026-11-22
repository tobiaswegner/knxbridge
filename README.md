# KNX Bridge

Electron app bridging KNXnet/IP **routing** (multicast) to a single KNXnet/IP **tunneling** server, announced via KNXnet/IP discovery. Use it to give clients on lossy networks (WiFi) reliable, acknowledged tunneling instead of multicast routing.

- `npm run dev` – run in development; `npm test` – unit tests; `npm run dist` – package.
- Settings (multicast address/port, interfaces, tunnel port/address, startup options) are saved in the app's userData `config.json`.
- Closing the window minimizes to the tray; use the tray menu to quit.
- Open UDP 3671 in your firewall. Multicast needs a real network (use host networking in containers).
