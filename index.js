const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ptpv2 = require('ptpv2');

const configPath = path.join(__dirname, 'config.json');
const defaultConfig = [{
  IFACE: '',
  PORT: 5000,
  MCIFACE: '',
  SOURCEMULTICAST: '',
  MCPORT: 5004,
  STREAMSIZE: 8,
  ENCODING: 'L24',
  SAMPLERATE: 48000,
  SOURCEIP: '',
  TIMEZONE: 'Europe/Oslo',
  DOMAIN: 0,
  LEAPSECONDS: 0,
  NTPSERVER: '',
  DECODECHANNELS: 1,
  SHOWFRAMES: false,
  CHANNEL_INFO: [{ name: 'Channel 1', streamChannel: 1 }],
  OUTPUTS: []
}];

if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 4), 'utf8');
  console.log('Created default config.json — configure via the setup page.');
}
let config = JSON.parse(fs.readFileSync(configPath, 'utf8'))[0];

let IFACE = config.IFACE;
const PORT = config.PORT;
let MCIFACE = config.MCIFACE ? config.MCIFACE : IFACE;
let SOURCEMULTICAST = config.SOURCEMULTICAST;
let MCPORT = config.MCPORT;
let STREAMSIZE = config.STREAMSIZE;
let ENCODING = config.ENCODING || 'L24';
let SAMPLERATE = config.SAMPLERATE || 48000;
let SOURCEIP = config.SOURCEIP || '';
let DOMAIN = config.DOMAIN;
let TIMEZONE = config.TIMEZONE;
let CHANNEL_INFO = (config.CHANNEL_INFO || []).map((ch, i) => ({
  name: ch.name || `Channel ${i + 1}`,
  streamChannel: ch.streamChannel != null ? ch.streamChannel : i + 1
}));
let DECODECHANNELS = CHANNEL_INFO.length;
let SHOWFRAMES = config.SHOWFRAMES !== false;
let LEAPSECONDS = config.LEAPSECONDS || 0;
let NTPSERVER = config.NTPSERVER || '';

const dgram = require('dgram');

// In-memory outputs config (persisted in config.json)
let outputs = config.OUTPUTS || [];

const app = express();
app.use(express.json());
const server = app.listen(PORT, () =>
  console.log(`Server listening on http://localhost:${PORT}`)
);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nError: Port ${PORT} is already in use.\nRun: lsof -ti :${PORT} | xargs kill -9\nThen restart.\n`);
    process.exit(1);
  } else {
    throw err;
  }
});

const wss = new WebSocket.Server({ server });
wss.on('error', () => {});

let latestTC = Array(DECODECHANNELS).fill("--:--:--:--");
let pipelineStatus = Array(DECODECHANNELS).fill('stopped');
let lastTCUpdate = Array(DECODECHANNELS).fill(0);
let restartCount = Array(DECODECHANNELS).fill(0);
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
let ntpInterval = null;
let ptpInitialized = false;

// ========== LTC Decoder (pure Node.js, no GStreamer) ==========

function bitsToInt(bits, offset, count) {
  let val = 0;
  for (let i = 0; i < count; i++) {
    val |= (bits[offset + i] << i); // LSB first in LTC
  }
  return val;
}

class LTCDecoder {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.prevSign = 0;
    this.sampleCount = 0;
    this.waitingForSecondHalf = false;
    this.bits = [];

    // Calculate threshold from sample rate — works for 24/25/29.97/30 fps
    // Long interval (0-bit) = sampleRate / (fps * 80), Short = Long / 2
    // Use 25fps as reference: long=24 short=12 at 48kHz
    const longInterval = sampleRate / (25 * 80);
    const shortInterval = longInterval / 2;
    this.threshold = (shortInterval + longInterval) / 2;
    this.minInterval = shortInterval * 0.4;
    this.maxInterval = longInterval * 2.0;
    this.calibrating = false;
    console.log(`LTC decoder: threshold=${this.threshold.toFixed(1)}, range=[${this.minInterval.toFixed(1)}, ${this.maxInterval.toFixed(1)}]`);
  }

  reset() {
    this.prevSign = 0;
    this.sampleCount = 0;
    this.waitingForSecondHalf = false;
    this.bits = [];
  }

  decode(samples) {
    const results = [];
    for (let i = 0; i < samples.length; i++) {
      const sign = samples[i] >= 0 ? 1 : -1;
      this.sampleCount++;

      if (sign !== this.prevSign && this.prevSign !== 0) {
        const interval = this.sampleCount;
        this.sampleCount = 0;

        // Only process intervals in the expected LTC range
        if (interval >= this.minInterval && interval <= this.maxInterval) {
          this.processTransition(interval, results);
        }
      }
      this.prevSign = sign;
    }
    return results;
  }

  processTransition(interval, results) {
    if (interval < this.threshold) {
      // Short interval — half of a "1" bit
      if (this.waitingForSecondHalf) {
        this.bits.push(1);
        this.waitingForSecondHalf = false;
        this.checkFrame(results);
      } else {
        this.waitingForSecondHalf = true;
      }
    } else {
      // Long interval — full "0" bit
      this.waitingForSecondHalf = false;
      this.bits.push(0);
      this.checkFrame(results);
    }

    if (this.bits.length > 200) {
      this.bits = this.bits.slice(-80);
    }
  }

  checkFrame(results) {
    if (this.bits.length < 80) return;

    // LTC sync word (bits 64-79): 0011111111111101
    const SYNC = [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,1];
    const last80 = this.bits.slice(-80);
    const tail = last80.slice(64);

    for (let i = 0; i < 16; i++) {
      if (tail[i] !== SYNC[i]) return;
    }

    const tc = this.extractTimecode(last80);
    if (tc) results.push(tc);
    this.bits = [];
  }

  extractTimecode(bits) {
    const frameUnits = bitsToInt(bits, 0, 4);
    const frameTens  = bitsToInt(bits, 8, 2);
    const secsUnits  = bitsToInt(bits, 16, 4);
    const secsTens   = bitsToInt(bits, 24, 3);
    const minsUnits  = bitsToInt(bits, 32, 4);
    const minsTens   = bitsToInt(bits, 40, 3);
    const hrsUnits   = bitsToInt(bits, 48, 4);
    const hrsTens    = bitsToInt(bits, 56, 2);

    const frames  = frameTens * 10 + frameUnits;
    const seconds = secsTens * 10 + secsUnits;
    const minutes = minsTens * 10 + minsUnits;
    const hours   = hrsTens * 10 + hrsUnits;

    if (hours > 23 || minutes > 59 || seconds > 59 || frames > 30) return null;

    const p = n => String(n).padStart(2, '0');
    return `${p(hours)}:${p(minutes)}:${p(seconds)}:${p(frames)}`;
  }
}

// Extract per-channel audio from an RTP packet
function extractAudioFromRTP(buf, streamSize) {
  if (buf.length < 12) return null;
  const cc = buf[0] & 0x0f;
  const hasExtension = (buf[0] >> 4) & 0x01;
  let offset = 12 + cc * 4;
  if (hasExtension && buf.length >= offset + 4) {
    const extLen = buf.readUInt16BE(offset + 2);
    offset += 4 + extLen * 4;
  }

  const bytesPerSample = ENCODING === 'L16' ? 2 : 3;
  const bytesPerFrame = bytesPerSample * streamSize;
  const payloadLen = buf.length - offset;
  const numFrames = Math.floor(payloadLen / bytesPerFrame);
  if (numFrames === 0) return null;

  const channels = [];
  for (let ch = 0; ch < streamSize; ch++) {
    channels.push(new Float64Array(numFrames));
  }

  for (let f = 0; f < numFrames; f++) {
    for (let ch = 0; ch < streamSize; ch++) {
      const off = offset + f * bytesPerFrame + ch * bytesPerSample;
      let sample;
      if (bytesPerSample === 3) {
        sample = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
        if (sample & 0x800000) sample -= 0x1000000;
        channels[ch][f] = sample / 8388608.0;
      } else {
        sample = (buf[off] << 8) | buf[off + 1];
        if (sample & 0x8000) sample -= 0x10000;
        channels[ch][f] = sample / 32768.0;
      }
    }
  }
  return channels;
}

// Create LTC decoders for each channel
const ltcDecoders = [];
for (let i = 0; i < DECODECHANNELS; i++) {
  ltcDecoders.push(new LTCDecoder(SAMPLERATE));
}

function initPTP() {
  if (ptpInitialized) return;
  try {
    console.log(`PTP init: IFACE=${IFACE}, DOMAIN=${DOMAIN}`);
    ptpv2.init(IFACE, DOMAIN, () => {
      ptpSynced = true;
      ptpMasterID = ptpv2.ptp_master();
      console.log(`PTP synced to master: ${ptpMasterID}`);
    });
    ptpInitialized = true;
  } catch (e) {
    console.error(`PTP init failed: ${e.message}`);
  }
}

process.on('uncaughtException', (err) => {
  console.error(`Uncaught exception: ${err.message} (syscall: ${err.syscall || 'n/a'})`);
  if (err.syscall === 'addMembership' || err.syscall === 'addSourceSpecificMembership' || err.syscall === 'bind') {
    // Non-fatal: network issue
  } else if (err.code === 'ERR_MISSING_ARGS' || err.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
    // Non-fatal: PTP/NTP socket issue (e.g. Docker bridge network)
  } else {
    throw err;
  }
});

// NTP client
function ntpQuery() {
  if (!NTPSERVER) return;
  const client = dgram.createSocket('udp4');
  let closed = false;
  const safeClose = () => { if (!closed) { closed = true; try { client.close(); } catch(e) {} } };
  const msg = Buffer.alloc(48);
  msg[0] = 0x1B; // LI=0, Version=3, Mode=3 (client)
  const t1 = Date.now();
  client.send(msg, 123, NTPSERVER, (err) => {
    if (err) { safeClose(); return; }
  });
  client.on('message', (buf) => {
    const t4 = Date.now();
    if (buf.length < 48) { safeClose(); return; }
    // Transmit timestamp: seconds since 1900-01-01 at bytes 40-43, fraction at 44-47
    const secs = buf.readUInt32BE(40);
    const frac = buf.readUInt32BE(44);
    const NTP_EPOCH = 2208988800; // seconds from 1900 to 1970
    const serverMs = (secs - NTP_EPOCH) * 1000 + Math.floor(frac / 4294967.296);
    const rtt = t4 - t1;
    ntpTime = new Date(serverMs + Math.floor(rtt / 2));
    ntpLocalRef = process.hrtime();
    ntpSynced = true;
    safeClose();
  });
  client.on('error', () => { safeClose(); });
  setTimeout(safeClose, 5000);
}

function startNTP() {
  if (!NTPSERVER) return;
  ntpQuery();
  ntpInterval = setInterval(ntpQuery, 60000);
  console.log(`NTP polling: server=${NTPSERVER}`);
}

function stopNTP() {
  if (ntpInterval) { clearInterval(ntpInterval); ntpInterval = null; }
  ntpSynced = false;
  ntpTime = null;
}

function startPipeline(channelIndex) {
  // LTC decoding now happens inline in the stream probe — this is a no-op
  pipelineStatus[channelIndex] = 'decoding';
}

function stopAllPipelines() {
  for (let i = 0; i < DECODECHANNELS; i++) {
    pipelineStatus[i] = 'waiting';
    restartCount[i] = 0;
    ltcDecoders[i].reset();
  }
}

function startAllPipelines() {
  for (let i = 0; i < DECODECHANNELS; i++) {
    pipelineStatus[i] = 'decoding';
  }
}

// RTP stream probe — listens for packets on the multicast group
function startStreamProbe() {
  if (probeSocket) return;
  const STREAM_TIMEOUT = 5000; // ms without packets → stream gone

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  probeSocket = sock;

  sock.on('message', (buf) => {
    lastRtpPacket = Date.now();
    if (!streamActive) {
      streamActive = true;
      console.log('RTP stream detected — decoding LTC');
      startAllPipelines();
    }

    // Decode LTC from RTP audio
    try {
      const channels = extractAudioFromRTP(buf, STREAMSIZE);
      if (!channels) return;
      for (let ch = 0; ch < DECODECHANNELS; ch++) {
        const streamCh = (CHANNEL_INFO[ch].streamChannel || (ch + 1)) - 1; // 0-based stream index
        if (streamCh < 0 || streamCh >= channels.length) continue;

        // Track peak level for diagnostics
        let peak = 0;
        for (let s = 0; s < channels[streamCh].length; s++) {
          const abs = Math.abs(channels[streamCh][s]);
          if (abs > peak) peak = abs;
        }
        if (!ltcDecoders[ch]._peakLevel || peak > ltcDecoders[ch]._peakLevel) {
          ltcDecoders[ch]._peakLevel = peak;
        }

        // Skip decoding if signal is below -50 dBFS (too low to be LTC)
        if (peak < 0.00316) continue;

        const timecodes = ltcDecoders[ch].decode(channels[streamCh]);
        if (timecodes.length > 0) {
          latestTC[ch] = timecodes[timecodes.length - 1];
          lastTCUpdate[ch] = Date.now();
          pipelineStatus[ch] = 'decoding';
        }
      }
    } catch (e) {
      // Malformed packet — ignore
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
        // SSM (Source-Specific Multicast) — required for 232.x.x.x range
        sock.addSourceSpecificMembership(SOURCEIP, SOURCEMULTICAST, MCIFACE || undefined);
        console.log(`Stream probe listening on ${SOURCEMULTICAST}:${MCPORT} (SSM source=${SOURCEIP})`);
      } else if (MCIFACE) {
        sock.addMembership(SOURCEMULTICAST, MCIFACE);
        console.log(`Stream probe listening on ${SOURCEMULTICAST}:${MCPORT}`);
      } else {
        sock.addMembership(SOURCEMULTICAST);
        console.log(`Stream probe listening on ${SOURCEMULTICAST}:${MCPORT}`);
      }
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

  // Diagnostic: scan ALL stream channels for signal levels
  const scanPeaks = new Float64Array(STREAMSIZE);
  const scanCrossings = new Uint32Array(STREAMSIZE);
  const scanPrevSign = new Int8Array(STREAMSIZE);
  let scanPackets = 0;

  sock.on('message', (buf) => {
    if (scanPackets >= 0) {
      scanPackets++;
      try {
        const allCh = extractAudioFromRTP(buf, STREAMSIZE);
        if (!allCh) return;
        for (let ch = 0; ch < STREAMSIZE; ch++) {
          for (let s = 0; s < allCh[ch].length; s++) {
            const abs = Math.abs(allCh[ch][s]);
            if (abs > scanPeaks[ch]) scanPeaks[ch] = abs;
            const sign = allCh[ch][s] >= 0 ? 1 : -1;
            if (scanPrevSign[ch] !== 0 && sign !== scanPrevSign[ch]) scanCrossings[ch]++;
            scanPrevSign[ch] = sign;
          }
        }
      } catch(e) {}
    }
  });

  setTimeout(() => {
    console.log(`\n=== Channel scan (${STREAMSIZE} channels, ${scanPackets} packets) ===`);
    for (let ch = 0; ch < STREAMSIZE; ch++) {
      const peakDb = scanPeaks[ch] > 0 ? (20 * Math.log10(scanPeaks[ch])).toFixed(1) : '-inf';
      const crossRate = scanCrossings[ch]; // over ~5 seconds
      const looksLikeLTC = crossRate > 5000 && crossRate < 25000;
      console.log(`  ch${ch + 1}: peak=${peakDb}dBFS, crossings=${crossRate}${looksLikeLTC ? ' ◄ likely LTC' : ''}`);
    }
    console.log('===\n');
    scanPackets = -1; // stop scanning
  }, 5000);

  // Diagnostic log every 5 seconds for decode channels
  let diagCount = 0;
  setInterval(() => {
    if (!streamActive) return;
    diagCount++;
    if (diagCount > 12) return; // stop after 60s
    for (let ch = 0; ch < DECODECHANNELS; ch++) {
      const d = ltcDecoders[ch];
      const streamCh = CHANNEL_INFO[ch] ? CHANNEL_INFO[ch].streamChannel : ch + 1;
      const peakDb = d._peakLevel ? (20 * Math.log10(d._peakLevel)).toFixed(1) : '-inf';
      console.log(`[diag] decode-ch${ch + 1} (stream-ch${streamCh}): peak=${peakDb}dBFS, bits=${d.bits.length}, tc=${latestTC[ch]}`);
      d._peakLevel = 0; // reset for next period
    }
  }, 5000);
}

// Auto-start all services
for (let i = 0; i < DECODECHANNELS; i++) {
  pipelineStatus[i] = 'waiting';
}
console.log('--- Startup config ---');
console.log(`  IFACE: ${IFACE || '(empty — OS will pick default)'}`);
console.log(`  MCIFACE: ${MCIFACE || '(empty — OS will pick default)'}`);
console.log(`  Multicast: ${SOURCEMULTICAST}:${MCPORT}${SOURCEIP ? ` (SSM source=${SOURCEIP})` : ''}`);
console.log(`  PTP domain: ${DOMAIN}`);
const nics = os.networkInterfaces();
for (const [name, addrs] of Object.entries(nics)) {
  for (const addr of addrs) {
    if (addr.family === 'IPv4') console.log(`  NIC: ${name} = ${addr.address}`);
  }
}
console.log('----------------------');
initPTP();
startNTP();
startStreamProbe();

function stopStreamProbe() {
  if (probeSocket) {
    try { probeSocket.close(); } catch(e) {}
    probeSocket = null;
  }
  streamActive = false;
}

function reloadConfig() {
  console.log('Reloading config...');
  const newCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))[0];

  // Stop services that depend on config
  stopStreamProbe();
  stopNTP();
  stopAllPipelines();

  // Update config vars
  config = newCfg;
  IFACE = newCfg.IFACE;
  MCIFACE = newCfg.MCIFACE ? newCfg.MCIFACE : IFACE;
  SOURCEMULTICAST = newCfg.SOURCEMULTICAST;
  MCPORT = newCfg.MCPORT;
  STREAMSIZE = newCfg.STREAMSIZE;
  ENCODING = newCfg.ENCODING || 'L24';
  SAMPLERATE = newCfg.SAMPLERATE || 48000;
  SOURCEIP = newCfg.SOURCEIP || '';
  DOMAIN = newCfg.DOMAIN;
  TIMEZONE = newCfg.TIMEZONE;
  CHANNEL_INFO = (newCfg.CHANNEL_INFO || []).map((ch, i) => ({
    name: ch.name || `Channel ${i + 1}`,
    streamChannel: ch.streamChannel != null ? ch.streamChannel : i + 1
  }));
  DECODECHANNELS = CHANNEL_INFO.length;
  SHOWFRAMES = newCfg.SHOWFRAMES !== false;
  LEAPSECONDS = newCfg.LEAPSECONDS || 0;
  NTPSERVER = newCfg.NTPSERVER || '';
  CHANNEL_INFO = newCfg.CHANNEL_INFO;
  outputs = newCfg.OUTPUTS || [];
  clockOffsetMs = newCfg.CLOCKOFFSET || 0;

  // Rebuild decoders for new channel count / sample rate
  ltcDecoders.length = 0;
  for (let i = 0; i < DECODECHANNELS; i++) {
    ltcDecoders.push(new LTCDecoder(SAMPLERATE));
  }
  latestTC = Array(DECODECHANNELS).fill('--:--:--:--');
  pipelineStatus = Array(DECODECHANNELS).fill('waiting');
  lastTCUpdate = Array(DECODECHANNELS).fill(0);
  restartCount = Array(DECODECHANNELS).fill(0);

  // Restart services
  initPTP();
  startNTP();
  startStreamProbe();
  console.log('Config reloaded successfully');
}

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

app.get('/output-:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'combo.html'));
});

app.get('/ptp', (req, res) => {
  res.sendFile(path.join(__dirname, 'ptp.html'));
});
app.get('/api/ptp', (req, res) => {
  if (!ptpSynced) return res.json({ synced: false });
  let time = null;
  try { time = ptpv2.ptp_time(); } catch(e) {}
  if (!time) return res.json({ synced: false });
  const utcOffset = ptpv2.utc_offset() + LEAPSECONDS;
  const epochMs = (time[0] - utcOffset) * 1000 + Math.floor(time[1] / 1e6);
  res.json({ synced: true, master: ptpMasterID, epoch: epochMs });
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

app.get('/api/diag', (req, res) => {
  const interfaces = os.networkInterfaces();
  const nics = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4') {
        nics.push({ name, address: addr.address, internal: addr.internal });
      }
    }
  }
  let ptpSyncedNow = false, ptpMaster = null;
  try { ptpSyncedNow = ptpv2.is_synced(); ptpMaster = ptpSyncedNow ? ptpv2.ptp_master() : null; } catch(e) {}
  res.json({
    config: {
      IFACE: IFACE || '(empty — using OS default)',
      MCIFACE: MCIFACE || '(empty — using OS default)',
      SOURCEMULTICAST,
      SOURCEIP: SOURCEIP || '(empty — using ASM)',
      MCPORT,
      DOMAIN
    },
    network: {
      interfaces: nics,
      probeSocketOpen: !!probeSocket,
      streamActive,
      lastRtpPacketAgo: lastRtpPacket > 0 ? `${((Date.now() - lastRtpPacket) / 1000).toFixed(1)}s ago` : 'never'
    },
    ptp: { initialized: ptpInitialized, synced: ptpSyncedNow, master: ptpMaster },
    ntp: { synced: ntpSynced, server: NTPSERVER || null },
    hints: [
      !IFACE ? 'IFACE is empty — PTP and multicast may bind to the wrong interface. Set it to the IP of the media network NIC.' : null,
      !ptpInitialized ? 'PTP failed to initialize — check that IFACE is set and ports 319/320 are available.' : null,
      ptpInitialized && !ptpSyncedNow ? 'PTP initialized but not synced — check that PTP multicast (224.0.1.129) reaches this VM. On Proxmox, disable IGMP snooping on the bridge.' : null,
      !streamActive ? `No RTP packets received on ${SOURCEMULTICAST}:${MCPORT} — check that multicast traffic reaches this VM. On Proxmox, disable IGMP snooping on the bridge.` : null,
    ].filter(Boolean)
  });
});

app.get('/api/config', (req, res) => {
  const raw = fs.readFileSync(configPath, 'utf8');
  res.json(JSON.parse(raw)[0]);
});

app.post('/api/restart/:channel', (req, res) => {
  const ch = parseInt(req.params.channel) - 1;
  if (isNaN(ch) || ch < 0 || ch >= DECODECHANNELS) {
    return res.status(400).json({ ok: false, message: 'Invalid channel' });
  }
  ltcDecoders[ch].reset();
  restartCount[ch] = 0;
  pipelineStatus[ch] = streamActive ? 'decoding' : 'waiting';
  res.json({ ok: true, message: `Channel ${ch + 1} decoder reset` });
});

app.post('/api/restart', (req, res) => {
  for (let i = 0; i < DECODECHANNELS; i++) {
    ltcDecoders[i].reset();
    restartCount[i] = 0;
    pipelineStatus[i] = streamActive ? 'decoding' : 'waiting';
  }
  res.json({ ok: true, message: 'All decoders reset' });
});

app.get('/api/outputs', (req, res) => {
  res.json(outputs);
});

app.post('/api/outputs', (req, res) => {
  const newOutputs = req.body;
  if (!Array.isArray(newOutputs)) {
    return res.status(400).json({ ok: false, message: 'Expected array' });
  }
  outputs = newOutputs;

  // Persist to config.json
  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw);
  cfg[0].OUTPUTS = outputs;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4), 'utf8');
  res.json({ ok: true });
});

app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  fs.writeFileSync(configPath, JSON.stringify([newConfig], null, 4), 'utf8');
  reloadConfig();
  res.json({ ok: true, message: 'Config saved and applied' });
});

app.get('/api/status', (req, res) => {
  const now = Date.now();
  const channels = [];
  for (let i = 0; i < DECODECHANNELS; i++) {
    const active = lastTCUpdate[i] > 0 && (now - lastTCUpdate[i]) < 5000;
    channels.push({
      channel: i + 1,
      name: CHANNEL_INFO[i] ? CHANNEL_INFO[i].name : `Channel ${i + 1}`,
      streamChannel: CHANNEL_INFO[i] ? CHANNEL_INFO[i].streamChannel : i + 1,
      pipeline: pipelineStatus[i],
      tc: latestTC[i],
      receiving: active,
      restarts: restartCount[i],
      maxRestarts: MAX_RESTARTS
    });
  }
  let ptpSyncedNow = false;
  let ptpMaster = null;
  try { ptpSyncedNow = ptpv2.is_synced(); ptpMaster = ptpSyncedNow ? ptpv2.ptp_master() : null; } catch(e) {}
  res.json({
    stream: streamActive,
    ptp: { synced: ptpSyncedNow, master: ptpMaster },
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
          streamChannel: CHANNEL_INFO[i] ? CHANNEL_INFO[i].streamChannel : i + 1,
          pipeline: pipelineStatus[i],
          tc: latestTC[i],
          receiving: active,
          restarts: restartCount[i],
          maxRestarts: MAX_RESTARTS
        });
      }
      let ptpSyncedNow = false;
      let ptpMaster = null;
      try { ptpSyncedNow = ptpv2.is_synced(); ptpMaster = ptpSyncedNow ? ptpv2.ptp_master() : null; } catch(e) {}
      ws.send(JSON.stringify({
        stream: streamActive,
        ptp: { synced: ptpSyncedNow, master: ptpMaster },
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
      let synced = false, time = null, master = null;
      try { synced = ptpv2.is_synced(); time = synced ? ptpv2.ptp_time() : null; master = synced ? ptpv2.ptp_master() : null; } catch(e) {}
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

  // Helper: build clock data for a segment
  function buildClockData(seg) {
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
  }

  // Combo clock endpoint: URLs like /ptp+ntp, /ptp+channel-1, etc.
  const urlPath = decodeURIComponent(req.url).replace(/\s/g, '+').slice(1);
  const segments = urlPath.split('+');
  const validSeg = s => s === 'ptp' || s === 'ntp' || s === 'clock' || /^channel-\d+$/.test(s);
  if (segments.length >= 2 && segments.every(validSeg)) {
    console.log(`Combo WS connected: ${segments.join('+')}`);
    const interval = setInterval(() => {
      try {
        ws.send(JSON.stringify(segments.map(buildClockData)));
      } catch(e) {
        console.error('Combo WS error:', e.message);
      }
    }, 40);
    ws.on('close', () => clearInterval(interval));
    return;
  }

  // Output endpoint: /output-N — reads segments from outputs config
  const outputMatch = req.url.match(/^\/output-(\d+)$/);
  if (outputMatch) {
    const outputIdx = parseInt(outputMatch[1]) - 1;
    console.log(`Output WS connected: output-${outputIdx + 1}`);
    const interval = setInterval(() => {
      try {
        const output = outputs[outputIdx];
        if (!output || !output.segments || output.segments.length === 0) {
          ws.send(JSON.stringify([{ id: 'none', label: 'Not configured', time: '--:--:--', synced: null }]));
          return;
        }
        ws.send(JSON.stringify(output.segments.map(buildClockData)));
      } catch(e) {
        console.error('Output WS error:', e.message);
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