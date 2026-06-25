// ===== DEVICE MONITORING APP =====
// NetWatch — stores devices in localStorage, polls via fetch for reachability

const STORAGE_KEY = 'netwatch_devices';
const POLL_INTERVAL = 30000; // 30s auto-refresh

// ===== STATE =====
let devices = [];
let activeFilter = 'all';
let searchQuery = '';
let selectedDeviceId = null;
let pollTimer = null;
let selectedType = 'ups';
let selectedFirmware = 'auto';
const _trafficPrev = {}; // { deviceId: { rx, tx, ts } }

// ===== DEVICE ICONS & LABELS =====
const TYPE_META = {
  ups:    { icon: '⚡', label: 'UPS',     color: '#4f8ef7' },
  router: { icon: '📡', label: 'Router',  color: '#22c55e' },
  switch: { icon: '🔀', label: 'Switch',  color: '#a855f7' },
  server: { icon: '🖥️', label: 'Server',  color: '#f59e0b' },
  other:  { icon: '📦', label: 'Device',  color: '#8b92a8' },
};

const isVercel = location.hostname.includes('vercel.app');
const backendUrl = isVercel ? 'http://localhost:5500' : '';

// ===== STORAGE =====
async function loadDevices() {
  // 1. Try local storage first
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try { 
      devices = JSON.parse(stored);
      if (devices.length > 0) return;
    } catch {}
  }

  // 2. Try the local proxy API or fallback to static devices.json
  try {
    let res = await fetch(backendUrl + '/api/load');
    if (!res.ok) {
      res = await fetch('/devices.json');
    }
    if (res.ok) {
      devices = await res.json();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
      return;
    }
  } catch {}
  
  if (!devices) devices = [];
}

function saveDevices() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
  fetch(backendUrl + '/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(devices)
  }).catch(() => {});
}

// ===== POLLING / STATUS CHECK =====
// Browsers can't do ICMP ping; we use a timed fetch with no-cors mode.
// A response (even opaque) means the host is reachable; a network error means offline.
async function checkDeviceStatus(device) {
  const port = device.port || 80;
  const url = `http://${device.ip}:${port}/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(url, { mode: 'no-cors', signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeout);
    return 'online';
  } catch (e) {
    clearTimeout(timeout);
    return 'offline';
  }
}

// ===== AUDIO ALERTS =====
let audioCtx = null;
function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
window.addEventListener('click', initAudio, { once: true });

function playAlert(type) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  
  if (type === 'online') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.1);
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + 0.05);
    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.3);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.3);
  } else if (type === 'offline') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(150, audioCtx.currentTime + 0.2);
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + 0.05);
    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.4);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.4);
  }
}

async function refreshDevice(id) {
  const idx = devices.findIndex(d => d.id === id);
  if (idx === -1) return;
  
  const oldStatus = devices[idx].status;
  
  devices[idx].status = 'checking';
  devices[idx].lastChecked = Date.now();
  renderGrid();

  const status = await checkDeviceStatus(devices[idx]);
  
  if ((oldStatus === 'online' || oldStatus === 'offline') && oldStatus !== status) {
    if (status === 'online') playAlert('online');
    if (status === 'offline') playAlert('offline');
  }

  devices[idx].status = status;
  devices[idx].lastChecked = Date.now();
  if (status === 'online') {
    devices[idx].upSince = devices[idx].upSince || Date.now();
    await fetchDeviceData(devices[idx]);
  } else {
    devices[idx].upSince = null;
  }
  saveDevices();
  renderGrid();
  updateHeaderStats();
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = options.timeout || 5000;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function refreshAll() {
  const btn = document.getElementById('btn-refresh-all');
  btn.classList.add('spinning');
  await Promise.all(devices.map(d => refreshDevice(d.id)));
  btn.classList.remove('spinning');
  showToast('All devices refreshed', 'info');
}

// ===== DEVICE DATA FETCHING =====
// Tries to read UPS/router data from device HTTP endpoint.
// Falls back to simulated data if CORS blocks or device is custom.
async function fetchDeviceData(device) {
  if (device.type === 'ups') {
    await fetchUPSData(device);
  } else if (device.type === 'router') {
    await fetchRouterData(device);
  }
}

// ===== TRAFFIC RATE CALCULATOR =====
function fmtSpeed(bps) {
  if (bps <= 0) return '0 B/s';
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  if (bps < 1024 * 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
  return `${(bps / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
}

function calcTrafficRate(id, rx, tx) {
  const now = Date.now();
  const prev = _trafficPrev[id];
  let rxRate = 0, txRate = 0;
  if (prev && now - prev.ts > 0 && rx >= prev.rx && tx >= prev.tx) {
    const dt = (now - prev.ts) / 1000;
    rxRate = (rx - prev.rx) / dt;
    txRate = (tx - prev.tx) / dt;
  }
  _trafficPrev[id] = { rx, tx, ts: now };
  return { rxRate, txRate };
}

// ===== ROUTER DATA FETCHING =====
function fmtUptime(seconds) {
  if (!seconds || isNaN(seconds)) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function fetchRouterData(device) {
  device.routerData = null;
  const port      = device.port || 80;
  const baseUrl   = `http://${device.ip}:${port}`;
  const isVercel = location.hostname.includes('vercel.app');
  const proxyBase = isVercel ? 'http://localhost:5500/proxy?url=' : `${location.origin}/proxy?url=`;
  const authB64   = device.username
    ? btoa(`${device.username}:${device.password || ''}`)
    : null;

  // proxyFetch supports both GET and POST via the local proxy
  const proxyFetch = async (path, options = {}) => {
    const encoded  = encodeURIComponent(baseUrl + path);
    const authParam = authB64 ? `&auth=${authB64}` : '';
    return fetchWithTimeout(`${proxyBase}${encoded}${authParam}`, {
      cache: 'no-store',
      ...options,
    });
  };

  const rpc = async (path, method, params = []) =>
    proxyFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, method, params }),
    });

  const fw = device.firmware || 'auto';

  // ── MikroTik REST API ─────────────────────────────────────────────────────
  if (fw === 'auto' || fw === 'mikrotik') {
    try {
      const res = await proxyFetch('/rest/interface');
      if (res.ok) {
        const ifaces = await res.json();
        // Pick WAN: prefer pppoe/ether not named bridge/lo
        const wan = ifaces.find(i => i.type === 'pppoe')
                 || ifaces.find(i => i.type === 'ether' && !/(bridge|lo|br|vlan|bond)/i.test(i.name))
                 || ifaces[0];
        if (wan) {
          const rx = parseInt(wan['rx-byte'] || 0);
          const tx = parseInt(wan['tx-byte'] || 0);
          const rates = calcTrafficRate(device.id, rx, tx);

          // WAN IP
          let wanIp = '--';
          try {
            const ipRes = await proxyFetch('/rest/ip/address');
            if (ipRes.ok) {
              const addrs = await ipRes.json();
              const e = addrs.find(a => a.interface === wan.name && !a.disabled);
              if (e) wanIp = e.address.split('/')[0];
            }
          } catch {}

          // System resource (uptime + cpu)
          let uptime = '--';
          try {
            const sysRes = await proxyFetch('/rest/system/resource');
            if (sysRes.ok) {
              const sys = await sysRes.json();
              if (sys.uptime) uptime = sys.uptime; // already formatted e.g. "2d3h4m5s"
            }
          } catch {}

          // DHCP leases = connected clients
          let clients = '--';
          try {
            const leaseRes = await proxyFetch('/rest/ip/dhcp-server/lease');
            if (leaseRes.ok) {
              const leases = await leaseRes.json();
              clients = leases.filter(l => l.status === 'bound').length;
            }
          } catch {}

          device.routerData = {
            fw: 'MikroTik', wanIp, wanIface: wan.name,
            uptime, clients,
            rxRate: rates.rxRate, txRate: rates.txRate,
            rxBytes: rx, txBytes: tx,
          };
          return;
        }
      }
    } catch {}
  }

  // ── OpenWrt ubus RPC ──────────────────────────────────────────────────────
  if (fw === 'auto' || fw === 'openwrt') {
    try {
      const ubus = async (session, obj, method, args = {}) => {
        const res = await proxyFetch('/ubus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'call',
            params: [session, obj, method, args]
          })
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.result && data.result[1] ? data.result[1] : (data.result ? data.result[0] : null);
      };

      // 1. Login
      const loginRes = await ubus('00000000000000000000000000000000', 'session', 'login', {
        username: device.username || 'root',
        password: device.password || ''
      });
      const token = loginRes && loginRes.ubus_rpc_session ? loginRes.ubus_rpc_session : null;

      if (token) {
        let wanIp = '--', wanIface = '--', rx = 0, tx = 0;
        let uptime = '--', clients = '--';

        // 2. Interfaces (IP + Stats)
        const dump = await ubus(token, 'network.interface', 'dump');
        if (dump && dump.interface) {
          const wan = dump.interface.find(i => i.interface === 'wan' || i.route?.find(r => r.target === '0.0.0.0')) || dump.interface[0];
          if (wan) {
            wanIface = wan.l3_device || wan.device || wan.interface;
            if (wan.ipv4_address && wan.ipv4_address[0]) wanIp = wan.ipv4_address[0].address;
            
            // Get stats for the device
            const devStat = await ubus(token, 'network.device', 'status', { name: wanIface });
            if (devStat && devStat.statistics) {
              rx = devStat.statistics.rx_bytes || 0;
              tx = devStat.statistics.tx_bytes || 0;
            }
          }
        }
        const rates = calcTrafficRate(device.id, rx, tx);

        // 3. System info (Uptime)
        const sysInfo = await ubus(token, 'system', 'info');
        if (sysInfo && sysInfo.uptime) {
          uptime = fmtUptime(sysInfo.uptime);
        }

        // 4. Clients (DHCP Leases or ARP)
        try {
          const dhcp = await ubus(token, 'luci-rpc', 'getDHCPLeases');
          if (dhcp && dhcp.dhcp_leases) clients = dhcp.dhcp_leases.length;
        } catch {}

        device.routerData = {
          fw: 'OpenWrt', wanIp, wanIface,
          uptime, clients,
          rxRate: rates.rxRate, txRate: rates.txRate,
          rxBytes: rx, txBytes: tx,
        };
        return;
      }
    } catch {}

    // Fallback checking
    try {
      const res = await proxyFetch('/');
      if (res.ok) {
        const html = await res.text();
        if (html.includes('OpenWrt') || html.includes('LuCI') || html.includes('luci')) {
          device.routerData = {
            fw: 'OpenWrt', wanIp: '--', wanIface: '--',
            uptime: '--', clients: '--',
            rxRate: null, txRate: null, rxBytes: 0, txBytes: 0,
          };
          return;
        }
      }
    } catch {}
  }

  // ── ASUS Router ───────────────────────────────────────────────────────────
  if (fw === 'auto' || fw === 'asus') {
    try {
      const res = await proxyFetch('/appGet.cgi?hook=netdev(appobj)');
      if (res.ok) {
        const text = await res.text();
        const m = text.match(/tx_bytes.*?([\\d]+).*?rx_bytes.*?([\\d]+)/s)
                || text.match(/([\\d]+).*?([\\d]+)/s);
        if (m) {
          const tx = parseInt(m[1]); const rx = parseInt(m[2]);
          const rates = calcTrafficRate(device.id, rx, tx);

          let wanIp = '--';
          try {
            const ipRes = await proxyFetch('/appGet.cgi?hook=wanlink()');
            if (ipRes.ok) { const t = await ipRes.text(); const mi = t.match(/ip.*?([\d.]+)/); if (mi) wanIp = mi[1]; }
          } catch {}

          let uptime = '--', clients = '--';
          try {
            const upRes = await proxyFetch('/appGet.cgi?hook=sysinfo()');
            if (upRes.ok) {
              const t = await upRes.text();
              const um = t.match(/uptimeStr.*?"([^"]+)"/); if (um) uptime = um[1];
              const cm = t.match(/"sta_count":(\d+)/); if (cm) clients = parseInt(cm[1]);
            }
          } catch {}

          device.routerData = { fw: 'ASUS', wanIp, uptime, clients, rxRate: rates.rxRate, txRate: rates.txRate, rxBytes: rx, txBytes: tx };
          return;
        }
      }
    } catch {}
  }

  // ── DD-WRT ────────────────────────────────────────────────────────────────
  if (fw === 'auto' || fw === 'ddwrt') {
    try {
      const res = await proxyFetch('/Status_Internet.live.asp');
      if (res.ok) {
        const text = await res.text();
        const wanIpM = text.match(/wan_ipaddr::([\d.]+)/);
        const rxM    = text.match(/wan_receive_bytes::(\d+)/);
        const txM    = text.match(/wan_send_bytes::(\d+)/);
        const upM    = text.match(/uptime::([^\n]+)/);
        if (wanIpM || rxM) {
          const rx = parseInt(rxM ? rxM[1] : 0);
          const tx = parseInt(txM ? txM[1] : 0);
          const rates = calcTrafficRate(device.id, rx, tx);
          let clients = '--';
          try {
            const cRes = await proxyFetch('/Status_Wireless.live.asp');
            if (cRes.ok) { const ct = await cRes.text(); const cm = ct.match(/active_wireless::(\d+)/); if (cm) clients = parseInt(cm[1]); }
          } catch {}
          device.routerData = {
            fw: 'DD-WRT', wanIp: wanIpM ? wanIpM[1] : '--',
            uptime: upM ? upM[1].trim() : '--', clients,
            rxRate: rates.rxRate, txRate: rates.txRate, rxBytes: rx, txBytes: tx,
          };
          return;
        }
      }
    } catch {}
  }

  // ── Generic — ping successful, no stats API found ─────────────────────────
  device.routerData = { fw: 'Generic', wanIp: '--', rxRate: null, txRate: null, rxBytes: 0, txBytes: 0 };
async function fetchUPSData(device) {
  // ALWAYS reset before each refresh — never show stale data
  device.liveData = null;
  device.dataSource = 'unavailable';

  const port      = device.port || 80;
  const baseUrl   = `http://${device.ip}:${port}`;
  const isVercel  = location.hostname.includes('vercel.app');
  const proxyBase = isVercel ? 'http://localhost:5500/proxy?url=' : `${location.origin}/proxy?url=`;

  // ── 1. realInfo.cgi — space-separated live data (SNMP Web Pro / generic UPS) ──
  for (const fetchUrl of [
    baseUrl + '/cgi-bin/realInfo.cgi',
    proxyBase + encodeURIComponent(baseUrl + '/cgi-bin/realInfo.cgi'),
  ]) {
    try {
      const res = await fetchWithTimeout(fetchUrl, { cache: 'no-store', timeout: 8000 });
      if (res.ok) {
        const text = await res.text();
        const parsed = parseRealInfoCgi(text.trim());
        if (parsed) {
          device.liveData   = parsed;
          device.dataSource = 'live-cgi';
          return;
        }
      }
    } catch { /* try next */ }
  }

  // ── 1.5 USHA PageCompre.html ──────────────────────────────────────────────
  for (const fetchUrl of [
    baseUrl + '/PageCompre.html',
    proxyBase + encodeURIComponent(baseUrl + '/PageCompre.html'),
  ]) {
    try {
      const res = await fetchWithTimeout(fetchUrl, { cache: 'no-store', timeout: 8000 });
      if (res.ok) {
        const html = await res.text();
        const parsed = parseUshaHtml(html);
        if (parsed) {
          device.liveData = parsed;
          device.dataSource = 'usha-html';
          return;
        }
      }
    } catch { /* try next */ }
  }

  // ── 2. HTML status page (table-based web UI) ──────────────────────────────
  for (const fetchUrl of [
    baseUrl + '/',
    proxyBase + encodeURIComponent(baseUrl + '/'),
  ]) {
    try {
      const res = await fetchWithTimeout(fetchUrl, { cache: 'no-store', timeout: 8000 });
      if (res.ok) {
        const html   = await res.text();
        const parsed = parseUPSHtml(html);
        if (parsed) {
          device.liveData   = parsed;
          device.dataSource = 'live-html';
          return;
        }
      }
    } catch { /* try next */ }
  }

  // ── 3. JSON API endpoints ──────────────────────────────────────────────────
  for (const jsonPath of ['/status.json', '/ups_status.json', '/api/ups', '/ups.json',
                          '/cgi-bin/ups.cgi', '/rest/mbdetnrs/1.0/managers/1/status']) {
    for (const fetchUrl of [
      baseUrl + jsonPath,
      proxyBase + encodeURIComponent(baseUrl + jsonPath),
    ]) {
      try {
        const res = await fetchWithTimeout(fetchUrl, { cache: 'no-store', timeout: 8000 });
        if (res.ok) {
          const data = await res.json();
          device.liveData   = parseUPSJsonResponse(data);
          device.dataSource = 'live-json';
          return;
        }
      } catch { /* try next */ }
    }
  }
  // All methods failed — liveData stays null, card shows dashes
}

// Parse /cgi-bin/realInfo.cgi response (SNMP Web Pro format)
// Example response: "Line Mode 400 1 0 2 1 0 2608 100 35 500 2257 0 500 2296 0 37 0 0"
// After stripping the mode text, numeric fields are (0-indexed):
//   [0]  rated VA (400)
//   [1-5] status flags
//   [6]  battery voltage  × 0.1  → e.g. 2608 = 260.8 V
//   [7]  battery capacity %       → e.g. 100
//   [8]  remaining backup time (min) → e.g. 35
//   [9]  input frequency  × 0.1  → e.g. 500 = 50.0 Hz
//   [10] input voltage    × 0.1  → e.g. 2257 = 225.7 V
//   [11] (unused / flag)
//   [12] output frequency × 0.1  → e.g. 500 = 50.0 Hz
//   [13] output voltage   × 0.1  → e.g. 2296 = 229.6 V
//   [14] (unused / flag)
//   [15] load level %            → e.g. 37
function parseRealInfoCgi(raw) {
  if (!raw || raw.length < 4) return null;
  const parts = raw.split(/\s+/);

  // Find where the numeric block starts
  let numStart = 0;
  for (let i = 0; i < parts.length; i++) {
    if (!isNaN(parseFloat(parts[i])) && isFinite(parts[i])) { numStart = i; break; }
  }

  const mode = parts.slice(0, numStart).join(' ') || 'Unknown';
  const nums = parts.slice(numStart).map(v => parseFloat(v));

  const v    = (idx) => (nums[idx] !== undefined ? nums[idx] : null);
  const dec1 = (idx) => { const n = v(idx); return n !== null ? (n / 10).toFixed(1) : '--'; };
  const pct  = (idx) => { const n = v(idx); return n !== null ? Math.min(100, Math.round(n)) : '--'; };

  return {
    mode,
    batteryVoltage:  dec1(6),   // 2608 → 260.8 V
    batteryCapacity: pct(7),    // 100 %
    backupTime:      v(8) !== null ? Math.round(v(8)) : '--',  // 35 min
    inputFreq:       dec1(9),   // 500 → 50.0 Hz
    inputVoltage:    dec1(10),  // 2257 → 225.7 V
    outputFreq:      dec1(12),  // 500 → 50.0 Hz
    outputVoltage:   dec1(13),  // 2296 → 229.6 V
    loadLevel:       pct(15),   // 37 %
    outputCurrent:   '--',
    temperature:     '--',
  };
}

function parseUshaHtml(html) {
  try {
    if (!html.includes('USHA')) return null;

    const extractNum = (label) => {
      const regex = new RegExp(label + '[\\s\\S]*?<TABLE[^>]*>[\\s\\S]*?<TD>\\s*([\\d.]+)\\s*<\\/TD>', 'i');
      const match = html.match(regex);
      return match && !isNaN(parseFloat(match[1])) ? parseFloat(match[1]) : '--';
    };

    let mode = '--';
    const modeMatch = html.match(/UPS Status[\s\S]*?<FONT[^>]*>\s*([^<]+)\s*<\/FONT>/i);
    if (modeMatch) mode = modeMatch[1].trim();

    let inputVoltage = extractNum('Current Utility Line Voltage');
    let outputVoltage = extractNum('Output\\s+Voltage');
    let batteryCapacity = extractNum('Battery Capacity Remaining');
    let batteryVoltage = extractNum('Current Battery Voltage');
    let inputFreq = extractNum('Input Frequency');
    
    let loadMatch = html.match(/var\s+upsL\s*=\s*"([\d.]+)"/i);
    let loadLevel = loadMatch && !isNaN(parseFloat(loadMatch[1])) ? parseFloat(loadMatch[1]) : '--';

    let tempMatch = html.match(/var\s+upsT\s*=\s*"([\d.]+)"/i);
    let temperature = tempMatch && !isNaN(parseFloat(tempMatch[1])) ? parseFloat(tempMatch[1]) : '--';

    if (inputVoltage === '--' && outputVoltage === '--') return null;

    return {
      mode, inputVoltage, inputFreq, outputVoltage,
      outputFreq: '--', outputCurrent: '--', loadLevel,
      batteryVoltage, batteryCapacity, backupTime: '--', temperature,
    };
  } catch { return null; }
}


// Parse UPS HTML status page (table-based web UI like Eaton, generic Chinese UPS, etc.)
function parseUPSHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cells = Array.from(doc.querySelectorAll('td'));

    // Build a label→value map by finding cells ending with ':'
    const map = {};
    cells.forEach((cell, i) => {
      const text = cell.textContent.trim();
      if (text.endsWith(':') && cells[i + 1]) {
        const key = text.slice(0, -1).toLowerCase().replace(/\s+/g, '_');
        map[key] = cells[i + 1].textContent.trim();
      }
    });

    if (Object.keys(map).length === 0) return null;

    // Helper: extract numeric part from a value like "227.4 V" → 227.4
    const num = (val) => {
      if (!val || val === '--') return '--';
      const n = parseFloat(val);
      return isNaN(n) ? val : n;
    };

    // Helper: find value by trying multiple label keys
    const get = (...keys) => {
      for (const k of keys) { if (map[k] !== undefined) return map[k]; }
      return '--';
    };

    return {
      mode:            get('ups_mode', 'mode', 'upsmode'),
      inputVoltage:    num(get('input_voltage', 'inputvoltage')),
      inputFreq:       num(get('input_frequency', 'inputfrequency')),
      outputVoltage:   num(get('output_voltage', 'outputvoltage')),
      outputFreq:      num(get('output_frequency', 'outputfrequency')),
      outputCurrent:   num(get('output_current', 'outputcurrent')),
      loadLevel:       num(get('load_level', 'loadlevel', 'load')),
      batteryVoltage:  num(get('battery_voltage', 'batteryvoltage')),
      batteryCapacity: num(get('battery_capacity', 'batterycapacity')),
      backupTime:      num(get('remaining_backup_time', 'backup_time', 'backuptime')),
      temperature:     num(get('ups_temp', 'temperature', 'temp')),
    };
  } catch { return null; }
}

function parseUPSJsonResponse(raw) {
  const get = (...keys) => { for (const k of keys) { if (raw[k] !== undefined) return raw[k]; } return '--'; };
  return {
    mode:            get('mode', 'upsMode', 'ups_mode'),
    inputVoltage:    get('inputVoltage', 'input_voltage', 'vin'),
    inputFreq:       get('inputFrequency', 'input_freq', 'fin'),
    outputVoltage:   get('outputVoltage', 'output_voltage', 'vout'),
    outputFreq:      get('outputFrequency', 'output_freq', 'fout'),
    outputCurrent:   get('outputCurrent', 'output_current', 'iout'),
    loadLevel:       get('loadLevel', 'load', 'load_level'),
    batteryVoltage:  get('batteryVoltage', 'battery_voltage', 'vbat'),
    batteryCapacity: get('batteryCapacity', 'battery', 'bat_capacity'),
    backupTime:      get('backupTime', 'backup_time', 'autonomy'),
    temperature:     get('temperature', 'temp', 'ups_temp'),
  };
}

// ===== RENDER HELPERS =====
function timeSince(ts) {
  if (!ts) return 'Never';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function getStatusBadge(status) {
  const map = {
    online: '<span class="status-badge online"><span class="badge-dot"></span>Online</span>',
    offline: '<span class="status-badge offline"><span class="badge-dot"></span>Offline</span>',
    checking: '<span class="status-badge checking"><span class="badge-dot"></span>Checking…</span>',
    unknown: '<span class="status-badge unknown"><span class="badge-dot"></span>Unknown</span>',
  };
  return map[status] || map.unknown;
}

function getBarColor(pct) {
  if (pct >= 80) return 'green';
  if (pct >= 40) return 'blue';
  if (pct >= 20) return 'yellow';
  return 'red';
}

function getModeStyle(mode) {
  const m = String(mode).toLowerCase();
  if (m.includes('battery')) return { cls: 'mode-battery', label: '🔋 On Battery' };
  if (m.includes('eco'))     return { cls: 'mode-eco',     label: '🌿 ECO Mode' };
  if (m.includes('bypass'))  return { cls: 'mode-bypass',  label: '⚠️ Bypass' };
  return { cls: 'mode-line', label: '⚡ Line Mode' };
}

function buildCardStats(device) {
  if (device.type === 'ups') {
    // Online but no live data fetched yet
    if (!device.liveData) {
      return `
        <div class="card-no-data">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Live data unavailable — click to open device web UI
        </div>
        <div class="card-stats cols-5">
          <div class="card-stat"><div class="stat-val stat-dash">—</div><div class="stat-label">Input</div></div>
          <div class="card-stat"><div class="stat-val stat-dash">—</div><div class="stat-label">Output</div></div>
          <div class="card-stat"><div class="stat-val stat-dash">—</div><div class="stat-label">Load</div></div>
          <div class="card-stat"><div class="stat-val stat-dash">—</div><div class="stat-label">Backup</div></div>
          <div class="card-stat"><div class="stat-val stat-dash">—</div><div class="stat-label">Temp</div></div>
        </div>`;
    }
    const d = device.liveData;
    const cap = parseInt(d.batteryCapacity) || 0;
    const load = parseInt(d.loadLevel) || 0;
    const modeStyle = getModeStyle(d.mode);
    return `
      <div class="card-mode-badge ${modeStyle.cls}">${modeStyle.label}</div>
      <div class="card-stats cols-5">
        <div class="card-stat">
          <div class="stat-val">${d.inputVoltage}<span class="stat-unit">V</span></div>
          <div class="stat-label">Input</div>
        </div>
        <div class="card-stat">
          <div class="stat-val">${d.outputVoltage}<span class="stat-unit">V</span></div>
          <div class="stat-label">Output</div>
        </div>
        <div class="card-stat">
          <div class="stat-val">${load}<span class="stat-unit">%</span></div>
          <div class="stat-label">Load</div>
        </div>
        <div class="card-stat">
          <div class="stat-val">${d.backupTime}<span class="stat-unit">m</span></div>
          <div class="stat-label">Backup</div>
        </div>
        <div class="card-stat">
          <div class="stat-val">${d.temperature}<span class="stat-unit">°C</span></div>
          <div class="stat-label">Temp</div>
        </div>
      </div>
      <div class="card-bar-row">
        <div class="bar-item">
          <div class="bar-label"><span>Battery</span><span>${cap}%</span></div>
          <div class="bar-track"><div class="bar-fill ${getBarColor(cap)}" style="width:${cap}%"></div></div>
        </div>
        <div class="bar-item">
          <div class="bar-label"><span>Load</span><span>${load}%</span></div>
          <div class="bar-track"><div class="bar-fill ${getBarColor(100 - load)}" style="width:${load}%"></div></div>
        </div>
      </div>`;
  }
  // ── Router card ──────────────────────────────────────────────────────────
  if (device.type === 'router') {
    const rd = device.routerData;
    if (!rd || rd.rxRate === null) {
      return `
        <div class="card-no-data">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          ${device.username ? 'Fetching WAN stats…' : 'Add credentials for live WAN traffic'}
        </div>
        <div class="card-stats cols-3">
          <div class="card-stat"><div class="stat-val stat-dash">—</div><div class="stat-label">Uptime</div></div>
          <div class="card-stat"><div class="stat-val stat-dash">—</div><div class="stat-label">Clients</div></div>
          <div class="card-stat"><div class="stat-val stat-dash">${rd ? escHtml(rd.fw) : '—'}</div><div class="stat-label">Firmware</div></div>
        </div>`;
    }
    const maxRate = Math.max(rd.rxRate, rd.txRate, 1024 * 1024); // 1 MB/s baseline
    const rxPct = Math.min(100, (rd.rxRate / maxRate) * 100);
    const txPct = Math.min(100, (rd.txRate / maxRate) * 100);
    return `
      ${rd.wanIp !== '--' ? `<div class="wan-ip-row"><span class="wan-ip-label">WAN IP</span><span class="wan-ip-val">${escHtml(rd.wanIp)}</span></div>` : ''}
      <div class="wan-traffic-row">
        <div class="traffic-item">
          <span class="traffic-dir down">↓</span>
          <div class="traffic-track"><div class="traffic-fill down" style="width:${rxPct.toFixed(1)}%"></div></div>
          <span class="traffic-speed">${fmtSpeed(rd.rxRate)}</span>
        </div>
        <div class="traffic-item">
          <span class="traffic-dir up">↑</span>
          <div class="traffic-track"><div class="traffic-fill up" style="width:${txPct.toFixed(1)}%"></div></div>
          <span class="traffic-speed">${fmtSpeed(rd.txRate)}</span>
        </div>
      </div>
      <div class="card-stats cols-3">
        <div class="card-stat"><div class="stat-val">${rd.fw || '—'}</div><div class="stat-label">Firmware</div></div>
        <div class="card-stat"><div class="stat-val">${rd.uptime || '—'}</div><div class="stat-label">Uptime</div></div>
        <div class="card-stat"><div class="stat-val">${rd.clients || '—'}</div><div class="stat-label">Clients</div></div>
      </div>`;
  }
  // Generic device card
  return `
    <div class="card-stats cols-3">
      <div class="card-stat">
        <div class="stat-val">${device.ip}</div>
        <div class="stat-label">IP Address</div>
      </div>
      <div class="card-stat">
        <div class="stat-val">${device.port || 80}</div>
        <div class="stat-label">Port</div>
      </div>
      <div class="card-stat">
        <div class="stat-val">${device.status === 'online' ? '✓' : '✗'}</div>
        <div class="stat-label">Reachable</div>
      </div>
    </div>`;
}

function buildCard(device) {
  const meta = TYPE_META[device.type] || TYPE_META.other;
  const status = device.status || 'unknown';
  const div = document.createElement('div');
  div.className = `device-card status-${status} card-animate`;
  div.dataset.id = device.id;
  div.dataset.type = device.type;
  div.dataset.name = device.name.toLowerCase();
  div.dataset.ip = device.ip;
  div.innerHTML = `
    <div class="card-header">
      <div class="card-device-info">
        <div class="card-icon type-${device.type}">${meta.icon}</div>
        <div class="card-meta">
          <div class="card-name">${escHtml(device.name)}</div>
          <div class="card-ip">${escHtml(device.ip)}${device.port && device.port !== 80 ? ':' + device.port : ''}</div>
        </div>
      </div>
      ${getStatusBadge(status)}
    </div>
    ${buildCardStats(device)}
    <div class="card-footer">
      <span class="card-type-tag">${meta.label}</span>
      <span class="card-time">Checked ${timeSince(device.lastChecked)}</span>
    </div>`;
  div.addEventListener('click', () => openDetailModal(device.id));
  return div;
}

// ===== RENDER GRID =====
function renderGrid() {
  const grid = document.getElementById('device-grid');
  const emptyState = document.getElementById('empty-state');

  let filtered = devices.filter(d => {
    const matchFilter = activeFilter === 'all' || d.type === activeFilter;
    const matchSearch = !searchQuery ||
      d.name.toLowerCase().includes(searchQuery) ||
      d.ip.includes(searchQuery);
    return matchFilter && matchSearch;
  });

  // Remove old cards (keep empty state)
  grid.querySelectorAll('.device-card').forEach(el => el.remove());

  if (filtered.length === 0) {
    emptyState.style.display = '';
    return;
  }
  emptyState.style.display = 'none';

  filtered.forEach((device, i) => {
    const card = buildCard(device);
    card.style.animationDelay = `${i * 40}ms`;
    grid.appendChild(card);
  });
}

function updateHeaderStats() {
  const online = devices.filter(d => d.status === 'online').length;
  const offline = devices.filter(d => d.status === 'offline').length;
  document.getElementById('count-online').textContent = online;
  document.getElementById('count-offline').textContent = offline;
  document.getElementById('count-total').textContent = devices.length;
}

// ===== ADD DEVICE MODAL =====
function openAddModal() {
  document.getElementById('input-name').value = '';
  document.getElementById('input-ip').value = '';
  document.getElementById('input-port').value = '';
  document.getElementById('input-desc').value = '';
  document.getElementById('input-username').value = '';
  document.getElementById('input-password').value = '';
  document.getElementById('modal-error').textContent = '';
  selectedType = 'ups';
  selectedFirmware = 'auto';
  document.querySelectorAll('#type-selector .type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'ups'));
  document.querySelectorAll('#router-fw-selector .type-btn').forEach(b => b.classList.toggle('active', b.dataset.fw === 'auto'));
  document.getElementById('cred-section').classList.remove('visible');
  document.getElementById('modal-add').classList.add('open');
  setTimeout(() => document.getElementById('input-name').focus(), 100);
}

function closeAddModal() {
  document.getElementById('modal-add').classList.remove('open');
}

function validateIP(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
    ip.split('.').every(n => parseInt(n) >= 0 && parseInt(n) <= 255);
}

function saveDevice() {
  const name     = document.getElementById('input-name').value.trim();
  const ip       = document.getElementById('input-ip').value.trim();
  const port     = parseInt(document.getElementById('input-port').value) || 80;
  const desc     = document.getElementById('input-desc').value.trim();
  const username = document.getElementById('input-username').value.trim();
  const password = document.getElementById('input-password').value;
  const errEl    = document.getElementById('modal-error');

  if (!name) { errEl.textContent = 'Device name is required.'; return; }
  if (!ip || !validateIP(ip)) { errEl.textContent = 'Enter a valid IP address (e.g. 192.168.1.1).'; return; }
  if (devices.find(d => d.ip === ip && d.port === port)) { errEl.textContent = 'A device with this IP:port already exists.'; return; }
  errEl.textContent = '';

  const device = {
    id: `dev_${Date.now()}`,
    name, ip, port, desc,
    type: selectedType,
    firmware: selectedType === 'router' ? selectedFirmware : undefined,
    username: username || undefined,
    password: password || undefined,
    status: 'unknown',
    lastChecked: null,
    upSince: null,
    liveData: null,
    routerData: null,
    addedAt: Date.now(),
  };
  devices.unshift(device);
  saveDevices();
  
  if (document.getElementById('input-auto-export').checked) {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(devices, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "netwatch-devices-backup.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  }

  closeAddModal();
  renderGrid();
  updateHeaderStats();
  showToast(`"${name}" added. Checking status…`, 'success');
  setTimeout(() => refreshDevice(device.id), 300);
}

// ===== DETAIL MODAL =====
function openDetailModal(id) {
  selectedDeviceId = id;
  const device = devices.find(d => d.id === id);
  if (!device) return;
  const meta = TYPE_META[device.type] || TYPE_META.other;

  document.getElementById('detail-icon').textContent = meta.icon;
  document.getElementById('detail-title').textContent = device.name;
  document.getElementById('detail-ip').textContent = `${device.ip}:${device.port || 80}`;

  document.getElementById('modal-detail').classList.add('open');
  renderDetailBody(device);
}

function renderDetailBody(device) {
  const body = document.getElementById('detail-body');
  const status = device.status || 'unknown';
  const meta = TYPE_META[device.type] || TYPE_META.other;

  let html = `
    <div class="detail-section">
      <div class="detail-section-title">Connection</div>
      <div class="detail-grid">
        <div class="detail-item">
          <div class="detail-item-label">Status</div>
          <div class="detail-item-val ${status === 'online' ? 'green' : status === 'offline' ? 'red' : ''}">${status.charAt(0).toUpperCase() + status.slice(1)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-item-label">Type</div>
          <div class="detail-item-val">${meta.label}</div>
        </div>
        <div class="detail-item">
          <div class="detail-item-label">IP Address</div>
          <div class="detail-item-val mono">${escHtml(device.ip)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-item-label">Port</div>
          <div class="detail-item-val mono">${device.port || 80}</div>
        </div>
        <div class="detail-item">
          <div class="detail-item-label">Last Checked</div>
          <div class="detail-item-val">${timeSince(device.lastChecked)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-item-label">Added</div>
          <div class="detail-item-val">${new Date(device.addedAt).toLocaleDateString()}</div>
        </div>
      </div>
    </div>`;

  if (device.desc) {
    html += `<div class="detail-section">
      <div class="detail-section-title">Description</div>
      <div class="detail-item"><div class="detail-item-val">${escHtml(device.desc)}</div></div>
    </div>`;
  }

  // Router section
  if (device.type === 'router') {
    const rd = device.routerData;
    html += `<div class="detail-section">
      <div class="detail-section-title">WAN Traffic</div>
      <div class="detail-grid">
        <div class="detail-item"><div class="detail-item-label">WAN IP</div><div class="detail-item-val mono">${rd ? escHtml(rd.wanIp) : '--'}</div></div>
        <div class="detail-item"><div class="detail-item-label">Firmware</div><div class="detail-item-val">${rd ? escHtml(rd.fw) : '--'}</div></div>
        <div class="detail-item"><div class="detail-item-label">Uptime</div><div class="detail-item-val">${rd ? escHtml(rd.uptime) : '--'}</div></div>
        <div class="detail-item"><div class="detail-item-label">Clients</div><div class="detail-item-val">${rd ? escHtml(rd.clients) : '--'}</div></div>
        <div class="detail-item"><div class="detail-item-label">↓ Download</div><div class="detail-item-val green">${rd && rd.rxRate !== null ? fmtSpeed(rd.rxRate) : '--'}</div></div>
        <div class="detail-item"><div class="detail-item-label">↑ Upload</div><div class="detail-item-val" style="color:var(--accent-2)">${rd && rd.txRate !== null ? fmtSpeed(rd.txRate) : '--'}</div></div>
        <div class="detail-item"><div class="detail-item-label">Total RX</div><div class="detail-item-val">${rd && rd.rxBytes ? fmtBytes(rd.rxBytes) : '--'}</div></div>
        <div class="detail-item"><div class="detail-item-label">Total TX</div><div class="detail-item-val">${rd && rd.txBytes ? fmtBytes(rd.txBytes) : '--'}</div></div>
      </div>
    </div>`;
    if (device.username) {
      html += `<div class="detail-section">
        <div class="detail-section-title">Credentials</div>
        <div class="detail-grid">
          <div class="detail-item"><div class="detail-item-label">Username</div><div class="detail-item-val mono">${escHtml(device.username)}</div></div>
          <div class="detail-item"><div class="detail-item-label">Password</div><div class="detail-item-val mono">••••••••</div></div>
        </div>
      </div>`;
    }
    body.innerHTML = html;
    return;
  }

  if (device.type === 'ups' && device.liveData) {
    const d = device.liveData;
    const simNote = d.simulated ? ' <span style="font-size:0.7rem;color:var(--text-3)">(simulated)</span>' : '';
    html += `
      <div class="detail-section">
        <div class="detail-section-title">UPS Information${simNote}</div>
        <div class="detail-grid">
          <div class="detail-item"><div class="detail-item-label">UPS Mode</div><div class="detail-item-val">${escHtml(String(d.mode))}</div></div>
          <div class="detail-item"><div class="detail-item-label">Temperature</div><div class="detail-item-val">${d.temperature} °C</div></div>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Input</div>
        <div class="detail-grid">
          <div class="detail-item"><div class="detail-item-label">Voltage</div><div class="detail-item-val">${d.inputVoltage} V</div></div>
          <div class="detail-item"><div class="detail-item-label">Frequency</div><div class="detail-item-val">${d.inputFreq} Hz</div></div>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Output</div>
        <div class="detail-grid">
          <div class="detail-item"><div class="detail-item-label">Voltage</div><div class="detail-item-val">${d.outputVoltage} V</div></div>
          <div class="detail-item"><div class="detail-item-label">Frequency</div><div class="detail-item-val">${d.outputFreq} Hz</div></div>
          <div class="detail-item"><div class="detail-item-label">Current</div><div class="detail-item-val">${d.outputCurrent} A</div></div>
          <div class="detail-item"><div class="detail-item-label">Load Level</div>
            <div class="detail-item-val ${parseInt(d.loadLevel) > 80 ? 'red' : parseInt(d.loadLevel) > 60 ? 'yellow' : 'green'}">${d.loadLevel} %</div>
          </div>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Battery</div>
        <div class="detail-grid">
          <div class="detail-item"><div class="detail-item-label">Voltage</div><div class="detail-item-val">${d.batteryVoltage} V</div></div>
          <div class="detail-item"><div class="detail-item-label">Capacity</div>
            <div class="detail-item-val ${parseInt(d.batteryCapacity) < 20 ? 'red' : parseInt(d.batteryCapacity) < 50 ? 'yellow' : 'green'}">${d.batteryCapacity} %</div>
          </div>
          <div class="detail-item"><div class="detail-item-label">Backup Time</div><div class="detail-item-val">${d.backupTime} Min</div></div>
        </div>
      </div>`;
  }

  body.innerHTML = html;
}

function closeDetailModal() {
  document.getElementById('modal-detail').classList.remove('open');
  selectedDeviceId = null;
  // Reset the footer to its default state in case it was stuck on the delete confirmation
  const footer = document.querySelector('#modal-detail .modal-footer');
  footer.innerHTML = `
    <button class="btn-ghost" id="btn-detail-close">Close</button>
    <button class="btn-danger" id="btn-delete-device">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
      Delete Device
    </button>`;
  reattachFooterEvents();
}

function deleteDevice() {
  if (!selectedDeviceId) return;
  const device = devices.find(d => d.id === selectedDeviceId);
  if (!device) return;

  // Show inline confirmation in the modal footer instead of browser confirm()
  const footer = document.querySelector('#modal-detail .modal-footer');
  const originalHTML = footer.innerHTML;

  footer.innerHTML = `
    <span style="flex:1;font-size:0.85rem;color:var(--red);font-weight:600">
      Delete "${escHtml(device.name)}"?
    </span>
    <button class="btn-ghost" id="btn-delete-cancel">Cancel</button>
    <button class="btn-danger" id="btn-delete-confirm">Yes, Delete</button>`;

  document.getElementById('btn-delete-cancel').onclick = () => { footer.innerHTML = originalHTML; reattachFooterEvents(); };
  document.getElementById('btn-delete-confirm').onclick = () => {
    devices = devices.filter(d => d.id !== selectedDeviceId);
    saveDevices();
    closeDetailModal();
    renderGrid();
    updateHeaderStats();
    showToast(`"${device.name}" removed`, 'info');
  };
}

function reattachFooterEvents() {
  document.getElementById('btn-delete-device').addEventListener('click', deleteDevice);
  document.getElementById('btn-detail-cancel').addEventListener('click', closeDetailModal);
  document.getElementById('btn-detail-close').addEventListener('click', closeDetailModal);
}

// ===== TOAST =====
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

// ===== UTILITIES =====
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

// ===== EVENT LISTENERS =====
function init() {
  loadDevices().then(() => {
    renderGrid();
    updateHeaderStats();
  });

  // Setup theme
  const savedTheme = localStorage.getItem('netwatch-theme') || 'dark';
  const updateThemeIcon = (isLight) => {
    document.getElementById('btn-theme').innerHTML = isLight
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
  };
  if (savedTheme === 'light') {
    document.documentElement.classList.add('light-theme');
    updateThemeIcon(true);
  }
  
  document.getElementById('btn-theme').addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('light-theme');
    updateThemeIcon(isLight);
    localStorage.setItem('netwatch-theme', isLight ? 'light' : 'dark');
  });

  // Auto-check all devices on load
  if (devices.length > 0) {
    setTimeout(() => refreshAll(), 500);
  }

  // Auto-poll
  pollTimer = setInterval(refreshAll, POLL_INTERVAL);

  // Header actions
  document.getElementById('btn-add-device').addEventListener('click', openAddModal);
  document.getElementById('btn-refresh-all').addEventListener('click', refreshAll);

  // Add modal
  document.getElementById('btn-modal-close').addEventListener('click', closeAddModal);
  document.getElementById('btn-cancel').addEventListener('click', closeAddModal);
  document.getElementById('btn-save-device').addEventListener('click', saveDevice);

  // Type selector — also shows/hides router credential section
  document.getElementById('type-selector').addEventListener('click', e => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    selectedType = btn.dataset.type;
    document.querySelectorAll('#type-selector .type-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('cred-section').classList.toggle('visible', selectedType === 'router');
  });

  // Router firmware selector
  document.getElementById('router-fw-selector').addEventListener('click', e => {
    const btn = e.target.closest('[data-fw]');
    if (!btn) return;
    selectedFirmware = btn.dataset.fw;
    document.querySelectorAll('#router-fw-selector .type-btn').forEach(b => b.classList.toggle('active', b === btn));
  });

  // Enter key in form
  ['input-name', 'input-ip', 'input-port', 'input-desc', 'input-username', 'input-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') saveDevice(); });
  });

  // Detail modal
  document.getElementById('btn-detail-close').addEventListener('click', closeDetailModal);
  document.getElementById('btn-detail-cancel').addEventListener('click', closeDetailModal);
  document.getElementById('btn-delete-device').addEventListener('click', deleteDevice);
  document.getElementById('btn-detail-refresh').addEventListener('click', async () => {
    if (!selectedDeviceId) return;
    await refreshDevice(selectedDeviceId);
    const device = devices.find(d => d.id === selectedDeviceId);
    if (device) renderDetailBody(device);
  });

  // Close on overlay click
  document.getElementById('modal-add').addEventListener('click', e => { if (e.target === e.currentTarget) closeAddModal(); });
  document.getElementById('modal-detail').addEventListener('click', e => { if (e.target === e.currentTarget) closeDetailModal(); });

  // Filter tabs
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeFilter = tab.dataset.filter;
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderGrid();
    });
  });

  // Search
  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase().trim();
    renderGrid();
  });

  // Keyboard close
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeAddModal(); closeDetailModal(); }
  });
}

document.addEventListener('DOMContentLoaded', init);
