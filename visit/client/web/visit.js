// visit.js: the Visit library (../../SPEC.md section 9; ../../INTEGRATING.md shows it in use). Served by
// visit-client at /visit.js, so a page always runs the library its visit-client speaks. It talks only to
// that visit-client, on 127.0.0.1: it keeps the lobby's state, calls a host's hooks (spawn, move, render),
// encodes what they render and decodes what a host sends (WebCodecs), and captures a visitor's input.
//
//   const v = await Visit.connect({ port, token, sim: { name, version } });
//   v.host({ spawn, move, render, fps });   v.view(element);   Visit.panel(element, v);
"use strict";
(function () {
  const VERSION = "0.2.0", PROTO = "basedverse-visit-local/1";
  const CODECS = ["avc1.42E01F", "vp8", "vp09.00.10.08"];   // the order a host prefers, among what a visitor decodes
  const MOVE_MS = 1000 / 30, INPUT_MS = 1000 / 30, STALE_MS = 300, KEY_EVERY_MS = 2000, LOOK = 0.0025;
  // What the host hears many times a second: none of it changes what the page shows, so none fires "change".
  const QUIET = new Set(["input", "bitrate", "keyframe", "decoders", "viewport", "video_config"]);
  // A timer from a Worker: a page's own timers slow to once a second (or less) while its tab is in the
  // background, and a host must go on rendering for its visitors.
  function ticker(ms, fn) {
    try {
      const w = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: "text/javascript" })));
      w.onmessage = fn;
      return { stop: () => w.terminate() };
    } catch (e) {   // workers forbidden (a strict CSP): the page's own timer, slow in the background
      const t = setInterval(fn, ms);
      return { stop: () => clearInterval(t) };
    }
  }
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const even = n => Math.max(2, Math.floor(n / 2) * 2);

  // The size to encode a visitor's view at: its own, scaled down to fit the limits, in even numbers.
  function fit(width, height, maxW, maxH) {
    if (!(width > 0 && height > 0)) return [maxW, maxH];
    const k = Math.min(1, maxW / width, maxH / height);
    return [even(width * k), even(height * k)];
  }

  class Client {
    constructor(port, token, sim) {
      Object.assign(this, { port, token, sim });
      this.state = "connecting";   // then "online", "offline" (the lobby out of reach), or "away" (left on purpose)
      this.office = null;
      this.status = "available";
      this.maxVisitors = 3;
      this.offices = [];
      this.knocks = [];        // on your door: { id, from, message, until }
      this.knocking = [];      // yours, waiting: { id, to }
      this.visiting = null;    // { id, host, paused }
      this.visitors = [];      // { id, visitor, pose }
      this._on = {};
      this._hosted = new Map();   // channel -> a visit to this office
      this._hooks = null;
      this._limits = { max_width: 1280, max_height: 720, fps: 30 };
      this._decoders = null;
      this._viewer = null;        // the visit this office is on: { channel, decoder, waitKey, config }
      this._view = null;          // where it is shown: { element, canvas, ... }
      this._closed = false;
      this._fails = 0;
      this._loop = ticker(MOVE_MS, () => this._tick());
    }

    // ---------- events ----------
    on(event, fn) { (this._on[event] = this._on[event] || []).push(fn); return this; }
    off(event, fn) { this._on[event] = (this._on[event] || []).filter(f => f !== fn); return this; }
    _emit(event, arg) { for (const fn of this._on[event] || []) { try { fn(arg); } catch (e) { console.error("visit: a", event, "handler threw", e); } } }
    _changed() { this._emit("change", this); }

    // ---------- the connection ----------
    // `token` is the token, or a function giving it (fresh each time: a visit-client restarted with a new
    // one is then found again by itself).
    async _open() {
      const token = typeof this.token === "function" ? await this.token() : this.token;
      return new Promise((resolve, reject) => {
        const ws = this._ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
        ws.binaryType = "arraybuffer";
        let ready = false;
        ws.onopen = () => ws.send(JSON.stringify({ type: "hello", proto: PROTO, token, sim: this.sim }));
        ws.onmessage = e => {
          if (typeof e.data !== "string") return this._frame(e.data);
          let m;
          try { m = JSON.parse(e.data); } catch (err) { return; }
          if (m.type === "ready" && !ready) { ready = true; this._fails = 0; this._ready(m); resolve(); return; }
          this._message(m);
          if (!QUIET.has(m.type)) this._changed();
        };
        ws.onclose = e => {
          if (ws !== this._ws) return;
          this._dropAll();
          if (!ready) {
            const err = new Error(e.code === 4401 ? "visit-client refused the token" : `visit-client is not running on 127.0.0.1:${this.port}, or refused this page`);
            err.code = e.code;
            return reject(err);
          }
          this.state = "offline";
          this._changed();
          if (this._closed || e.code === 4409) {
            return this._emit("error", { code: "closed", message: e.code === 4409 ? "visit-client: another page of this workroom took over" : "visit-client: closed" });
          }
          setTimeout(() => this._reopen(), 2000);   // visit-client restarting: try again
        };
      });
    }
    // Again every 2 s while visit-client is away. A wrong token is final unless `token` is a function (then
    // a few more tries, each with what it gives): a stale token tried forever only keeps failing.
    _reopen() {
      if (this._closed) return;
      this._open().catch(e => {
        if (e.code === 4401 && (typeof this.token !== "function" || ++this._fails >= 3)) {
          return this._emit("error", { code: "token", message: "visit-client refused the token: reload the page" });
        }
        setTimeout(() => this._reopen(), 2000);
      });
    }
    _send(m) { if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(m)); }
    close() { this._closed = true; this._loop.stop(); this._dropAll(); if (this._ws) this._ws.close(); }

    _ready(m) {
      this.state = m.away ? "away" : m.online ? "online" : "offline";
      this.office = m.office && m.office.id ? m.office : null;
      this.status = m.status; this.maxVisitors = m.max_visitors;
      this._limits = m.limits || this._limits;
      this.knocks = []; this.knocking = [];
      for (const v of m.visits || []) this._started(v);
      this._sendDecoders();
      this._changed();
    }

    async _sendDecoders() {
      if (!this._decoders) {
        const ok = await Promise.all(CODECS.map(codec => typeof VideoDecoder === "undefined" ? null
          : VideoDecoder.isConfigSupported({ codec }).then(r => r.supported ? codec : null, () => null)));
        this._decoders = ok.filter(Boolean);
      }
      this._send({ type: "decoders", codecs: this._decoders });
    }

    _message(m) {
      switch (m.type) {
        case "online":   // (again, after a drop): its own knocks still waiting are these
          this.state = "online"; this.office = m.office;
          if (Array.isArray(m.knocking)) this.knocking = m.knocking.map(k => ({ id: k.id, to: k.to }));
          break;
        case "offline":   // away: this office left the lobby on purpose, and sees nobody until it joins again
          this.state = m.away ? "away" : "offline";
          if (m.away) { this.offices = []; this.knocks = []; this.knocking = []; }
          break;
        case "lobby":
          this.offices = (m.offices || []).map(o => ({ id: String(o.id), name: String(o.name), status: String(o.status), sim: o.sim || {},
            maxVisitors: Number(o.max_visitors) || 0, visitors: Number(o.visitors) || 0, visiting: o.visiting || null, ready: o.ready === true }));
          { const me = this.offices.find(o => this.office && o.id === this.office.id); if (me) { this.status = me.status; this.maxVisitors = me.maxVisitors; } }
          break;
        case "knock":
          this.knocks = this.knocks.filter(k => k.id !== m.id).concat([{ id: m.id, from: m.from, message: m.message || "", until: Date.now() + 1000 * (m.expires_in || 60) }]);
          this._emit("knock", this.knocks[this.knocks.length - 1]);
          break;
        case "knock_cancelled": this.knocks = this.knocks.filter(k => k.id !== m.id); break;
        case "knock_sent": this.knocking = this.knocking.concat([{ id: m.id, to: m.to }]); break;
        case "answered": {
          const k = this.knocking.find(x => x.id === m.knock);
          this.knocking = this.knocking.filter(x => x.id !== m.knock);
          this._emit("answered", { to: k && k.to, accept: m.accept, reason: m.reason, message: m.message || "" });
          break;
        }
        case "visit_started": this._started(m); break;
        case "visit_ended": this._ended(m); break;
        case "host_paused": case "host_resumed":
          if (this.visiting && this._viewer && this._viewer.channel === m.channel) { this.visiting.paused = m.type === "host_paused"; this._overlay(); }
          break;
        case "video_config": this._configureDecoder(m); break;
        case "decoders": case "viewport": case "keyframe": case "bitrate": case "input": this._hostMessage(m); break;
        case "error": this._emit("error", { code: m.code, message: m.message, ref: m.ref }); break;
      }
    }

    // ---------- actions ----------
    setStatus(status) { this._send({ type: "status", status }); }
    setMaxVisitors(n) { this._send({ type: "max_visitors", n }); }
    rename(name) { this._send({ type: "rename", name }); }
    knock(officeId, message = "") { this._send({ type: "knock", to: officeId, message }); }
    answer(knockId, accept, message = "") { this.knocks = this.knocks.filter(k => k.id !== knockId); this._send({ type: "answer", knock: knockId, accept, message }); this._changed(); }
    leave() { if (this.visiting) this._send({ type: "end", visit: this.visiting.id }); }
    // Out of the lobby (nobody sees this office or can knock; its visits end) and back. visit-client keeps
    // it out across its restarts when it has a state file (VISIT_STATE_FILE).
    leaveLobby() { this._send({ type: "leave_lobby" }); }
    joinLobby() { this._send({ type: "join_lobby" }); }
    kick(visitId) { this._send({ type: "end", visit: visitId }); }

    // ---------- visits ----------
    _started(m) {
      if (m.role === "host") {
        const h = { id: m.id, channel: m.channel, visitor: m.peer || {}, pose: null, yaw0: 0, input: null, inputAt: 0,
          decoders: null, viewport: null, encoder: null, codec: null, width: 0, height: 0, bps: 1500000, fps: this._fps(),
          keyNext: true, lastKey: 0, nextAt: 0, fails: 0, configuring: false, scratch: null, since: performance.now() };
        if (m.state && m.state.pose) { h.pose = m.state.pose; h.yaw0 = m.state.yaw0 || 0; }   // back after this page reloaded
        this._hosted.set(m.channel, h);
        this._spawn(h);
      } else {
        this.visiting = { id: m.id, host: m.peer || {}, paused: false };
        this._viewer = { channel: m.channel, decoder: null, waitKey: true, config: null };
        this._sendViewport();
      }
      this._visitorsList();
      this._emit("visit_started", { id: m.id, role: m.role, peer: m.peer });
    }

    _ended(m) {
      const h = this._hosted.get(m.channel);
      if (h && h.id === m.id) { this._dropHosted(h); this._hosted.delete(m.channel); }
      if (this.visiting && this.visiting.id === m.id) { this._dropViewer(); this.visiting = null; }
      this._visitorsList();
      this._emit("visit_ended", { id: m.id, reason: m.reason });
    }

    _dropAll() {
      for (const h of this._hosted.values()) this._dropHosted(h);
      this._hosted.clear();
      this._dropViewer();
      this.visiting = null;
      this._visitorsList();
    }

    _visitorsList() { this.visitors = [...this._hosted.values()].map(h => ({ id: h.id, visitor: h.visitor, pose: h.pose })); }

    // ---------- hosting ----------
    host(hooks) {
      if (!hooks || typeof hooks.spawn !== "function" || typeof hooks.move !== "function" || typeof hooks.render !== "function") {
        throw new Error("visit.host needs spawn, move and render functions");
      }
      this._hooks = hooks;
      for (const h of this._hosted.values()) { h.fps = this._fps(); this._spawn(h); }
    }
    _fps() { return Math.max(10, Math.min(this._limits.fps || 30, (this._hooks && this._hooks.fps) || 30)); }

    _spawn(h) {
      if (!this._hooks || h.pose) return;
      try { h.pose = Object.assign({}, this._hooks.spawn(h.visitor)); h.yaw0 = h.pose.yaw || 0; }
      catch (e) { console.error("visit: spawn threw", e); }
    }

    _hostMessage(m) {
      const h = this._hosted.get(m.channel);
      if (!h) return;
      if (m.type === "input") { h.input = m; h.inputAt = performance.now(); }
      else if (m.type === "keyframe") h.keyNext = true;
      else if (m.type === "decoders") { h.decoders = m.codecs || []; this._configureEncoder(h); }
      else if (m.type === "viewport") { h.viewport = [m.width, m.height]; this._configureEncoder(h); }
      else if (m.type === "bitrate" && h.encoder && Math.abs(m.bps - h.bps) / h.bps > 0.15) {
        h.bps = m.bps;
        try { h.encoder.configure(this._encoderConfig(h)); } catch (e) { console.warn("visit: bitrate change refused", e); }
      }
    }

    _encoderConfig(h) {
      return Object.assign({ codec: h.codec, width: h.width, height: h.height, bitrate: h.bps, framerate: h.fps, latencyMode: "realtime" },
        h.codec.startsWith("avc1") ? { avc: { format: "annexb" } } : {});
    }

    // A codec this visitor decodes and this page encodes, at the visitor's view size; then its settings
    // to the visitor, and a keyframe first.
    async _configureEncoder(h) {
      if (typeof VideoEncoder === "undefined") return;
      if (h.configuring) { h.again = true; return; }   // new settings arrived meanwhile: once this is done, again
      h.configuring = true;
      try {
        const [width, height] = fit(...(h.viewport || [0, 0]), this._limits.max_width, this._limits.max_height);
        const wanted = (h.decoders && h.decoders.length ? h.decoders : ["vp8"]).filter(c => CODECS.includes(c));
        let codec = null;
        for (const c of wanted) {
          const probe = { codec: c, width, height, bitrate: h.bps, framerate: h.fps, latencyMode: "realtime" };
          if (c.startsWith("avc1")) probe.avc = { format: "annexb" };
          try { if ((await VideoEncoder.isConfigSupported(probe)).supported) { codec = c; break; } } catch (e) { /* next */ }
        }
        if (this._hosted.get(h.channel) !== h) return;   // the visit ended meanwhile
        if (!codec) return console.warn("visit: no codec both sides support for", h.visitor.name);
        if (h.encoder && h.codec === codec && h.width === width && h.height === height) return;
        if (h.encoder) { try { h.encoder.close(); } catch (e) { /* already closed */ } }
        Object.assign(h, { codec, width, height });
        h.encoder = new VideoEncoder({
          output: chunk => this._sendChunk(h, chunk),
          error: e => {
            console.warn("visit: encoder error", e);
            h.encoder = null; h.codec = null;
            setTimeout(() => { if (this._hosted.get(h.channel) === h) this._configureEncoder(h); }, 500);
          },
        });
        h.encoder.configure(this._encoderConfig(h));
        h.keyNext = true;
        this._send({ type: "video_config", channel: h.channel, codec, width, height });
      } finally {
        h.configuring = false;
        if (h.again && this._hosted.get(h.channel) === h) { h.again = false; this._configureEncoder(h); }
      }
    }

    _sendChunk(h, chunk) {
      if (!this._ws || this._ws.readyState !== 1) return;
      const buf = new ArrayBuffer(11 + chunk.byteLength), dv = new DataView(buf);
      dv.setUint16(0, h.channel);
      dv.setUint8(2, chunk.type === "key" ? 1 : 0);
      dv.setBigUint64(3, BigInt(Math.max(0, Math.round(chunk.timestamp))));
      chunk.copyTo(new Uint8Array(buf, 11));
      this._ws.send(buf);
    }

    _dropHosted(h) { if (h.encoder) { try { h.encoder.close(); } catch (e) { /* closed */ } h.encoder = null; } }

    // Moves every visitor 30 times a second; renders each at its frame rate, lowering it while rendering
    // takes more than a quarter of the page's time, raising it when it fits again.
    _tick() {
      const now = performance.now();
      if (this._view) this._sendInput(now);
      if (!this._hooks || !this._hosted.size) return;
      this._busy = this._busy || { since: now, spent: 0 };
      for (const h of [...this._hosted.values()]) {
        if (!h.pose) { this._spawn(h); if (!h.pose) continue; }
        const dt = Math.min(0.25, (now - (h.movedAt || now)) / 1000);
        h.movedAt = now;
        const fresh = h.input && now - h.inputAt < STALE_MS;
        const input = fresh ? h.input : { forward: 0, strafe: 0, run: false, yaw: h.input ? h.input.yaw : 0, pitch: h.input ? h.input.pitch : 0 };
        try {
          const turned = Object.assign({}, h.pose, { yaw: h.yaw0 + (input.yaw || 0), pitch: input.pitch || 0 });
          h.pose = Object.assign({}, this._hooks.move(turned, input, dt) || turned);
          h.fails = 0;
        } catch (e) { this._hookFailed(h, "move", e); continue; }
        if (now - (h.keptAt || 0) >= 200) {   // where the visitor stands, kept by visit-client for a reload of this page
          h.keptAt = now;
          this._send({ type: "pose", channel: h.channel, state: { pose: h.pose, yaw0: h.yaw0 } });
        }
        if (h.encoder && h.encoder.state === "configured" && now >= h.nextAt) {
          h.nextAt = now + 1000 / h.fps;
          this._renderFor(h, now);
        }
      }
      this._visitorsList();
      if (now - this._busy.since >= 1000) {
        const share = this._busy.spent / (now - this._busy.since);
        for (const h of this._hosted.values()) {
          h.fps = share > 0.25 ? Math.max(10, Math.round(h.fps * 0.8)) : share < 0.15 ? Math.min(this._fps(), h.fps + 2) : h.fps;
        }
        this._busy = { since: now, spent: 0 };
      }
    }

    _renderFor(h, now) {
      if (h.encoder.encodeQueueSize > 2) return;                                       // the encoder is behind: skip
      if (this._ws.bufferedAmount > 2e6) { h.keyNext = true; return; }                  // the connection is behind: skip, and start clean
      const t0 = performance.now();
      let canvas;
      try { canvas = this._hooks.render(h.pose, h.width, h.height); h.fails = 0; }
      catch (e) { return this._hookFailed(h, "render", e); }
      if (!canvas) return;
      if (canvas.width !== h.width || canvas.height !== h.height) {   // not the size asked: scaled to it
        h.scratch = h.scratch && h.scratch.width === h.width && h.scratch.height === h.height ? h.scratch : new OffscreenCanvas(h.width, h.height);
        h.scratch.getContext("2d").drawImage(canvas, 0, 0, h.width, h.height);
        canvas = h.scratch;
      }
      const key = h.keyNext || now - h.lastKey > KEY_EVERY_MS;
      let frame;
      try {
        frame = new VideoFrame(canvas, { timestamp: Math.round(now * 1000) });
        h.encoder.encode(frame, { keyFrame: key });
        if (key) { h.keyNext = false; h.lastKey = now; }
      } catch (e) { console.warn("visit: could not encode a frame", e); }
      finally { if (frame) frame.close(); }
      this._busy.spent += performance.now() - t0;
    }

    _hookFailed(h, hook, e) {
      console.error(`visit: ${hook} threw, for ${h.visitor.name}`, e);
      if (++h.fails >= 3) this.kick(h.id);
    }

    // ---------- visiting ----------
    view(element) {
      if (this._view) this._view.release();
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "display:block;width:100%;height:100%;background:#000;cursor:pointer;outline:none";
      canvas.tabIndex = 0;
      element.appendChild(canvas);
      const view = { element, canvas, ctx: canvas.getContext("2d"), keys: new Set(), yaw: 0, pitch: 0, sentAt: 0, resizeAt: 0 };
      const ignore = e => e.ctrlKey || e.metaKey || e.altKey || (e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)));
      const KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"];
      const down = e => { if (!this.visiting || ignore(e) || !KEYS.includes(e.code)) return; view.keys.add(e.code); e.preventDefault(); };
      const up = e => { view.keys.delete(e.code); };
      const blur = () => view.keys.clear();
      const click = () => { if (canvas.requestPointerLock) canvas.requestPointerLock(); };
      const look = e => {
        if (document.pointerLockElement !== canvas) return;
        view.yaw -= e.movementX * LOOK;
        view.pitch = Math.max(-1.4, Math.min(1.4, view.pitch - e.movementY * LOOK));
      };
      addEventListener("keydown", down); addEventListener("keyup", up); addEventListener("blur", blur);
      canvas.addEventListener("click", click); document.addEventListener("mousemove", look);
      const resize = new ResizeObserver(() => { view.resizeAt = performance.now() + 250; });
      resize.observe(element);
      view.release = () => {
        removeEventListener("keydown", down); removeEventListener("keyup", up); removeEventListener("blur", blur);
        canvas.removeEventListener("click", click); document.removeEventListener("mousemove", look);
        resize.disconnect();
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        canvas.remove();
        if (this._view === view) this._view = null;
      };
      this._view = view;
      this._sizeView();
      if (this._viewer) { this._viewer.waitKey = true; this._send({ type: "keyframe", channel: this._viewer.channel }); }
      return { release: () => view.release(), canvas };
    }

    _sizeView() {
      const v = this._view;
      if (!v) return;
      const r = v.element.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      v.canvas.width = Math.max(2, Math.round(r.width * dpr)); v.canvas.height = Math.max(2, Math.round(r.height * dpr));
      v.resizeAt = 0;
      this._sendViewport();
    }
    _sendViewport() { if (this._view && this.visiting) this._send({ type: "viewport", width: this._view.canvas.width, height: this._view.canvas.height }); }

    _sendInput(now) {
      const v = this._view;
      if (v.resizeAt && now >= v.resizeAt) this._sizeView();
      if (!this.visiting || now - v.sentAt < INPUT_MS) return;
      v.sentAt = now;
      const k = c => v.keys.has(c);
      this._send({ type: "input", forward: (k("KeyW") || k("ArrowUp") ? 1 : 0) - (k("KeyS") || k("ArrowDown") ? 1 : 0),
        strafe: (k("KeyD") || k("ArrowRight") ? 1 : 0) - (k("KeyA") || k("ArrowLeft") ? 1 : 0),
        run: k("ShiftLeft") || k("ShiftRight"), yaw: v.yaw, pitch: v.pitch });
    }

    _configureDecoder(m) {
      const w = this._viewer;
      if (!w || w.channel !== m.channel || typeof VideoDecoder === "undefined") return;
      const same = w.config && w.config.codec === m.codec && w.config.codedWidth === m.width && w.config.codedHeight === m.height;
      if (same && w.decoder && w.decoder.state === "configured") return;   // told again: nothing to change
      if (w.decoder) { try { w.decoder.close(); } catch (e) { /* closed */ } }
      w.config = { codec: m.codec, codedWidth: m.width, codedHeight: m.height, optimizeForLatency: true };
      w.decoder = new VideoDecoder({
        output: f => this._draw(f),
        error: e => { console.warn("visit: decoder error", e); this._configureDecoder(m); this._send({ type: "keyframe", channel: m.channel }); },
      });
      w.decoder.configure(w.config);
      w.waitKey = true;
    }

    _frame(buf) {
      const w = this._viewer;
      if (!w || buf.byteLength < 11) return;
      const dv = new DataView(buf), channel = dv.getUint16(0), key = (dv.getUint8(2) & 1) === 1;
      if (channel !== w.channel || !w.decoder || w.decoder.state !== "configured") return;
      if (w.waitKey && !key) return;
      if (w.decoder.decodeQueueSize > 6) { w.waitKey = true; return this._send({ type: "keyframe", channel }); }
      w.waitKey = false;
      try { w.decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: Number(dv.getBigUint64(3)), data: new Uint8Array(buf, 11) })); }
      catch (e) { w.waitKey = true; this._send({ type: "keyframe", channel }); }
    }

    _draw(frame) {
      const v = this._view;
      if (v) {
        const { canvas, ctx } = v, k = Math.min(canvas.width / frame.displayWidth, canvas.height / frame.displayHeight);
        const dw = frame.displayWidth * k, dh = frame.displayHeight * k;
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(frame, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
        if (this.visiting && this.visiting.paused) this._overlay();
      }
      frame.close();
      this.frames = (this.frames || 0) + 1;
    }

    // The host's page is reloading: its room holds its last frame, and says so.
    _overlay() {
      const v = this._view;
      if (!v || !this.visiting || !this.visiting.paused) return;
      const { canvas, ctx } = v, s = Math.max(14, Math.round(canvas.height / 30));
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(0, canvas.height / 2 - s, canvas.width, s * 2);
      ctx.fillStyle = "#fff"; ctx.font = `${s}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(`${this.visiting.host.name || "The host"}'s room is reloading…`, canvas.width / 2, canvas.height / 2);
    }

    _dropViewer() {
      const w = this._viewer;
      if (w && w.decoder) { try { w.decoder.close(); } catch (e) { /* closed */ } }
      this._viewer = null;
      if (this._view) {
        const { canvas, ctx } = this._view;
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      }
    }
  }

  // First-person walking for a host's move(): forward and strafe in the direction it looks, at `speed`
  // units a second (twice that running), sliding along whatever `blocked(x, z)` says is in the way.
  // Pose: { x, y, z, yaw, pitch }, y up, yaw 0 looking toward -z, positive turning left.
  function walk(pose, input, dt, { speed = 2.5, blocked = null } = {}) {
    const f = input.forward || 0, r = input.strafe || 0;
    if (!f && !r) return pose;
    const sin = Math.sin(pose.yaw || 0), cos = Math.cos(pose.yaw || 0);
    let dx = -sin * f + cos * r, dz = -cos * f - sin * r;
    const len = Math.hypot(dx, dz), step = speed * (input.run ? 2 : 1) * dt;
    dx = dx / len * step; dz = dz / len * step;
    const ok = (x, z) => !blocked || !blocked(x, z);
    if (ok(pose.x + dx, pose.z + dz)) return Object.assign({}, pose, { x: pose.x + dx, z: pose.z + dz });
    if (ok(pose.x + dx, pose.z)) return Object.assign({}, pose, { x: pose.x + dx });
    if (ok(pose.x, pose.z + dz)) return Object.assign({}, pose, { z: pose.z + dz });
    return pose;
  }

  // ---------- the ready-made lobby panel ----------
  const PANEL_CSS = `
.visit-panel { font: 12px/1.4 ui-monospace, Consolas, monospace; color: #e6edf3; background: #161b22; border: 1px solid #2d333b; border-radius: 10px; overflow: auto; min-width: 260px; }
.visit-panel .row { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-top: 1px solid #2d333b; }
.visit-panel .row:first-child { border-top: 0; }
.visit-panel .hd { font-weight: 700; } .visit-panel .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.visit-panel .muted { color: #8b949e; } .visit-panel .dot { width: 8px; height: 8px; border-radius: 50%; background: #6e7681; flex: none; }
.visit-panel .dot.available { background: #3fb950; } .visit-panel .dot.busy { background: #e3b341; }
.visit-panel button, .visit-panel select, .visit-panel input { font: inherit; color: inherit; background: #0d1117; border: 1px solid #2d333b; border-radius: 6px; padding: 2px 8px; }
.visit-panel button { cursor: pointer; } .visit-panel button:disabled { opacity: .45; cursor: default; }
.visit-panel button.go { background: #2f9e4f; border-color: #2f9e4f; color: #fff; }
.visit-panel .knock { display: block; background: #fff0d6; color: #7a4a00; } .visit-panel .knock .btns { display: flex; gap: 6px; margin-top: 4px; }
.visit-panel input { flex: 1; min-width: 0; }`;

  function panel(element, v) {
    if (!document.getElementById("visit-panel-css")) {
      const st = document.createElement("style"); st.id = "visit-panel-css"; st.textContent = PANEL_CSS; document.head.appendChild(st);
    }
    const root = document.createElement("div");
    root.className = "visit-panel";
    element.appendChild(root);
    let composing = null, timer = null, drawn = "";
    const knockable = o => o.ready && o.status === "available" && (!v.office || o.id !== v.office.id) && o.visitors < o.maxVisitors
      && !(v.visiting && v.visiting.host.id === o.id) && !v.knocking.some(k => k.to === o.id);
    function draw() {
      if (root.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // never under a typing hand
      const me = v.office, rows = [];
      rows.push(`<div class="row hd"><span class="dot ${v.state === "online" ? esc(v.status) : ""}"></span><span class="grow">Visit${me ? " · " + esc(me.name) : ""}</span><span class="muted">${esc(v.state)}</span>${v.state === "online" ? `<button data-v="away" title="leave the lobby: nobody sees you or can knock until you come back">Go offline</button>` : ""}</div>`);
      if (v.state === "away") rows.push(`<div class="row"><span class="grow muted">out of the lobby: nobody sees you or can knock</span><button class="go" data-v="back">Go online</button></div>`);
      if (v.state === "online") {
        rows.push(`<div class="row"><span class="grow">you are</span><select data-v="status">${["available", "busy"].map(s => `<option${s === v.status ? " selected" : ""}>${s}</option>`).join("")}</select>
          <select data-v="max" title="how many visitors at once">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}"${n === v.maxVisitors ? " selected" : ""}>${n} visitors</option>`).join("")}</select></div>`);
      }
      for (const k of v.knocks) {
        rows.push(`<div class="row knock"><b>${esc(k.from.name)}</b> is knocking${k.message ? `: “${esc(k.message)}”` : ""}
          <div class="btns"><button class="go" data-v="in" data-k="${esc(k.id)}">Let in</button><button data-v="out" data-k="${esc(k.id)}">Not now</button>
          <span class="muted">${Math.max(0, Math.round((k.until - Date.now()) / 1000))}s</span></div></div>`);
      }
      if (v.visiting) rows.push(`<div class="row"><span class="grow">in <b>${esc(v.visiting.host.name)}</b>'s room${v.visiting.paused ? " (reloading)" : ""}</span><button data-v="leave">Leave</button></div>`);
      for (const x of v.visitors) rows.push(`<div class="row"><span class="grow"><b>${esc(x.visitor.name)}</b> is visiting</span><button data-v="kick" data-x="${esc(x.id)}">Kick</button></div>`);
      for (const o of v.offices) {
        if (me && o.id === me.id) continue;
        const why = !o.ready ? "not ready" : o.status !== "available" ? o.status : o.visitors >= o.maxVisitors ? "full"
          : v.visiting && v.visiting.host.id === o.id ? "you are there" : v.knocking.some(k => k.to === o.id) ? "knocking…" : "";
        rows.push(`<div class="row"><span class="dot ${esc(o.status)}"></span><span class="grow" title="${esc(o.name)}">${esc(o.name)} <span class="muted">${esc(o.sim.name || "")} ${o.visitors}/${o.maxVisitors}</span></span>
          <button data-v="knock" data-o="${esc(o.id)}" ${why ? `disabled title="${esc(why)}"` : ""}>${v.knocking.some(k => k.to === o.id) ? "Knocking…" : "Knock"}</button></div>`);
        if (composing === o.id) rows.push(`<form class="row" data-o="${esc(o.id)}"><input maxlength="280" placeholder="a message for ${esc(o.name)}"><button class="go">Knock</button></form>`);
      }
      if (v.state === "online" && v.offices.length < 2) rows.push(`<div class="row muted">nobody else is here yet</div>`);
      const html = rows.join("");
      if (html === drawn) return;   // nothing new: an open menu stays open, a click lands
      drawn = html;
      root.innerHTML = html;
      const input = root.querySelector("form input");
      if (input) input.focus();
    }
    root.addEventListener("click", e => {
      const b = e.target.closest("button[data-v]");
      if (!b) return;
      const act = b.dataset.v;
      if (act === "knock") { composing = composing === b.dataset.o ? null : b.dataset.o; draw(); }
      else if (act === "in" || act === "out") v.answer(b.dataset.k, act === "in");
      else if (act === "leave") v.leave();
      else if (act === "kick") v.kick(b.dataset.x);
      else if (act === "away") v.leaveLobby();
      else if (act === "back") v.joinLobby();
    });
    root.addEventListener("change", e => {
      if (e.target.dataset.v === "status") v.setStatus(e.target.value);
      if (e.target.dataset.v === "max") v.setMaxVisitors(Number(e.target.value));
    });
    root.addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target.closest("form");
      v.knock(f.dataset.o, f.querySelector("input").value.trim());
      composing = null;
      f.querySelector("input").blur();
      draw();
    });
    root.addEventListener("focusout", () => setTimeout(draw, 0));
    v.on("change", draw);
    timer = setInterval(() => { if (v.knocks.length) draw(); }, 1000);   // the knocks' countdown
    draw();
    return { element: root, release() { clearInterval(timer); v.off("change", draw); root.remove(); } };
  }

  window.Visit = {
    version: VERSION,
    connect({ port, token, sim = {} }) { const c = new Client(port, token, sim); return c._open().then(() => c, e => { c.close(); throw e; }); },
    walk,
    panel,
  };
})();
