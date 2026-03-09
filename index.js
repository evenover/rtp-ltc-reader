const express = require('express');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ptpv2 = require('ptpv2');
const config = require('./config.json')[0];

const IFACE = config.IFACE;
const PORT = config.PORT;
const MCIFACE = config.MCIFACE ? config.MCIFACE : IFACE;
const SOURCEMULTICAST = config.SOURCEMULTICAST;
const MCPORT = config.MCPORT;
const STREAMSIZE = config.STREAMSIZE;
const ENCODING = config.ENCODING || 'L24';
const SAMPLERATE = config.SAMPLERATE || 48000;
const SOURCEIP = config.SOURCEIP || '';
const DOMAIN = config.DOMAIN;
const TIMEZONE = config.TIMEZONE;
const DECODECHANNELS = config.DECODECHANNELS;
const SHOWFRAMES = config.SHOWFRAMES !== false;
const LEAPSECONDS = config.LEAPSECONDS || 0;
const NTPSERVER = config.NTPSERVER || '';
const CHANNEL_INFO = config.CHANNEL_INFO;

const dgram = require('dgram');

const app = express();
app.use(express.json());
const server = app.listen(PORT, () =>
  console.log(`Server på http://localhost:${PORT}`)
);

const wss = new WebSocket.Server({ server });

let latestTC = Array(DECODECHANNELS).fill("--:--:--:--");
let pipelineStatus = Array(DECODECHANNELS).fill('stopped');
let lastTCUpdate = Array(DECODECHANNELS).fill(0);
let restartCount = Array(DECODECHANNELS).fill(0);
let gstProcesses = Array(DECODECHANNELS).fill(null);
const MAX_RESTARTS = 5;
let ptpSynced = false;
let ptpMasterID = null;
let ntpTime = null;      // last NTP-derived Date
let ntpLocalRef = null;   // process.hrtime() at last NTP sync
let ntpSynced = false;
let clockOffsetMs = config.CLOCKOFFSET || 0;  // internal clock offset from system time
let streamActive = false;
let lastRtpPacket = 0;
let probeSocket = null;

// Initialize PTP sync
try {
  console.log(`PTP init: IFACE=${IFACE}, DOMAIN=${DOMAIN}`);
  ptpv2.init(IFACE, DOMAIN, () => {
    ptpSynced = true;
    ptpMasterID = ptpv2.ptp_master();
    console.log(`PTP synced to master: ${ptpMasterID}`);
  });
} catch (e) {
  console.error(`PTP init failed: ${e.message}`);
}

process.on('uncaughtException', (err) => {
  console.error(`Uncaught exception: ${err.message} (syscall: ${err.syscall || 'n/a'})`);
  if (err.syscall === 'addMembership' || err.syscall === 'bind') {
    // Non-fatal: PTP network issue
  } else {
    throw err;
  }
});

// NTP client
function ntpQuery() {
  if (!NTPSERVER) return;
  const client = dgram.createSocket('udp4');
  const msg = Buffer.alloc(48);
  msg[0] = 0x1B; // LI=0, Version=3, Mode=3 (client)
  const t1 = Date.now();
  client.send(msg, 123, NTPSERVER, (err) => {
    if (err) { client.close(); return; }
  });
  client.on('message', (buf) => {
    const t4 = Date.now();
    if (buf.length < 48) { client.close(); return; }
    // Transmit timestamp: seconds since 1900-01-01 at bytes 40-43, fraction at 44-47
    const secs = buf.readUInt32BE(40);
    const frac = buf.readUInt32BE(44);
    const NTP_EPOCH = 2208988800; // seconds from 1900 to 1970
    const serverMs = (secs - NTP_EPOCH) * 1000 + Math.floor(frac / 4294967.296);
    const rtt = t4 - t1;
    ntpTime = new Date(serverMs + Math.floor(rtt / 2));
    ntpLocalRef = process.hrtime();
    ntpSynced = true;
    client.close();
  });
  client.on('error', () => { client.close(); });
  setTimeout(() => { try { client.close(); } catch(e) {} }, 5000);
}

if (NTPSERVER) {
  ntpQuery();
  setInterval(ntpQuery, 60000);
  console.log(`NTP polling: server=${NTPSERVER}`);
}

function startPipeline(channelIndex) {
  if (!streamActive) {
    pipelineStatus[channelIndex] = 'waiting';
    return;
  }
  const depay = ENCODING === 'L16' ? 'rtpL16depay' : 'rtpL24depay';
  const bitFmt = ENCODING === 'L16' ? 'S16LE' : 'S16LE';

  const args = [
    'udpsrc',
    `address=${SOURCEMULTICAST}`,
    `port=${MCPORT}`,
    `multicast-iface=${MCIFACE}`,
    'auto-multicast=true',
    `caps=application/x-rtp,media=audio,clock-rate=${SAMPLERATE},encoding-name=${ENCODING},channels=${STREAMSIZE}`,
    '!',
    depay,
    '!',
    'audioconvert',
    '!',
    `audio/x-raw,format=${bitFmt},channels=${STREAMSIZE}`,
    '!',
    'deinterleave',
    'name=d',
    `d.src_${channelIndex}`,
    '!',
    'queue',
    '!',
    'ltcdec',
    '!',
    'fakesink'
  ];

  const gst = spawn('gst-launch-1.0', args);
  gstProcesses[channelIndex] = gst;

  pipelineStatus[channelIndex] = 'starting';

  gst.on('error', (err) => {
    console.error(`Pipeline ${channelIndex+1}: ${err.message}`);
    pipelineStatus[channelIndex] = 'error';
  });

  gst.stderr.on('data', data => {
    const text = data.toString();
    const match = text.match(/(\d\d:\d\d:\d\d:\d\d)/);
    if (match) {
      latestTC[channelIndex] = match[1];
      lastTCUpdate[channelIndex] = Date.now();
      pipelineStatus[channelIndex] = 'decoding';
      restartCount[channelIndex] = 0;
    } else if (pipelineStatus[channelIndex] === 'starting') {
      pipelineStatus[channelIndex] = 'running';
    }
  });

  gst.on('exit', () => {
    gstProcesses[channelIndex] = null;
    if (!streamActive) {
      pipelineStatus[channelIndex] = 'waiting';
      return;
    }
    pipelineStatus[channelIndex] = 'stopped';
    restartCount[channelIndex]++;
    if (restartCount[channelIndex] <= MAX_RESTARTS) {
      console.log(`Pipeline ${channelIndex+1} restarting (${restartCount[channelIndex]}/${MAX_RESTARTS})`);
      setTimeout(() => startPipeline(channelIndex), 1000);
    } else {
      console.log(`Pipeline ${channelIndex+1} exceeded max restarts (${MAX_RESTARTS}), stopped`);
      pipelineStatus[channelIndex] = 'failed';
    }
  });
}

function stopAllPipelines() {
  for (let i = 0; i < DECODECHANNELS; i++) {
    if (gstProcesses[i]) {
      gstProcesses[i].kill();
      gstProcesses[i] = null;
    }
    pipelineStatus[i] = 'waiting';
    restartCount[i] = 0;
  }
}

function startAllPipelines() {
  for (let i = 0; i < DECODECHANNELS; i++) {
    if (!gstProcesses[i]) {
      startPipeline(i);
    }
  }
}

// RTP stream probe — listens for packets on the multicast group
function startStreamProbe() {
  if (probeSocket) return;
  const STREAM_TIMEOUT = 5000; // ms without packets → stream gone

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  probeSocket = sock;

  sock.on('message', () => {
    lastRtpPacket = Date.now();
    if (!streamActive) {
      streamActive = true;
      console.log('RTP stream detected — starting decode pipelines');
      startAllPipelines();
    }
  });

  sock.on('error', (err) => {
    console.error(`Stream probe error: ${err.message}`);
    try { sock.close(); } catch(e) {}
    probeSocket = null;
    setTimeout(startStreamProbe, 5000);
  });

  sock.bind(MCPORT, () => {
    try {
      if (SOURCEIP) {
        sock.addMembership(SOURCEMULTICAST, MCIFACE);
      } else {
        sock.addMembership(SOURCEMULTICAST, MCIFACE);
      }
      console.log(`Stream probe listening on ${SOURCEMULTICAST}:${MCPORT}`);
    } catch (e) {
      console.error(`Stream probe join failed: ${e.message}`);
    }
  });

  // Periodic check: if no packets for STREAM_TIMEOUT, stream is gone
  const monitor = setInterval(() => {
    if (!probeSocket) { clearInterval(monitor); return; }
    if (streamActive && lastRtpPacket > 0 && (Date.now() - lastRtpPacket) > STREAM_TIMEOUT) {
      streamActive = false;
      console.log('RTP stream lost — stopping decode pipelines');
      stopAllPipelines();
    }
  }, 1000);
}

// Set initial state and start probe
for (let i = 0; i < DECODECHANNELS; i++) {
  pipelineStatus[i] = 'waiting';
}
startStreamProbe();

// Combo route: /ptp+ntp, /ptp+channel-1, /ntp+channel-1+channel-2, etc.
const comboPattern = /^\/(?:(?:ptp|ntp|clock|channel-\d+)\+)+(?:ptp|ntp|clock|channel-\d+)$/;
app.get('/:combo', (req, res, next) => {
  const decoded = decodeURIComponent(req.path);
  if (comboPattern.test(decoded)) return res.sendFile(path.join(__dirname, 'combo.html'));
  next();
});

app.get('/channel-:ids', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ptp', (req, res) => {
  res.sendFile(path.join(__dirname, 'ptp.html'));
});

app.get('/ntp', (req, res) => {
  res.sendFile(path.join(__dirname, 'ntp.html'));
});

app.get('/clock', (req, res) => {
  res.sendFile(path.join(__dirname, 'clock.html'));
});

app.post('/api/setclock', (req, res) => {
  const { time } = req.body;
  if (time === null || time === undefined) {
    clockOffsetMs = 0;
    return res.json({ ok: true, offset: 0 });
  }
  // Accept HH:MM:SS — build a date for today with that time in the configured timezone
  const parts = String(time).match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!parts) return res.status(400).json({ ok: false, error: 'Invalid time format (use HH:MM:SS)' });
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const target = new Date(`${todayStr}T${time}`);
  const localNow = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  clockOffsetMs = target.getTime() - localNow.getTime();
  res.json({ ok: true, offset: clockOffsetMs });
});

app.get('/api/clock', (req, res) => {
  const now = new Date(Date.now() + clockOffsetMs);
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(now);
  const time = `${p.find(x => x.type === 'hour').value}:${p.find(x => x.type === 'minute').value}:${p.find(x => x.type === 'second').value}`;
  res.json({ time, offset: clockOffsetMs });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'setup.html'));
});

app.get('/api/interfaces', (req, res) => {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4') {
        result.push({ name, address: addr.address });
      }
    }
  }
  res.json(result);
});

app.get('/api/config', (req, res) => {
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
  res.json(JSON.parse(raw)[0]);
});

app.post('/api/restart/:channel', (req, res) => {
  const ch = parseInt(req.params.channel) - 1;
  if (isNaN(ch) || ch < 0 || ch >= DECODECHANNELS) {
    return res.status(400).json({ ok: false, message: 'Invalid channel' });
  }
  if (gstProcesses[ch]) {
    gstProcesses[ch].kill();
  }
  restartCount[ch] = 0;
  pipelineStatus[ch] = 'stopped';
  setTimeout(() => startPipeline(ch), 500);
  res.json({ ok: true, message: `Channel ${ch + 1} restarting` });
});

app.post('/api/restart', (req, res) => {
  for (let i = 0; i < DECODECHANNELS; i++) {
    if (gstProcesses[i]) {
      gstProcesses[i].kill();
    }
    restartCount[i] = 0;
    pipelineStatus[i] = 'stopped';
  }
  setTimeout(() => {
    for (let i = 0; i < DECODECHANNELS; i++) startPipeline(i);
  }, 500);
  res.json({ ok: true, message: 'All channels restarting' });
});

app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  fs.writeFileSync(
    path.join(__dirname, 'config.json'),
    JSON.stringify([newConfig], null, 4),
    'utf8'
  );
  res.json({ ok: true, message: 'Config saved. Restarting...' });
  setTimeout(() => process.exit(0), 500);
});

app.get('/api/status', (req, res) => {
  const now = Date.now();
  const channels = [];
  for (let i = 0; i < DECODECHANNELS; i++) {
    const active = lastTCUpdate[i] > 0 && (now - lastTCUpdate[i]) < 5000;
    channels.push({
      channel: i + 1,
      name: CHANNEL_INFO[i] ? CHANNEL_INFO[i].name : `Channel ${i + 1}`,
      pipeline: pipelineStatus[i],
      tc: latestTC[i],
      receiving: active,
      restarts: restartCount[i],
      maxRestarts: MAX_RESTARTS
    });
  }
  res.json({
    stream: streamActive,
    ptp: {
      synced: ptpv2.is_synced(),
      master: ptpv2.is_synced() ? ptpv2.ptp_master() : null
    },
    ntp: {
      synced: ntpSynced,
      server: NTPSERVER || null
    },
    channels
  });
});

wss.on('connection', (ws, req) => {
  // Status endpoint
  if (req.url === '/status') {
    const interval = setInterval(() => {
      const now = Date.now();
      const channels = [];
      for (let i = 0; i < DECODECHANNELS; i++) {
        const active = lastTCUpdate[i] > 0 && (now - lastTCUpdate[i]) < 5000;
        channels.push({
          channel: i + 1,
          name: CHANNEL_INFO[i] ? CHANNEL_INFO[i].name : `Channel ${i + 1}`,
          pipeline: pipelineStatus[i],
          tc: latestTC[i],
          receiving: active,
          restarts: restartCount[i],
          maxRestarts: MAX_RESTARTS
        });
      }
      ws.send(JSON.stringify({
        stream: streamActive,
        ptp: {
          synced: ptpv2.is_synced(),
          master: ptpv2.is_synced() ? ptpv2.ptp_master() : null
        },
        ntp: {
          synced: ntpSynced,
          server: NTPSERVER || null
        },
        channels
      }));
    }, 1000);
    ws.on('close', () => clearInterval(interval));
    return;
  }

  // PTP clock endpoint
  if (req.url === '/ptp') {
    const interval = setInterval(() => {
      const synced = ptpv2.is_synced();
      const time = synced ? ptpv2.ptp_time() : null;
      const master = synced ? ptpv2.ptp_master() : null;
      let formatted = '--:--:--:--';
      if (time) {
        const utcOffset = ptpv2.utc_offset() + LEAPSECONDS;
        const d = new Date((time[0] - utcOffset) * 1000 + Math.floor(time[1] / 1e6));
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: TIMEZONE,
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false
        }).formatToParts(d);
        const hh = parts.find(p => p.type === 'hour').value;
        const mm = parts.find(p => p.type === 'minute').value;
        const ss = parts.find(p => p.type === 'second').value;
        const fr = String(Math.floor(time[1] / (1e9 / 25))).padStart(2, '0');
        formatted = `${hh}:${mm}:${ss}:${fr}`;
      }
      ws.send(JSON.stringify({
        synced,
        master,
        time: formatted,
        timezone: TIMEZONE,
        showframes: SHOWFRAMES,
        seconds: time ? time[0] : null,
        nanoseconds: time ? time[1] : null
      }));
    }, 40);
    ws.on('close', () => clearInterval(interval));
    return;
  }

  // NTP clock endpoint
  if (req.url === '/ntp') {
    const interval = setInterval(() => {
      let formatted = '--:--:--';
      if (ntpTime) {
        const elapsed = process.hrtime(ntpLocalRef);
        const now = new Date(ntpTime.getTime() + elapsed[0] * 1000 + Math.floor(elapsed[1] / 1e6));
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: TIMEZONE,
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false
        }).formatToParts(now);
        const hh = parts.find(p => p.type === 'hour').value;
        const mm = parts.find(p => p.type === 'minute').value;
        const ss = parts.find(p => p.type === 'second').value;
        const ms = String(now.getMilliseconds()).padStart(3, '0');
        formatted = SHOWFRAMES ? `${hh}:${mm}:${ss}.${ms}` : `${hh}:${mm}:${ss}`;
      }
      ws.send(JSON.stringify({
        synced: ntpSynced,
        server: NTPSERVER,
        time: formatted,
        timezone: TIMEZONE
      }));
    }, 100);
    ws.on('close', () => clearInterval(interval));
    return;
  }

  // Internal clock endpoint
  if (req.url === '/clock') {
    const interval = setInterval(() => {
      const now = new Date(Date.now() + clockOffsetMs);
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIMEZONE,
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).formatToParts(now);
      const hh = parts.find(p => p.type === 'hour').value;
      const mm = parts.find(p => p.type === 'minute').value;
      const ss = parts.find(p => p.type === 'second').value;
      const ms = String(now.getMilliseconds()).padStart(3, '0');
      const formatted = SHOWFRAMES ? `${hh}:${mm}:${ss}.${ms}` : `${hh}:${mm}:${ss}`;
      ws.send(JSON.stringify({
        time: formatted,
        timezone: TIMEZONE,
        offset: clockOffsetMs
      }));
    }, 100);
    ws.on('close', () => clearInterval(interval));
    return;
  }

  // Combo clock endpoint: URLs like /ptp+ntp, /ptp+channel-1, etc.
  const urlPath = decodeURIComponent(req.url).replace(/\s/g, '+').slice(1);
  const segments = urlPath.split('+');
  const validSeg = s => s === 'ptp' || s === 'ntp' || s === 'clock' || /^channel-\d+$/.test(s);
  if (segments.length >= 2 && segments.every(validSeg)) {
    console.log(`Combo WS connected: ${segments.join('+')}`);
    const interval = setInterval(() => {
      try {
        const clocks = segments.map(seg => {
          if (seg === 'ptp') {
            let synced = false;
            let formatted = '--:--:--:--';
            try {
              synced = ptpv2.is_synced();
              const time = synced ? ptpv2.ptp_time() : null;
              if (time) {
                const utcOffset = ptpv2.utc_offset() + LEAPSECONDS;
                const d = new Date((time[0] - utcOffset) * 1000 + Math.floor(time[1] / 1e6));
                const parts = new Intl.DateTimeFormat('en-GB', {
                  timeZone: TIMEZONE,
                  hour: '2-digit', minute: '2-digit', second: '2-digit',
                  hour12: false
                }).formatToParts(d);
                const hh = parts.find(p => p.type === 'hour').value;
                const mm = parts.find(p => p.type === 'minute').value;
                const ss = parts.find(p => p.type === 'second').value;
                const fr = String(Math.floor(time[1] / (1e9 / 25))).padStart(2, '0');
                formatted = SHOWFRAMES ? `${hh}:${mm}:${ss}:${fr}` : `${hh}:${mm}:${ss}`;
              }
            } catch(e) {}
            return { id: 'ptp', label: 'PTP', time: formatted, synced };
          } else if (seg === 'ntp') {
            let formatted = '--:--:--';
            if (ntpTime) {
              const elapsed = process.hrtime(ntpLocalRef);
              const now = new Date(ntpTime.getTime() + elapsed[0] * 1000 + Math.floor(elapsed[1] / 1e6));
              const parts = new Intl.DateTimeFormat('en-GB', {
                timeZone: TIMEZONE,
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false
              }).formatToParts(now);
              const hh = parts.find(p => p.type === 'hour').value;
              const mm = parts.find(p => p.type === 'minute').value;
              const ss = parts.find(p => p.type === 'second').value;
              const ms = String(now.getMilliseconds()).padStart(3, '0');
              formatted = SHOWFRAMES ? `${hh}:${mm}:${ss}.${ms}` : `${hh}:${mm}:${ss}`;
            }
            return { id: 'ntp', label: 'NTP', time: formatted, synced: ntpSynced };
          } else if (seg === 'clock') {
            const now = new Date(Date.now() + clockOffsetMs);
            const parts = new Intl.DateTimeFormat('en-GB', {
              timeZone: TIMEZONE,
              hour: '2-digit', minute: '2-digit', second: '2-digit',
              hour12: false
            }).formatToParts(now);
            const hh = parts.find(p => p.type === 'hour').value;
            const mm = parts.find(p => p.type === 'minute').value;
            const ss = parts.find(p => p.type === 'second').value;
            const ms = String(now.getMilliseconds()).padStart(3, '0');
            const formatted = SHOWFRAMES ? `${hh}:${mm}:${ss}.${ms}` : `${hh}:${mm}:${ss}`;
            return { id: 'clock', label: 'Clock', time: formatted, synced: true };
          } else {
            const chNum = parseInt(seg.replace('channel-', '')) - 1;
            const name = CHANNEL_INFO[chNum] ? CHANNEL_INFO[chNum].name : `Channel ${chNum + 1}`;
            const active = lastTCUpdate[chNum] > 0 && (Date.now() - lastTCUpdate[chNum]) < 5000;
            let tc = latestTC[chNum] || '--:--:--:--';
            if (!SHOWFRAMES) tc = tc.replace(/:[^:]*$/, '');
            return { id: seg, label: name, time: tc, synced: active };
          }
        });
        ws.send(JSON.stringify(clocks));
      } catch(e) {
        console.error('Combo WS error:', e.message);
      }
    }, 40);
    ws.on('close', () => clearInterval(interval));
    return;
  }

  // LTC channel endpoints
  const match = req.url.match(/channel-([\d+]+)/);
  if (!match) return;

  const channels = match[1]
    .split('+')
    .map(n => parseInt(n) - 1)
    .filter(n => n >= 0 && n < DECODECHANNELS);

  const interval = setInterval(() => {
    const payload = channels.map(ch => ({
      channel: ch + 1,
      name: CHANNEL_INFO[ch].name,
      tc: latestTC[ch],
      showframes: SHOWFRAMES
    }));
    ws.send(JSON.stringify(payload));
  }, 40);

  ws.on('close', () => clearInterval(interval));
});