#!/usr/bin/env node
/*
 * emu-viewer.mjs - made emu 虚拟显示查看器
 *
 * 与固件侧 vibe_emu_display 组件配对：
 *   - 连接 esp-emu 的 --uart1-tcp 套接字
 *   - 接收 "EFRM" 区域帧（RGB565LE），合成 240x320 整帧
 *   - serve 模式：起 HTTP 服务，浏览器看实时画面，点击/拖动回传触摸
 *   - shot 模式：抓一帧存 PNG 后退出（对应旧 sim 的 --shot）
 *
 * 用法：
 *   node emu-viewer.mjs serve --emu 127.0.0.1:5556 --http 8080
 *   node emu-viewer.mjs shot  --emu 127.0.0.1:5556 --out shot.png [--wait 5000]
 */
import net from "node:net";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const W = 240, H = 320, HDR_LEN = 24, MAGIC = "EFRM";

/* ---------- 参数 ---------- */
function parseArgs(argv) {
  const args = { mode: argv[0] === "shot" ? "shot" : "serve" };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--emu") args.emu = argv[++i];
    else if (a === "--http") args.http = parseInt(argv[++i], 10);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--wait") args.wait = parseInt(argv[++i], 10);
  }
  args.emu = args.emu || "127.0.0.1:5556";
  args.http = args.http || 8080;
  args.out = args.out || "emu-shot.png";
  args.wait = args.wait || 5000;
  const [host, port] = args.emu.split(":");
  args.host = host;
  args.port = parseInt(port, 10);
  return args;
}

/* ---------- RGB565 -> PNG（RGB888） ---------- */
function crc32(buf) {
  return zlib.crc32 ? zlib.crc32(buf) : manualCrc32(buf);
}
const CRC_TABLE = (() => {
  if (zlib.crc32) return null;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function manualCrc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function rgb565ToPng(rgb565, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const v = rgb565.readUInt16LE((y * w + x) * 2);
      const r = ((v >> 11) & 0x1f) * 255 / 31 | 0;
      const g = ((v >> 5) & 0x3f) * 255 / 63 | 0;
      const b = (v & 0x1f) * 255 / 31 | 0;
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- 帧接收与合成 ---------- */
class FrameSink {
  constructor() {
    this.frame = Buffer.alloc(W * H * 2);
    this.seq = 0;      // 最新整帧序号（每次收到区域帧 +1）
    this.present = 0;  // 已落盘（PNG）计数
    this.haveFrame = false;
    this.header = null;
    this.headerGot = 0;
    this.payload = null;
    this.payloadGot = 0;
    this.onFrame = null;
  }
  push(buf) {
    let off = 0;
    while (off < buf.length) {
      if (!this.header) {
        const want = HDR_LEN - this.headerGot;
        const take = Math.min(want, buf.length - off);
        buf.copy(this.hdrBuf(), this.headerGot, off, off + take);
        this.headerGot += take;
        off += take;
        if (this.headerGot === HDR_LEN) {
          const h = this.header;
          if (h.toString("ascii", 0, 4) !== MAGIC) {
            this.header = null; this.headerGot = 0; continue; // 重新找 magic
          }
          const len = h.readUInt32LE(20);
          if (len === 0 || len > W * H * 2) {
            this.header = null; this.headerGot = 0; continue;
          }
          this.payload = Buffer.alloc(len);
          this.payloadGot = 0;
        }
        continue;
      }
      const len = this.header.readUInt32LE(20);
      const want = len - this.payloadGot;
      const take = Math.min(want, buf.length - off);
      buf.copy(this.payload, this.payloadGot, off, off + take);
      this.payloadGot += take;
      off += take;
      if (this.payloadGot === len) {
        this.blit();
        this.header = null;
        this.headerGot = 0;
        this.payload = null;
      }
    }
  }
  hdrBuf() {
    if (!this.header) this.header = Buffer.alloc(HDR_LEN);
    return this.header;
  }
  blit() {
    const h = this.header;
    const x1 = h.readUInt16LE(8), y1 = h.readUInt16LE(10);
    const x2 = h.readUInt16LE(12), y2 = h.readUInt16LE(14);
    const aw = x2 - x1 + 1;
    for (let row = 0; row <= y2 - y1; row++) {
      const src = row * aw * 2;
      const dst = ((y1 + row) * W + x1) * 2;
      this.payload.copy(this.frame, dst, src, src + aw * 2);
    }
    this.seq++;
    this.haveFrame = true;
    if (this.onFrame) this.onFrame();
  }
  png() {
    return rgb565ToPng(this.frame, W, H);
  }
}

/* ---------- TCP 连接（自动重连，触摸回传） ---------- */
class EmuLink {
  constructor(args, sink) {
    this.args = args;
    this.sink = sink;
    this.socket = null;
    this.connected = false;
    this.stopped = false;
  }
  start() {
    this.connect();
    this.retimer = setInterval(() => {
      if (!this.connected && !this.stopped) this.connect();
    }, 2000);
  }
  connect() {
    if (this.socket) { try { this.socket.destroy(); } catch {} this.socket = null; }
    const sock = net.connect(this.args.port, this.args.host);
    this.socket = sock;
    sock.on("connect", () => {
      this.connected = true;
      console.log(`[emu-link] connected ${this.args.host}:${this.args.port}`);
      // 请求全屏重绘，让新连接方立刻拿到完整画面
      setTimeout(() => {
        if (this.connected && this.socket) this.socket.write("F\n");
      }, 300);
    });
    sock.on("data", (d) => this.sink.push(d));
    sock.on("error", () => {});
    sock.on("close", () => {
      if (this.connected) console.log("[emu-link] disconnected");
      this.connected = false;
    });
  }
  sendTouch(action, x, y) {
    if (!this.connected || !this.socket) return false;
    let line;
    if (action === "down") line = `P ${x | 0} ${y | 0}\n`;
    else if (action === "move") line = `M ${x | 0} ${y | 0}\n`;
    else line = "R\n";
    this.socket.write(line);
    return true;
  }
}

/* ---------- serve 模式 ---------- */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>made emu</title>
<style>
 body{background:#111;color:#ddd;font:13px system-ui;display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px}
 canvas{border:1px solid #444;image-rendering:pixelated;cursor:crosshair}
 #st{color:#888}
</style></head><body>
<div>made emu viewer <span id="st">(connecting)</span></div>
<canvas id="c" width="240" height="320" style="width:360px;height:480px"></canvas>
<script>
const cv=document.getElementById('c'),ctx=cv.getContext('2d'),st=document.getElementById('st');
const scale=cv.getBoundingClientRect().width/240;
let bitmap=null,busy=false;
setInterval(async()=>{ if(busy)return; busy=true;
 try{
  const r=await fetch('/frame.png?'+Date.now());
  if(r.ok){ const b=await r.blob(); bitmap=await createImageBitmap(b);
    ctx.drawImage(bitmap,0,0); st.textContent='live'; }
  else st.textContent='(no frame)';
 }catch(e){ st.textContent='(server down)'; }
 busy=false;
},70);
function send(a,e){ const r=cv.getBoundingClientRect();
 const x=Math.max(0,Math.min(239,(e.clientX-r.left)/r.width*240|0));
 const y=Math.max(0,Math.min(319,(e.clientY-r.top)/r.height*320|0));
 fetch('/touch?action='+a+'&x='+x+'&y='+y,{method:'POST'}); }
cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);send('down',e)});
cv.addEventListener('pointermove',e=>{if(e.buttons)send('move',e)});
cv.addEventListener('pointerup',e=>send('up',e));
</script></body></html>`;

function serveMode(args, sink, link) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else if (url.pathname === "/frame.png") {
      if (!sink.haveFrame) {
        res.writeHead(503); res.end("no frame"); return;
      }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(sink.png());
    } else if (url.pathname === "/touch" && req.method === "POST") {
      const action = url.searchParams.get("action") || "up";
      const x = parseInt(url.searchParams.get("x") || "0", 10);
      const y = parseInt(url.searchParams.get("y") || "0", 10);
      const ok = link.sendTouch(action, x, y);
      res.writeHead(ok ? 200 : 503);
      res.end(ok ? "ok" : "emu not connected");
    } else {
      res.writeHead(404); res.end();
    }
  });
  server.listen(args.http, () => {
    console.log(`[viewer] http://localhost:${args.http}  (emu ${args.host}:${args.port})`);
  });
}

/* ---------- shot 模式 ---------- */
function shotMode(args, sink) {
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (sink.haveFrame) {
      clearInterval(timer);
      // 等 F 触发的全屏帧落全（300ms 发 F，再给合成留 700ms）
      setTimeout(() => {
        fs.writeFileSync(args.out, sink.png());
        console.log(`[shot] saved ${args.out} (seq=${sink.seq})`);
        process.exit(0);
      }, 1000);
    } else if (Date.now() - t0 > args.wait) {
      clearInterval(timer);
      console.error("[shot] timeout: no frame received");
      process.exit(1);
    }
  }, 50);
}

/* ---------- main ---------- */
const args = parseArgs(process.argv.slice(2));
const sink = new FrameSink();
const link = new EmuLink(args, sink);
link.start();
if (args.mode === "shot") shotMode(args, sink);
else serveMode(args, sink, link);
