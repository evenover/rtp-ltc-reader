const express = require('express');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const config = require('./config.json')[0];

const MULTICAST = config.MULTICAST;
const PORT = config.PORT;
const IFACE = config.IFACE;
const CHANNELS = config.CHANNELS;
const CHANNEL_INFO = config.CHANNEL_INFO;

const app = express();
const server = app.listen(3000, () =>
  console.log("Server på http://0.0.0.0:3000")
);

const wss = new WebSocket.Server({ server });

let latestTC = Array(CHANNELS).fill("--:--:--:--");

function startPipeline(channelIndex) {
  const args = [
    'udpsrc',
    `address=${MULTICAST}`,
    `port=${PORT}`,
    `multicast-iface=${IFACE}`,
    'auto-multicast=true',
    'caps=application/x-rtp,media=audio,clock-rate=48000,encoding-name=L24,channels=16',
    '!',
    'rtpL24depay',
    '!',
    'audioconvert',
    '!',
    'audio/x-raw,format=S16LE,channels=16',
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

  gst.stderr.on('data', data => {
    const text = data.toString();
    const match = text.match(/(\d\d:\d\d:\d\d:\d\d)/);
    if (match) {
      latestTC[channelIndex] = match[1];
    }
  });

  gst.on('exit', () => {
    console.log(`Pipeline ${channelIndex+1} restartes`);
    setTimeout(() => startPipeline(channelIndex), 1000);
  });
}

// Start alle pipelines
for (let i = 0; i < CHANNELS; i++) {
  startPipeline(i);
}

app.get('/channel-:ids', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

wss.on('connection', (ws, req) => {
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