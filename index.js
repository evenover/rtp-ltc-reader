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
const CHANNEL_INFO = config.CHANNEL_INFO;

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

// Initialize PTP sync
try {
  ptpv2.init(IFACE, DOMAIN, () => {
    ptpSynced = true;
    ptpMasterID = ptpv2.ptp_master();
    console.log(`PTP synced to master: ${ptpMasterID}`);
  });
} catch (e) {
  console.error(`PTP init failed: ${e.message}`);
}

process.on('uncaughtException', (err) => {
  if (err.syscall === 'addMembership') {
    console.error(`PTP multicast join failed (${IFACE}): ${err.message}`);
  } else {
    throw err;
  }
});

function startPipeline(channelIndex) {
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

// Start alle pipelines
for (let i = 0; i < DECODECHANNELS; i++) {
  startPipeline(i);
}

app.get('/channel-:ids', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ptp', (req, res) => {
  res.sendFile(path.join(__dirname, 'ptp.html'));
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
    ptp: {
      synced: ptpv2.is_synced(),
      master: ptpv2.is_synced() ? ptpv2.ptp_master() : null
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
        ptp: {
          synced: ptpv2.is_synced(),
          master: ptpv2.is_synced() ? ptpv2.ptp_master() : null
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
        const d = new Date(time[0] * 1000 + Math.floor(time[1] / 1e6));
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
        seconds: time ? time[0] : null,
        nanoseconds: time ? time[1] : null
      }));
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
    .filter(n => n >= 0 && n < CHANNELS);

  const interval = setInterval(() => {
  const payload = channels.map(ch => ({
    channel: ch + 1,
    name: CHANNEL_INFO[ch].name,
    tc: latestTC[ch]
  }));
  ws.send(JSON.stringify(payload));
}, 40);

  ws.on('close', () => clearInterval(interval));
});