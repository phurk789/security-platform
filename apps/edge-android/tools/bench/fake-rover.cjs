// Fake ArduPilot Rover behind a "datalink" UDP server (like the UniRC 7 Pro at 192.168.144.20:19856).
// Usage: node fake-rover.cjs <node_modules dir> [port] [lat] [lon]
const dgram = require('node:dgram');
const { join } = require('node:path');
const mav = require(join(process.argv[2], 'node-mavlink'));
const { MavLinkProtocolV2, minimal, common } = mav;
const port = Number(process.argv[3] || 19856);
const lat = Number(process.argv[4] || 13.7563);
const lon = Number(process.argv[5] || 100.5018);
const sock = dgram.createSocket('udp4');
const proto = new MavLinkProtocolV2(1, 1);
let seq = 0;
let gcs = null;
let heard = 0;
const send = (m) => gcs && sock.send(proto.serialize(m, seq++ & 0xff), gcs.port, gcs.address);
sock.on('message', (_m, r) => {
  if (!gcs || gcs.port !== r.port) console.log(`[rover] ground station at ${r.address}:${r.port}`);
  gcs = { port: r.port, address: r.address };
  heard++;
});
setInterval(() => {
  const hb = new minimal.Heartbeat();
  hb.type = 10; // GROUND_ROVER
  hb.autopilot = 3; // ARDUPILOTMEGA
  hb.baseMode = 1;
  hb.customMode = 4; // HOLD
  hb.systemStatus = 4;
  hb.mavlinkVersion = 3;
  send(hb);
  const raw = new common.GpsRawInt();
  raw.fixType = 3;
  raw.satellitesVisible = 11;
  raw.eph = 90;
  send(raw);
  const gp = new common.GlobalPositionInt();
  gp.lat = Math.round(lat * 1e7);
  gp.lon = Math.round(lon * 1e7);
  gp.hdg = 9000;
  send(gp);
  const sys = new common.SysStatus();
  sys.batteryRemaining = 81;
  send(sys);
}, 250);
setInterval(() => console.log(`[rover] packets from the ground station: ${heard}`), 10000);
sock.bind(port, '0.0.0.0', () => console.log(`[rover] datalink on udp :${port}`));
