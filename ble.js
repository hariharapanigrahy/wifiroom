// Bluetooth radar worker. Runs as a child process because macOS aborts any process
// that touches Bluetooth without permission; the room server survives that.
import noble from '@stoprocent/noble';

const STALE_MS = 30_000;
const PATH_LOSS = 2.2;      // indoor path-loss exponent for the log-distance estimate
const DEFAULT_TX = -59;     // typical RSSI at 1 m when a device doesn't advertise tx power
const APPLE_TYPES = { 0x07: 'AirPods', 0x10: 'Apple device', 0x12: 'Find My item', 0x09: 'AirPlay', 0x0c: 'Apple device', 0x0f: 'Apple device' };

const seen = new Map();

function kindOf(adv) {
  const m = adv.manufacturerData;
  if (m?.length >= 3 && m.readUInt16LE(0) === 0x004c) return APPLE_TYPES[m[2]] ?? 'Apple';
  return adv.localName ? 'Named device' : 'Bluetooth device';
}

noble.on('stateChange', (state) => {
  process.send({ type: 'state', state });
  if (state === 'poweredOn') noble.startScanning([], true);
});

noble.on('discover', (p) => {
  const prev = seen.get(p.id);
  const rssi = prev ? prev.rssi * 0.7 + p.rssi * 0.3 : p.rssi; // smooth noisy readings
  // Advertised tx power is measured at the antenna; RSSI at 1 m is ~41 dB lower.
  const advTx = p.advertisement.txPowerLevel;
  const tx = advTx != null ? advTx - 41 : DEFAULT_TX;
  seen.set(p.id, {
    id: p.id,
    name: p.advertisement.localName || prev?.name || null,
    kind: kindOf(p.advertisement),
    rssi: Math.round(rssi),
    meters: Math.round(10 ** ((tx - rssi) / (10 * PATH_LOSS)) * 10) / 10,
    lastSeen: Date.now(),
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, d] of seen) if (now - d.lastSeen > STALE_MS) seen.delete(id);
  process.send({ type: 'devices', list: [...seen.values()] });
}, 1000);
