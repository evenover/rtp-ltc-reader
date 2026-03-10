# RTP LTC Reader

A Node.js application that extracts **LTC (Linear Timecode)** from **RTP multicast audio streams** and displays it in a real-time web interface.

It receives RTP multicast audio (L24 or L16), decodes LTC directly in Node.js using biphase mark decoding, and pushes the timecodes to a browser frontend over WebSocket at ~25 fps. It also supports PTP and NTP clock display.

## Features

- Receives RTP multicast audio (L24/L16) and decodes LTC entirely in Node.js — no external dependencies like GStreamer required
- Auto-calibrating biphase mark decoder with SMPTE 12M sync word detection
- Real-time browser display via Express + WebSocket
- View any combination of channels: `/channel-1`, `/channel-3+7`, `/channel-1+2+3+4`, etc.
- PTP (IEEE 1588) clock display at `/ptp`
- NTP clock display at `/ntp`
- Internal clock with manual offset at `/clock`
- Combo views: `/ptp+channel-1`, `/ntp+clock`, etc.
- Automatic stream detection and loss handling
- Configurable multicast address, port, network interface, encoding, and channel count
- Docker support

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)

## Install

```bash
npm install
```

## Configuration

Edit `config.json` to match your network setup:

```json
[
  {
    "IFACE": "10.151.5.226",
    "PORT": 5000,
    "MCIFACE": "10.151.5.226",
    "SOURCEMULTICAST": "239.254.151.1",
    "MCPORT": 5004,
    "STREAMSIZE": 2,
    "ENCODING": "L24",
    "SAMPLERATE": 48000,
    "SOURCEIP": "10.151.5.220",
    "TIMEZONE": "Europe/Oslo",
    "DOMAIN": 84,
    "LEAPSECONDS": 1,
    "NTPSERVER": "ntp.justervesenet.no",
    "DECODECHANNELS": 1,
    "SHOWFRAMES": true,
    "CHANNEL_INFO": [
      { "name": "Program LTC" }
    ]
  }
]
```

| Key               | Description                                                       |
|-------------------|-------------------------------------------------------------------|
| `IFACE`           | Local network interface IP (used for PTP)                         |
| `PORT`            | HTTP server port                                                  |
| `MCIFACE`         | Network interface IP for multicast join (leave empty for default) |
| `SOURCEMULTICAST` | Multicast group address to join                                   |
| `MCPORT`          | UDP port for the RTP stream                                       |
| `STREAMSIZE`      | Number of audio channels in the RTP stream                        |
| `ENCODING`        | Audio encoding: `L24` or `L16`                                    |
| `SAMPLERATE`      | Audio sample rate in Hz                                           |
| `SOURCEIP`        | Source IP of the RTP sender (informational)                       |
| `TIMEZONE`        | IANA timezone for clock display                                   |
| `DOMAIN`          | PTP domain number                                                 |
| `LEAPSECONDS`     | Leap seconds offset for PTP                                       |
| `NTPSERVER`       | NTP server hostname (leave empty to disable)                      |
| `DECODECHANNELS`  | Number of channels to decode LTC from (starting from channel 1)   |
| `SHOWFRAMES`      | Show frame numbers in timecode display                            |
| `CHANNEL_INFO`    | Array of `{ "name": "..." }` objects used as display labels       |

## Usage

```bash
node index.js
```

The server starts on `http://localhost:<PORT>` (default 5000). Open a browser and navigate to:

- `/channel-1` — show timecode from channel 1
- `/channel-1+2` — show channels 1 and 2 side by side
- `/ptp` — PTP clock display
- `/ntp` — NTP clock display
- `/clock` — internal clock with manual offset
- `/ptp+channel-1` — combo view

The display updates in real time with large monospaced timecodes on a black background.

## Docker

```bash
docker build -t rtp-ltc-reader .
docker run --net=host rtp-ltc-reader
```
