// Command-line client: `wifiroom <command>` talks to a running WiFiRoom over its local HTTP API.
const PORT = Number(process.env.WIFIROOM_PORT) || 4321;
const BASE = `http://127.0.0.1:${PORT}/api`;

const ACTIONS = {
  poke: { args: ['device'] },
  play: { args: ['device', 'url'], body: ([url]) => ({ url }) },
  pause: { args: ['device'] },
  resume: { args: ['device'] },
  stop: { args: ['device'] },
  volume: { args: ['device', 'level'], body: ([level]) => ({ level }) },
  wake: { args: ['device'] },
  ring: { args: ['device'] },
};
const HOME = { on: 'turn_on', off: 'turn_off', toggle: 'toggle', brightness: 'set_brightness', color: 'set_color', temp: 'set_temperature' };
export const COMMANDS = ['devices', 'history', 'scan', 'screen', 'home', ...Object.keys(ACTIONS)];

async function request(path, body) {
  let res;
  try {
    res = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch {
    fail(`WiFiRoom isn't running on port ${PORT}. Start it with: npx wifiroom serve`);
  }
  const data = await res.json().catch(() => ({ ok: false, error: `Unexpected response (HTTP ${res.status})` }));
  if (!res.ok || data.ok === false) fail(data.error);
  return data;
}

function fail(message) {
  console.error(`wifiroom: ${message}`);
  process.exit(1);
}

const table = (rows, cols) => {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(cols.map((c) => c.toUpperCase())), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
};

export async function runCli(command, args, { json = false } = {}) {
  if (command === 'devices') {
    const list = await request('/devices');
    if (json) return console.log(JSON.stringify(list, null, 2));
    return console.log(table(list.map((d) => ({ ...d, caps: d.caps.join(',') || '-' })), ['name', 'id', 'status', 'ip', 'caps']));
  }
  if (command === 'history') {
    const events = await request('/timeline');
    if (json) return console.log(JSON.stringify(events, null, 2));
    return console.log(events.map((e) => `${new Date(e.t).toLocaleString()}  ${e.name} ${e.type}`).join('\n') || 'Nothing yet');
  }
  if (command === 'scan') {
    const r = await request('/scan', {});
    if (json) return console.log(JSON.stringify(r, null, 2));
    return console.log(`Pinged ${r.pinged} addresses; ${r.devices.length} devices here now`);
  }
  if (command === 'screen') {
    const [device, what] = args;
    if (!device || !['start', 'stop'].includes(what)) fail('usage: wifiroom screen <device> start|stop');
    const r = await request(`/devices/${encodeURIComponent(device)}/screen_${what}`, {});
    return console.log(json ? JSON.stringify(r, null, 2) : `${r.device.name}: ${r.message}`);
  }
  if (command === 'home') {
    const [device, verb, value] = args;
    if (!device) {
      const list = await request('/home');
      if (json) return console.log(JSON.stringify(list, null, 2));
      return console.log(list.length ? table(list, ['name', 'id', 'type', 'state']) : 'No smart-home devices found');
    }
    if (!HOME[verb] && verb !== 'snapshot') fail(`usage: wifiroom home <device> ${Object.keys(HOME).join('|')}|snapshot [value]`);
    const r = await request(`/home/${encodeURIComponent(device)}/${HOME[verb] ?? verb}`, value === undefined ? {} : { value: Number.isNaN(Number(value)) ? value : Number(value) });
    if (json || verb === 'snapshot') return console.log(JSON.stringify(r, null, 2));
    return console.log(r.message);
  }

  const spec = ACTIONS[command];
  if (args.length < spec.args.length) fail(`usage: wifiroom ${command} ${spec.args.map((a) => `<${a}>`).join(' ')}`);
  const [device, ...rest] = args;
  const r = await request(`/devices/${encodeURIComponent(device)}/${command}`, spec.body?.(rest) ?? {});
  // A device that doesn't answer a poke is a failure, so `wifiroom poke printer || ...` works.
  if (command === 'poke' && !r.alive) process.exitCode = 1;
  if (json) return console.log(JSON.stringify(r, null, 2));
  if (command === 'poke') {
    if (!r.alive) fail(`${r.device.name} did not reply`);
    return console.log(`${r.device.name} replied in ${r.ms} ms`);
  }
  console.log(`${r.device.name}: ${r.message}`);
}
