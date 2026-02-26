# RTP LTC Reader

A Node.js application that extracts **LTC (Linear Timecode)** from **RTP multicast audio streams** and displays it in a real-time web interface.

It uses GStreamer to receive a 16-channel, 24-bit/48 kHz RTP audio multicast, deinterleave the channels, and decode LTC from each one. The decoded timecodes are pushed to a browser frontend over WebSocket at ~25 fps.

## Features

- Receives RTP multicast audio (L24, 48 kHz, 16 channels) via GStreamer
- Decodes LTC timecode from individual audio channels using `ltcdec`
- Real-time browser display via Express + WebSocket
- View any combination of channels: `/channel-1`, `/channel-3+7`, `/channel-1+2+3+4`, etc.
- Auto-restarts GStreamer pipelines on failure
- Configurable multicast address, port, network interface, and channel count

## Prerequisites

- [Node.js](https://nodejs.org/)
- [GStreamer](https://gstreamer.freedesktop.org/) 1.0 with the `ltcdec` element

## Install

```bash
npm install
sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-bad
```

## Configuration

Edit `config.json` to match your network setup:

```json
[
  {
    "MULTICAST": "239.255.0.1",
    "PORT": 5004,
    "IFACE": "192.168.1.2",
    "CHANNELS": 16
  }
]
```

| Key          | Description                                    |
|--------------|------------------------------------------------|
| `MULTICAST`  | Multicast group address to join                |
| `PORT`       | UDP port for the RTP stream                    |
| `IFACE`      | Local network interface IP to bind to          |
| `CHANNELS`   | Number of audio channels in the RTP stream     |

## Usage

```bash
node index.js
```

The server starts on **http://0.0.0.0:3000**. Open a browser and navigate to:

- `http://<host>:3000/channel-1` — show timecode from channel 1
- `http://<host>:3000/channel-1+2` — show channels 1 and 2 side by side
- `http://<host>:3000/channel-1+2+3+4` — show four channels in a grid

The display updates in real time with large monospaced timecodes on a black background.
