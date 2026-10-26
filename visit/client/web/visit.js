// visit.js: the Visit library (../../SPEC.md section 9; ../../INTEGRATING.md shows it in use). Served by
// visit-client at /visit.js, so a page always runs the library its visit-client speaks. It talks only to
// that visit-client, on 127.0.0.1: it keeps the lobby's state, sends this room's three.js scene to its
// visitors (moving them with its hooks, spawn and move), draws the scene of the room it visits, and captures
// a visitor's input (SPEC 8).
//
//   const v = await Visit.connect({ port, token, sim: { name, version } });
//   v.host({ spawn, move, fov, scene: { root, three, renderer, near, far }, walk: { speed } });
//   Visit.stage(v);   Visit.panel(element, v);
//
// A room takes part once it hosts its scene: every room is three.js, and a visitor's browser draws the room it
// visits itself, with that very three.js release. Walking and looking are as quick as in its own room (the
// visitor's page walks at once and the host corrects it), and a host renders and encodes nothing for anyone.
"use strict";
(function () {
  const VERSION = "0.9.0", PROTO = "basedverse-visit-local/2";
  const MOVE_MS = 1000 / 60, INPUT_MS = 1000 / 30, INPUT_MIN_MS = 8, STALE_MS = 300, LOOK = 0.0025;
  const POINT_MS = 200, AIM_MS = 125;   // a visitor's points, at most one this often; what it aims at, looked for this often
  // What the host hears many times a second: none of it changes what the page shows, so none fires "change".
  const QUIET = new Set(["input", "point", "keyframe", "link_stats", "scene", "scene_lost", "scene_resync"]);
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

  // ---------- scenes: a three.js room, sent as itself and drawn by the visitor's own browser (SPEC 8) ----------
  // A host sends its scene once whole (three.js's own JSON, gzipped), then what changes in it (edits: gzipped
  // JSON, in order, never dropped) and where its moving things are (deltas: binary, newest wins). The visitor
  // draws it with the very three.js release the host runs, fetched from a CDN and checked against the hashes
  // below (Subresource Integrity): nothing else ever runs from it, and what the host sends is only ever read as
  // data (cleanScene). The visitor walks at once, predicted here, and the host's answer corrects it.
  const KEY = 1, EDIT = 2, AVATAR = 4, AUDIO = 8;   // frames' flags: bit 0 a key delta; bit 1 a scene edit, bit 2 this office's avatar (page to visit-client); bit 3 voice (SPEC 5.4)
  // The huddle (SPEC 8.7): 20 ms of 48 kHz mono a packet, Opus at 24 kbps; played this far behind, to ride out jitter.
  const VOICE_RATE = 48000, VOICE_FRAME = 960, VOICE_BITRATE = 24000, VOICE_LEAD = 0.06, VOICE_LATE = 0.4;
  // The microphone's side: 20 ms at a time, to the page (an AudioWorklet, from a blob: as the ticker's Worker is).
  const MIC_WORKLET = `registerProcessor("visit-mic", class extends AudioWorkletProcessor {
    constructor() { super(); this.b = new Float32Array(${VOICE_FRAME}); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) {
        this.b[this.n++] = ch[i];
        if (this.n === ${VOICE_FRAME}) { this.port.postMessage(this.b, [this.b.buffer]); this.b = new Float32Array(${VOICE_FRAME}); this.n = 0; }
      }
      return true;
    }
  });`;
  const rms = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length || 1)); };
  // An avatar (SPEC 8.6): at most this much, gzipped; and once read by a host, at most so many vertices and objects.
  const MAX_AVATAR = 4 << 20, AVATAR_VERTICES = 300000, AVATAR_OBJECTS = 2000;
  // How often a host sends its scene's changes, and the places of everything that has moved, regardless; how far
  // behind the host's clock a visitor shows moving things (two updates: always one to move toward); the most
  // pixels a visitor's view draws (it is stretched past that).
  const SCENE_MS = 1000 / 30, SCENE_KEY_MS = 1000, INTERP_MS = 70, MAX_PIXELS = 1920 * 1080;
  const THREE_BASE = "https://cdn.jsdelivr.net/npm/three@0.{r}.0/build/";
  // three.js revision -> the SHA-384 of its first release's build/three.module.js, or (r171 on, split in two)
  // of [build/three.core.js, build/three.module.js]. A visitor draws the scenes of these revisions.
  const THREE_FILES = {
    "125": "sha384-5Ywi4WNpxs0w7HozLb+bKpTJNY20kAqeXn8GWrqNsIc35NOt7tqRDsjlqQTNQKNF",
    "126": "sha384-B1lRArgkaBiW5faJFZgZ3Y/384PIWuidSL2uNNndFO/OQpgx/t0B+JdK3sNZYM95",
    "127": "sha384-sBwxpuzXNbu5dmQMypWvEMKwpJDWuwlKjYHspu3bOhU6kotCdQhWEohdiMepsva6",
    "128": "sha384-LKlxEdW8EIaLsGQXf6tbodzIk3iElYdwYuFHYRIoTn89xvUzXM/9Ld9KPYTxk4Zc",
    "129": "sha384-hO+ysv9dQX1marzdRDxUAzpim6yMr73w6MnaXEg5Vn530DDf+Bz/u2HrxhcQ7WZM",
    "130": "sha384-X30Nbdd324ays+U+6cW5KSPkr0k/KfDLJdev9xVyIaIQV5vSogTGprr9OMpcV4H5",
    "131": "sha384-v4PgD/ouaGXkgMqHuWiTq9lZJ+lsGK0r3f8/TqN9VPaTSNAPlCJHFhHXPwecfYgh",
    "132": "sha384-4TMDanTqjpAj1zaXppMTQaRdrAF8dP7IzGhr2Vkz5ZDFEK+a8Rb9ikEFyrywstVu",
    "133": "sha384-+9gvq6U5LIiKWpZr5TN4CKBaFHYJYjJBBfCmeLUOYHOyeauFczAKYeko695NhW7a",
    "134": "sha384-Wfr00bxzAvoTAQTXfxH8PIsT5JJIY/U+Z9XziadFRmiHk8OebbConLyrX6sYU/ge",
    "135": "sha384-G2EofhFHZOwtmrs8D3EiwAeo83NR9KAKuB0KTscSkOS0GMhnkZu/2xUn85J4TW6m",
    "136": "sha384-gQBL0VcTpNUqiL90PW82aoOu6EHGaqkmfUdzwqlFCcEiEmMsFanJvrfZ88AoTK+l",
    "137": "sha384-L4AJFgq8HHKtqeG+0jy6j5ZajIGQz37TAiQjQQCbwly2X3MYaU5foXmQseXyP+qk",
    "138": "sha384-pjwJZ/skEfUdUP3KMcJ7R7DK0EuZRYe5F9dorg6Wn/Ir0ZeFouRUyTWHf7LmJA5R",
    "139": "sha384-S5XkCGb5am6P7Rv2RXgTA4Krb3LXhedDK+YrtyqC0195vctAZkIlKE4j5C+azzwc",
    "140": "sha384-V5FXA8YZz9kx4vKeRWWrjBs0EMbFFlPlJp5Rc0Dzove929kAD660bBoCcwP+Ku3A",
    "141": "sha384-po1eddWuuRpjNPxlslM9lQb0UPFCrgL7nJdSnu9zmkjbhitNFai6at7zcS+2O/7B",
    "142": "sha384-x/Al+cOCpZIKZIRFdekN+Yu0ntTZtyTXzAuivfVKLjjAVruJbmDqC37QdupObzUn",
    "143": "sha384-rkhRzjkxQRTIq6KfhMlmDK0WeNc7zppOEgXQbexSP7iFO7OilyNewEUMC02ojJ3o",
    "144": "sha384-zGPkkFv5YPY4udMFe6P/NKDGsgOpNa60NEbvZHPHLGtTr4/aHBMtPJG/clUwH1X1",
    "145": "sha384-D5chtu28ZTnLB+ntDkE/IM65wndGw1NB7eVUEEJk+GiUt/+VJlvZC26KwMAM8olN",
    "146": "sha384-EgZkglHd5d5CpSGV/XQ+oAL89JkW5Jss32pdskxNQb3V/7H9pZblIhbbWs2yGyrs",
    "147": "sha384-foyviqS/+yPbsMkU32dJTGX9lWnqtalJsKDYMmQ0Tr+tiJqUYE/tTTs1nl3dP/PI",
    "148": "sha384-Ov4qZQIF7j8e5K2QrP/k/FbyJBxNvZtXnwJ4i05t/pCaf6eWKwMpMuQcPsj7rNLg",
    "149": "sha384-12YogFBvdVetjPVfxidCU7NzjtjvSQnNeVzUAtopFVGtoco6uyZfxHwbAU1E6nB9",
    "150": "sha384-4XHUcSkRNflX/146yx9K2FPU3HI4DuRxC1ZOQ25lkVKrhnHYAkQypBvChqRHFXnN",
    "151": "sha384-ls6F1ocsyH0C4W24fbbUlOxnRPJcvyr2j7+QZKQD9bzpHwhtw7IFHaN5aND2bKHB",
    "152": "sha384-Q+gzrfCnkOqOv+jRz5Pn2712IWFGBxVZBR7KLX63tOie3TCDPfmqafcbcowKMDVX",
    "153": "sha384-Ftnx0JBTANz3pBRth6b6WelDf1nk4opQiE62V92gzUHaQ8Rx75aR3FCfD3xh+udC",
    "154": "sha384-iJA3Wh2Mk4VM2GiHhGzeRsMla5CtcEYxZOgF1WnaxXWsoAIV52usXoLuuD5EUd97",
    "155": "sha384-mnNh5DCZAFA4qsq6N8lzuYrSVHDw47RurhMpZQWOPZbbKnkesHLJlkKh0ZMyK97x",
    "156": "sha384-CYnyeGNCWc3qAUjmhBJ5c7rSNKZkWKCPS1l5/XfFEGvQSa7qevZ622z98lXKmTf5",
    "157": "sha384-8HEtwX7v0qvVEXBPVFMWgMAgI6hHJzZ0qycweA/vGl79MWdyXxzAHl0XwWprM3nY",
    "158": "sha384-iuC3I0bVuCDzGoJi9KmCkGzEwo7vYFG/gBa7C/1D7mp8ZTt1CgTJ8C57dTDqqpfM",
    "159": "sha384-Od8aWTp92huHhx5H/3qCH5ZPG12v/+EpJktLK/hPpYiC4UoV1yf8OeSk+jD/GCC3",
    "160": "sha384-61S/Nu32S3E5+n+KpCOTb2eRYps6fVKm+9Gz1QBvSePFthb46f063Aa/qe/lykFZ",
    "161": "sha384-c1WSdrtrvLWoZQC5zBcuCBhTpWvCcKFvUPFkF9wsEestdGUyCxZPiVXzYCZEPRzJ",
    "162": "sha384-94gajc6XgNyCt0QElkXXk0mG9VEkNMmL4KZrhzqiErIDYDnA9qb8lR13pW6DGZMN",
    "163": "sha384-yQjt8MxgaibK/2q9rswHtmpprSJXTyvk5UewNPUcnFG8AS53v7JY3JcBgjMD0REu",
    "164": "sha384-wlK04bYFr3nyu6ipQq5N4n7KKGByMS1Yu1T8IrNtEnHiJ5WcGDt9dZBZFpRZjXEE",
    "165": "sha384-Qvl1RLjZOCDFOOH2bKcGnaDHMM8MVv3zVtMvhy3juQdiIOs6RgQ/7zYdM1FbpHzI",
    "166": "sha384-8Ka7v/0OHGFjCdsh2NfPsfSx8QWgM5GXxK78G78tnUN7UjY9LkOqJToGj10DT7Yh",
    "167": "sha384-efR4yFjiLe4PrOyKvJfuUnmdEz0ohNoJEvmCVrdgDU5eigOkblJOVZwt1g8+64kv",
    "168": "sha384-aFCwa46B5vks6EU3cxsUhpA9qOy3yrw5fTF4Y51WEavCCGWj0YzSGsdsP5Ougby2",
    "169": "sha384-qOubuRxWZ0I7rXTjcuhcKNHKvPM7q0ztN8/82sJnxnyKS0OXTeB5FsIcysc2T9EY",
    "170": "sha384-GY5FqjttLCFRt/McQbyaVdCk2O1IQtOeX8Py6NfD89BIAsIyJFRl4UgSXrk2vXAk",
    "171": ["sha384-YpGRVT0+68wf/Tq05Sw6Nuv4F785EXwqdLOynItG6Cyvn2LGu9TSE99n+EUK12AD", "sha384-u+VykAKeL4ZnM4aIDWzqvG2G/XJtXtrdNfBeIn3gGrgMUCGh300cp5h8q6Cl2p+y"],
    "172": ["sha384-gJN+0/sjgafSBd8VGFwNZmLffdxHYB9basxDhZKjxH7PqUizoWy+ZFIAWfknJpsS", "sha384-jSE70HgY49pvjJTRC7wZjn6JUajBcRHT3XSUEIeBqOuHlY8AzkDEjQ1Ortuqy9gh"],
    "173": ["sha384-hDOhkNIzjECbUeD7y0ZuARgCndDLsHIuKhhnmv7Aqxr6MarrEsKbcu33dVXVKVja", "sha384-0SHQLUQ+OesZFn0blBzsF4hsvOTa52wQyct1xwYFAnTTcE3zrv7TSNt/nPZ4TGzq"],
    "174": ["sha384-v4ooZZpwAOZGuZr/1Aw2lIuvBUqLMXwXo4YPUxvwjAEX7LMjrTbTJ00YxL392JL/", "sha384-XYnXNAOuPDbehWj5Esz4dUjqxDbdgiQMzzHwBk3u+S8hIT06xorwCCqxT2/levx+"],
    "175": ["sha384-9iVlJdFMhmo7AjXDdUB+T8nF93quj9nhfeEX3b2Nklv3aoN/VAqsSYpJ+aKLZbxc", "sha384-54vXwOTeTwpNxEBFrjmaBZG3guaJvxC0KbKuhK3YwfVvQipd0/xa0P3Y2b6EMt31"],
    "176": ["sha384-otibkZtXfamhCvKhSPwls+10DMOoYgxW8HQCOC6H0tG3MY+mchtwF0XlkGdPAzBY", "sha384-p5Plfh0W9MU6uGNwg+SryQ5EROPDcqxekRMB9Crrr+uCHXcgE3T0oot4ByGAYDKa"],
    "177": ["sha384-m0oq2VuT/Tt5IpjZtCp+HTaarVOrfp03v2AYRveyDoX4lOVlpk1DPm8fgcn1tDes", "sha384-ITUL0v5v2j45lpwmHksUHldYxM9gaEuM96EH4dDqwIVZpxWI+PMksJcTHxCAB1jM"],
    "178": ["sha384-v7zMvc4Cb5TVml7Htaud7ffbaZ6T1inM2KUGHbfogwbzpbM2HjvdYcn9CpA750Gb", "sha384-FWF4sd0r4IzFTqeNbUmKIVBAWeo88feJafLWCRweaAy60myqpVini5QSjSFsDJ0a"],
    "179": ["sha384-kdRESMLTvI77N5JbbUfZRkASeD0sPnpy89hrqC8kG9/Ih16CWrS9L9qpIdd7CYTM", "sha384-NU/HwPb+8799fAUOI2MmcKBXISPLF1rxYZk5lhnqPQ+IWd3zjAvW2jv0RSihhPKx"],
    "180": ["sha384-r1q8Si7xFBrvMv3Q4yjQkKhkYZ2lp+wn/bPPzNZTsc8DY4uPJmm2vheuz1Yn+8m8", "sha384-wyxAlyAVVsyc7KN24a4+m1tMTC2BwrjQyLgLStDaUBDmwK+gWUMULWHSS0NRoZKv"],
    "181": ["sha384-TwzOUuMYWxW+SbKueCH0R+hoyXBEJ4ZosoHXv+5iX96teAZkI7+lJzKISlR0DRyV", "sha384-fV/3dzi4eiEEAyJEEtFCmXv8gRy4AYNwnDxN+Ki3G97d4hZOliHXxM65JEZbgdsV"],
    "182": ["sha384-6fmg00/Gyjwhs6thvtCHmdaCH/64inXNq9FpwdBWtjV7wHXiHPaPtkBTXl1J7w17", "sha384-u+OjJoQpIuqoJyY+K18+0gLahoZWtDRoz5XJlhiJ/9OpKZV61xnAmgFDYGLrD8X7"],
    "183": ["sha384-bO4ODxwQgwSn05egB/vbceihrp4tn6jmJzx7oZDy/EVWd0imIgGkvccDH3k6HXdL", "sha384-tDnOBR4yGB9V87jI7t3/bA2vGgtDUaOU+poekPUUnV7O3yEhLb4f+gRAXEd6eoCN"],
    "184": ["sha384-dw2ooPewaEIrAgl6oFDBmmBWCE9oW9LxRGcfwZ0hLvEprzo202wXl7vCYHRlSnOT", "sha384-8FCZ1eVO6it4+pbec2aDtnTrwjWXZLJRC+MAGCIPDgsYnUrl/E0A2YlF8ioMKI/J"],
    "185": ["sha384-3nKmLDZR5EoFrqfdssW1u3u4Mi0kjozeBhgNj6XQQ7CT8BEnu/6Skhv0k4MDLmoN", "sha384-Ecdwhw2t8c3nTR0hkEDZbwj+5rkKqzJ376RCQN2x1uofujOCuW/EvGg3BQzE7TS6"],
    "186": ["sha384-mdKeCwPEcbDvzaxwhm+MVuLoMou+E7jQqrs4tmu/n8HBYPGI1kZt0MkJxlMR4zFM", "sha384-m8JoFX52V6NGv2usipnlLJKnJfL7IE8dbniPDDCSGSQv3Hm4n6PjfV6syVwfuoRc"],
  };
  const threes = new Map();   // revision -> its module (a promise)

  // A three.js release as a module of its own (not the page's THREE): fetched, checked against its hash, run.
  function loadThree(rev, base) {
    rev = String(rev);
    if (!threes.has(rev)) {
      const files = THREE_FILES[rev];
      const p = !files ? Promise.reject(new Error(`three.js r${rev} is not one this visit.js knows`)) : (async () => {
        const url = f => (base || THREE_BASE).replace("{r}", rev) + f;
        const get = async (f, integrity) => {
          const r = await fetch(url(f), { integrity, credentials: "omit" });
          if (!r.ok) throw new Error(`${url(f)}: ${r.status}`);
          return r.text();
        };
        const js = text => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
        let main;
        if (Array.isArray(files)) {   // three.module.js imports ./three.core.js: the checked copy instead
          const core = js(await get("three.core.js", files[0]));
          main = (await get("three.module.js", files[1])).replace(/(["'])\.\/three\.core\.js\1/g, JSON.stringify(core));
        } else main = await get("three.module.js", files);
        // three.js warns of a second copy in a page (the room's own): this one is apart, on purpose.
        const prev = window.__THREE__;
        window.__THREE__ = undefined;
        try { return await import(js(main)); } finally { window.__THREE__ = prev; }
      })();
      threes.set(rev, p);
      p.catch(() => threes.delete(rev));
    }
    return threes.get(rev);
  }

  // A data URL image's size, from its header (PNG, JPEG, WebP), before anything decodes it; null if not one.
  function imageDims(url) {
    const m = /^data:image\/(png|jpeg|webp);base64,/.exec(url);
    if (!m) return null;
    let b;
    try { b = Uint8Array.from(atob(url.slice(m[0].length, m[0].length + 87380)), c => c.charCodeAt(0)); } catch (e) { return null; }
    const u16 = i => (b[i] << 8) | b[i + 1], le = (i, n) => { let v = 0; for (let k = n - 1; k >= 0; k--) v = v * 256 + b[i + k]; return v; };
    if (m[1] === "png") return b.length >= 24 && b[1] === 0x50 ? [u16(16) * 65536 + u16(18), u16(20) * 65536 + u16(22)] : null;
    if (m[1] === "jpeg") {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return [u16(i + 7), u16(i + 5)];
        i += mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7) ? 2 : 2 + u16(i + 2);
      }
      return null;
    }
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === "VP8 ") return [le(26, 2) & 0x3fff, le(28, 2) & 0x3fff];
    if (kind === "VP8L") return [1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6))];
    if (kind === "VP8X") return [1 + le(24, 3), 1 + le(27, 3)];
    return null;
  }

  // What a host sends, made safe to hand to three.js's ObjectLoader (SPEC 8.3): materials only of the kinds
  // three.js draws itself (a ShaderMaterial is a program: it becomes plain grey), images only as data URLs no
  // bigger than 4096 px a side (checked from their headers, before decoding), shapes' segment counts at most
  // 256, and, across the scene, at most about 4 million vertices and 100,000 objects. In place; the JSON too.
  const MATERIALS = new Set(["MeshBasicMaterial", "MeshLambertMaterial", "MeshPhongMaterial", "MeshStandardMaterial", "MeshPhysicalMaterial",
    "MeshToonMaterial", "MeshNormalMaterial", "MeshMatcapMaterial", "MeshDepthMaterial", "MeshDistanceMaterial", "LineBasicMaterial",
    "LineDashedMaterial", "PointsMaterial", "SpriteMaterial", "ShadowMaterial"]);
  const SEGMENTS = new Set(["widthSegments", "heightSegments", "depthSegments", "radialSegments", "tubularSegments", "capSegments",
    "phiSegments", "thetaSegments", "segments", "curveSegments", "steps", "bevelSegments"]);
  const ARRAYS = new Set(["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array"]);
  const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const MAX_SIDE = 4096, MAX_VERTICES = 4e6, MAX_OBJECTS = 1e5;
  const isObj = x => !!x && typeof x === "object" && !Array.isArray(x);
  function cleanScene(json, budget) {
    if (!isObj(json)) throw new Error("a scene is a JSON object");
    const arr = k => (Array.isArray(json[k]) ? json[k] : []).filter(isObj);
    json.materials = arr("materials").map(m => MATERIALS.has(m.type) ? m : { uuid: String(m.uuid), type: "MeshLambertMaterial", color: 0x808080 });
    json.geometries = arr("geometries").map(g => {
      let n = 1;
      if (isObj(g.data)) n = (((g.data.attributes || {}).position || {}).array || []).length / 3;
      else {
        const clamp = (o, k, hi) => { o[k] = Math.max(0, Math.min(hi, Math.floor(Number(o[k]) || 0))); return o[k]; };
        const p = isObj(g.parameters) ? g.parameters : {};
        for (const o of [p, isObj(p.options) ? p.options : {}]) for (const k of Object.keys(o)) if (SEGMENTS.has(k)) n *= clamp(o, k, 256) + 1;
        if ("detail" in p) n *= 20 * (clamp(p, "detail", 5) + 1) ** 2;
        if (Array.isArray(p.points)) { p.points = p.points.slice(0, 4096); n *= p.points.length; }   // a lathe's outline
        if (/Box/.test(g.type)) n *= 6;
      }
      budget.vertices += n;
      return budget.vertices <= MAX_VERTICES ? g : { uuid: String(g.uuid), type: "BufferGeometry", data: { attributes: {} } };
    });
    const ok = u => {
      if (typeof u === "string") { const d = imageDims(u); return d && d[0] <= MAX_SIDE && d[1] <= MAX_SIDE ? u : BLANK; }
      return isObj(u) && Array.isArray(u.data) && ARRAYS.has(u.type) && u.width > 0 && u.height > 0 && u.width <= MAX_SIDE && u.height <= MAX_SIDE
        && u.data.length <= u.width * u.height * 4 ? u : BLANK;
    };
    json.images = arr("images").map(im => ({ uuid: String(im.uuid), url: Array.isArray(im.url) ? im.url.slice(0, 6).map(ok) : ok(im.url) }));
    let count = 0;
    const stack = [json.object];
    while (stack.length) {
      const o = stack.pop();
      if (!isObj(o)) continue;
      count++;
      if (Array.isArray(o.children)) { o.children = o.children.filter(isObj); for (const c of o.children) stack.push(c); }
    }
    budget.objects += count;
    if (budget.objects > MAX_OBJECTS) throw new Error(`more than ${MAX_OBJECTS} objects`);
    return json;
  }

  // What the host's renderer draws with, for the visitor's to match, by what its release calls it.
  function rendererProps(r, three) {
    const rev = Number(three.REVISION), out = {};
    if (!r) return out;
    if (r.shadowMap) out.shadowMap = { enabled: !!r.shadowMap.enabled, type: r.shadowMap.type };
    const keys = ["toneMapping", "toneMappingExposure", "sortObjects", rev < 152 ? "outputEncoding" : "outputColorSpace"];
    if (rev < 155) keys.push("physicallyCorrectLights"); else if (rev < 165) keys.push("useLegacyLights");
    for (const k of keys) if (k in r && ["number", "boolean", "string"].includes(typeof r[k])) out[k] = r[k];
    try { const c = new three.Color(); r.getClearColor(c); out.clear = [c.getHex(), r.getClearAlpha()]; } catch (e) { /* not this release */ }
    if (rev >= 152 && three.ColorManagement) out.colorManagement = !!three.ColorManagement.enabled;
    return out;
  }

  // A material's state that changes as a room runs (colours, opacity, visibility...), sent as it changes; a
  // change of its textures sends the whole material again.
  const COLORS = ["color", "emissive", "specular"];
  const VALUES = ["opacity", "transparent", "visible", "wireframe", "side", "depthWrite", "depthTest", "alphaTest", "emissiveIntensity",
    "roughness", "metalness", "shininess", "size", "rotation", "vertexColors", "flatShading", "fog", "toneMapped", "blending"];
  const RECOMPILE = new Set(["transparent", "side", "vertexColors", "flatShading", "fog", "alphaTest", "blending", "toneMapped", "wireframe"]);
  const MAPS = ["map", "emissiveMap", "alphaMap", "normalMap", "bumpMap", "aoMap", "lightMap", "roughnessMap", "metalnessMap", "specularMap",
    "envMap", "gradientMap", "matcap", "displacementMap"];
  const list = x => Array.isArray(x) ? x : x ? [x] : [];
  function matProps(m) {
    const p = {};
    for (const k of COLORS) if (m[k] && m[k].isColor) p[k] = m[k].getHex();
    for (const k of VALUES) if (k in m && ["number", "boolean"].includes(typeof m[k])) p[k] = m[k];
    return p;
  }
  function setProps(m, p) {
    for (const k of COLORS) if (typeof p[k] === "number" && m[k] && m[k].isColor) m[k].setHex(p[k]);
    for (const k of VALUES) {
      if (!(k in p) || !(k in m) || typeof p[k] !== typeof m[k] || m[k] === p[k]) continue;
      m[k] = p[k];
      if (RECOMPILE.has(k)) m.needsUpdate = true;
    }
  }
  const mat16 = (a, b) => { for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return true; return false; };
  const keep = (a, x) => { a.push(x); if (a.length > 6000) a.splice(0, 1000); };

  // An object's JSON as a visitor gets it: of its userData (and its descendants'), only what Visit itself reads
  // (SPEC 8.1): `visitor` (a visitor's own body) and `visitPoint` (something a visitor may point at). The rest is
  // the host's own, where a sim keeps its state (who a figure is, its handles), and never leaves its page; it is
  // put back as it was the moment the JSON is made.
  const SHARED_DATA = ["visitor", "visitPoint"];
  function sharedJSON(o) {
    const kept = [];
    o.traverse(x => {
      const u = x.userData;
      if (!u || typeof u !== "object" || !Object.keys(u).length) return;
      const shared = {};
      for (const k of SHARED_DATA) if (["string", "number", "boolean"].includes(typeof u[k])) shared[k] = u[k];
      kept.push([x, u]);
      x.userData = shared;
    });
    try { return o.toJSON(); } finally { for (const [x, u] of kept) x.userData = u; }
  }

  // The host's side of a scene: what it last sent of each object, material, geometry and texture, so that each
  // round (every SCENE_MS) sends only what changed. One for all of a host's visitors: they get the same edits.
  class SceneSync {
    constructor(cfg) {
      const t = cfg.three;
      // `shared`: every visitor this round's edit goes to reads an added object that names what it has by uuid.
      Object.assign(this, { cfg, objs: new Map(), next: 1, mats: new Map(), geos: new Map(), texs: new Map(), dynamic: new Set(), sent: new Set(), shared: false,
        keyAt: 0, sceneSig: null, inter: [], interSig: null, tmp: { p: new t.Vector3(), q: new t.Quaternion(), s: new t.Vector3() } });
      this.scan(0);   // where everything is now: what the first whole scene shows
    }

    _record(o, parent) {
      const r = { o, idx: this.next++, parent: parent ? parent.o.uuid : null, mats: list(o.material).map(m => m.uuid).join(),
        geo: o.geometry ? o.geometry.uuid : "", m: Float64Array.from(o.matrix.elements), vis: o.visible };
      this.objs.set(o.uuid, r);
      return r;
    }

    // Since the last round: objects added (whole, with what they are made of), removed, moved to another parent,
    // given other materials or geometry; materials' state; geometries and textures changed in place; the scene's
    // background and fog: { edit (null: nothing), moved (the objects whose place or visibility changed) }.
    scan(now) {
      const root = this.cfg.root, first = !this.objs.size;
      const adds = [], removes = [], parents = [], assigns = [], props = [], moved = [], res = new Map(), seen = new Set();
      const usedMats = new Set(), usedGeos = new Set(), usedTexs = new Set();
      root.updateMatrixWorld();
      const stack = [[root, null, false]];
      while (stack.length) {
        const [o, parent, fresh] = stack.pop();
        seen.add(o.uuid);
        let r = this.objs.get(o.uuid), inNew = fresh;
        if (fresh || !r) {
          if (r) removes.push(r.idx);   // it was elsewhere: it comes again within what it was added under
          r = this._record(o, parent);
          if (!fresh && !first) { adds.push(r); inNew = true; }
        } else {
          const p = parent ? parent.o.uuid : null;
          if (r.parent !== p) { r.parent = p; parents.push([r.idx, parent ? parent.idx : 0]); }
          const mats = list(o.material).map(m => m.uuid).join(), geo = o.geometry ? o.geometry.uuid : "";
          if (mats !== r.mats || geo !== r.geo) { r.mats = mats; r.geo = geo; assigns.push(r); }
          if (r.vis !== o.visible || mat16(r.m, o.matrix.elements)) { r.m.set(o.matrix.elements); r.vis = o.visible; moved.push(r); this.dynamic.add(r); }
        }
        for (const m of list(o.material)) usedMats.add(m);
        if (o.geometry) usedGeos.add(o.geometry);
        for (let i = o.children.length - 1; i >= 0; i--) stack.push([o.children[i], r, inNew]);
      }
      const gone = [];
      for (const [uuid, r] of this.objs) if (!seen.has(uuid)) { this.objs.delete(uuid); this.dynamic.delete(r); gone.push(r); }
      const goneIds = new Set(gone.map(r => r.o.uuid));
      for (const r of gone) if (!goneIds.has(r.parent)) removes.push(r.idx);
      // Materials: their state, or (their textures changed) all of them again.
      for (const m of usedMats) {
        const ps = JSON.stringify(matProps(m)), maps = MAPS.map(k => m[k] && m[k].isTexture ? m[k].uuid : "").join(), rec = this.mats.get(m.uuid);
        for (const k of MAPS) if (m[k] && m[k].isTexture) usedTexs.add(m[k]);
        if (!rec) { this.mats.set(m.uuid, { props: ps, maps }); continue; }
        if (maps !== rec.maps) { Object.assign(rec, { props: ps, maps }); res.set(m.uuid, ["material", m]); }
        else if (ps !== rec.props) { rec.props = ps; props.push(Object.assign({ uuid: m.uuid }, JSON.parse(ps))); }
      }
      // Geometries and textures changed in place (their versions moved on): again, at most every 250 and 500 ms.
      const again = (map, x, ver, every, kind) => {
        const rec = map.get(x.uuid);
        if (!rec) return map.set(x.uuid, { ver, at: now });
        if (rec.ver !== ver && now - rec.at >= every) { Object.assign(rec, { ver, at: now }); res.set(x.uuid, [kind, x]); }
      };
      for (const g of usedGeos) again(this.geos, g, Object.values(g.attributes || {}).map(a => a.version).join() + "|" + (g.index ? g.index.version : ""), 250, "geometry");
      if (root.background && root.background.isTexture) usedTexs.add(root.background);
      for (const t of usedTexs) again(this.texs, t, t.version, 500, "texture");
      // What the scene no longer uses, a visitor's page lets go of (_sceneGc): it counts as unsent again, and
      // goes with whatever uses it next.
      const used = new Set([...usedMats, ...usedGeos, ...usedTexs].map(x => x.uuid));
      for (const uuid of this.sent) if (!used.has(uuid)) this.sent.delete(uuid);
      for (const r of assigns) {
        for (const m of list(r.o.material)) if (!this.sent.has(m.uuid)) res.set(m.uuid, ["material", m]);
        if (r.o.geometry && !this.sent.has(r.o.geometry.uuid)) res.set(r.o.geometry.uuid, ["geometry", r.o.geometry]);
      }
      // The scene's own: its background and fog.
      let scene = null;
      if (root.isScene) {
        const bg = root.background, f = root.fog;
        const now2 = { background: bg && bg.isColor ? bg.getHex() : bg && bg.isTexture ? { texture: bg.uuid } : null,
          fog: f ? { type: f.isFogExp2 ? "FogExp2" : "Fog", color: f.color.getHex(), near: f.near, far: f.far, density: f.density } : null };
        const sig = JSON.stringify(now2);
        if (this.sceneSig !== null && sig !== this.sceneSig) {
          scene = now2;
          if (bg && bg.isTexture && !this.sent.has(bg.uuid)) res.set(bg.uuid, ["texture", bg]);
        }
        this.sceneSig = sig;
      }
      // The interactions on (8.3): which types a visitor's crosshair shows hot, and with what label.
      const isig = JSON.stringify(this.inter), inter = this.interSig !== null && isig !== this.interSig;
      this.interSig = isig;
      if (first) return { edit: null, moved: [] };
      const edit = { type: "edit" };
      if (res.size) edit.res = this._resources([...res.values()]);
      if (removes.length) edit.remove = removes;
      if (adds.length) edit.add = adds.map(r => this._added(r));
      if (parents.length) edit.parent = parents;
      if (assigns.length) edit.assign = assigns.map(r => [r.idx, Array.isArray(r.o.material) ? r.o.material.map(m => m.uuid) : r.o.material ? r.o.material.uuid : null, r.o.geometry ? r.o.geometry.uuid : null]);
      if (props.length) edit.props = props;
      if (scene) edit.scene = scene;
      if (inter) edit.interactions = this.inter;
      return { edit: Object.keys(edit).length > 1 ? edit : null, moved };
    }

    // An added object: its JSON (with what it is made of, but, when its visitors read that, the geometries and
    // materials they have: those it names by uuid), each object's number, its lights' targets.
    _added(r) {
      const json = sharedJSON(r.o), ids = [];
      if (this.shared) {
        for (const k of ["geometries", "materials"]) if (json[k]) json[k] = json[k].filter(x => !this.sent.has(x.uuid));
        // A texture goes with each material (or object) that names it, an image with each texture, a shape with each
        // geometry.
        const named = new Set(), stack = [json.object, ...(json.materials || [])];
        while (stack.length) {
          const x = stack.pop();
          if (!isObj(x)) continue;
          for (const v of Object.values(x)) if (typeof v === "string") named.add(v);
          if (Array.isArray(x.children)) stack.push(...x.children);
        }
        if (json.textures) json.textures = json.textures.filter(x => named.has(x.uuid));
        const images = new Set((json.textures || []).map(t => t.image)), shapes = new Set((json.geometries || []).flatMap(g => list(g.shapes)));
        if (json.images) json.images = json.images.filter(x => images.has(x.uuid));
        if (json.shapes) json.shapes = json.shapes.filter(x => shapes.has(x.uuid));
      }
      r.o.traverse(o => { const x = this.objs.get(o.uuid); if (x) ids.push([o.uuid, x.idx]); });
      for (const k of ["geometries", "materials", "textures", "images"]) for (const x of json[k] || []) this.sent.add(x.uuid);
      const parent = this.objs.get(r.parent);
      return { parent: parent ? parent.idx : 0, json, ids, targets: this.targets(r.o) };
    }

    // Geometries, materials and textures to send again (or for the first time), as three.js's toJSON makes them.
    _resources(items) {
      const meta = { geometries: {}, materials: {}, textures: {}, images: {}, shapes: {}, skeletons: {}, animations: {}, nodes: {} };
      for (const [kind, x] of items) {
        if (kind === "geometry") {
          meta.geometries[x.uuid] = x.toJSON();
          for (const sh of list(x.parameters && x.parameters.shapes)) meta.shapes[sh.uuid] = sh.toJSON();
        } else if (kind === "material") meta.materials[x.uuid] = x.toJSON(meta);
        else meta.textures[x.uuid] = x.toJSON(meta);
      }
      const out = {};
      for (const k of ["geometries", "materials", "textures", "images", "shapes"]) {
        out[k] = Object.values(meta[k]).map(x => { delete x.metadata; return x; });
        for (const x of out[k]) this.sent.add(x.uuid);
      }
      return out;
    }

    // Lights' targets (three.js's own JSON leaves them out before r160): [light, target] numbers, or [light,
    // null, the target's place] for a target that is not in the scene.
    targets(top) {
      const out = [];
      top.traverse(o => {
        if (!(o.isDirectionalLight || o.isSpotLight) || !o.target) return;
        const l = this.objs.get(o.uuid), t = this.objs.get(o.target.uuid);
        if (l) out.push(t ? [l.idx, t.idx] : [l.idx, null, o.target.position.toArray()]);
      });
      return out;
    }

    // Everything that has moved since the scene was first sent: a key delta's objects.
    dynamicRecs() { return [...this.dynamic].filter(r => this.objs.get(r.o.uuid) === r); }

    // Objects' places, as a delta lists them (SPEC 8.3): number (u32), flags (u8: 1 visible, 2 scaled), position
    // and quaternion (f32), and the scale (f32) when it is not 1.
    entries(recs) {
      recs = recs.slice(0, 20000);
      const buf = new ArrayBuffer(recs.length * 45), dv = new DataView(buf), { p, q, s } = this.tmp;
      let at = 0;
      for (const r of recs) {
        r.o.matrix.decompose(p, q, s);
        const scaled = Math.abs(s.x - 1) + Math.abs(s.y - 1) + Math.abs(s.z - 1) > 1e-6;
        dv.setUint32(at, r.idx); dv.setUint8(at + 4, (r.o.visible ? 1 : 0) | (scaled ? 2 : 0)); at += 5;
        for (const x of [p.x, p.y, p.z, q.x, q.y, q.z, q.w]) { dv.setFloat32(at, x); at += 4; }
        if (scaled) for (const x of [s.x, s.y, s.z]) { dv.setFloat32(at, x); at += 4; }
      }
      return { n: recs.length, bytes: new Uint8Array(buf, 0, at) };
    }

    // The whole scene, for a visitor starting (or starting again): three.js's own JSON of it, each object's
    // number, and what the visitor needs to draw it as the host does and to walk in it.
    snapshot(h, hooks) {
      const { root, three, renderer } = this.cfg, w = hooks.walk;
      root.updateMatrixWorld();
      const json = sharedJSON(root);
      this.sent = new Set(["geometries", "materials", "textures", "images"].flatMap(k => (json[k] || []).map(x => x.uuid)));
      this.interSig = JSON.stringify(this.inter);
      return { type: "scene", three: String(three.REVISION), json, ids: [...this.objs.values()].map(r => [r.o.uuid, r.idx]), targets: this.targets(root), interactions: this.inter,
        renderer: rendererProps(renderer, three), fov: Number(hooks.fov) || 70, near: Number(this.cfg.near) || 0.1, far: Number(this.cfg.far) || 1000,
        walk: w && Number(w.speed) > 0 ? { speed: Number(w.speed) } : null, yaw0: h.yaw0, pose: h.pose,
        plot: hooks.plot ? { center: hooks.plot.center.map(Number), size: hooks.plot.size.map(Number) } : null, unit: Number(hooks.unit) > 0 ? Number(hooks.unit) : 1,
        preview: hooks.preview ? ["x", "y", "z", "yaw", "pitch"].reduce((o, k) => Object.assign(o, { [k]: Number(hooks.preview[k]) }), {}) : null };
    }
  }

  class Client {
    constructor(port, token, sim, { threeBase = null } = {}) {
      Object.assign(this, { port, token, sim, _threeBase: threeBase });
      this.state = "connecting";   // then "online", "offline" (the lobby out of reach), or "away" (left on purpose)
      this.office = null;
      this.status = "available";
      this.maxVisitors = 3;
      this._samples = { latency: [], drawn: [] };   // the last few thousand of each, for a test's percentiles
      this.offices = [];
      this.key = null;         // this office's key: its lasting identity, the same every run (with a state file)
      this.door = "open";      // "open": your guests come in without knocking; "closed": everyone knocks
      this.guests = [];        // [{ key, name }]: who walks in through the open door
      this.knocks = [];        // on your door: { id, from, message, until, link }
      this.knocking = [];      // yours, waiting: { id, to, link }
      this.layout = [];        // where you have put friends' plots in your world: [{ key, x, z, turn }]
      this.edges = [];         // sides of your plot agreed with friends': [{ key, name, mine, theirs, along, size }]
      this.edgeProposals = []; // edges friends propose, waiting for you: [{ key, name, mine, theirs, along, size }]
      this.watchers = [];      // who sees your room from outside it (your guests' worlds, links): [{ id, visitor, inside, link }]
      this.links = [];         // your links (8.5): [{ id, host, where ("corner", "aside" or "world"), inside }]
      this.avatars = { default: "mine", by: [] };   // whose look your visitors have in your room (8.6): "theirs" or "mine"
      this.huddling = false;   // in the huddle (8.7): your voice goes to those you are linked to who are in it, theirs to you
      this.muted = false;
      this.huddlers = [];      // in the huddle with you: [{ key, name, speaking }]
      this._huddleOn = new Map();   // channel -> the office on the other side of that visit is in the huddle
      this._voices = new Map();     // their key -> a decoder, and where its next moment plays
      this._mic = null;
      this.visiting = null;    // the room in the stage: { id, host, paused, link, inside } (a link's: inside once you go there)
      this.visitors = [];      // { id, visitor, pose }
      this._on = {};
      this._hosted = new Map();   // channel -> a visit to this office (or a watch of its plot)
      this._watches = new Map();  // channel -> a plot this office watches: { id, channel, host, inside, scene, ... }
      this._links = new Map();    // channel -> a link of this office's, wherever it is (in _watches too, in the world)
      this._world = null;         // v.world(): friends' plots drawn around this room
      this._hooks = null;         // until visit.host(): this office is not in the lobby to be visited, nor knocks
      this._interactions = new Map();   // type -> what a visitor's click on something so marked does (8.3)
      // A visitor's numbers, about once a second (the "stats" event): input to screen (drawn here) and the
      // link's round trip in ms, the link's path ("direct" or "relay"), frames drawn a second. null while not
      // visiting.
      this.stats = { latency: null, rtt: null, path: null, fps: 0 };
      this._sync = null;          // what this room last sent of its scene (SceneSync), while it has visitors
      this._viewer = null;        // the visit this office is on: { channel, scene, sceneQ, count }
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
    close() { this._closed = true; this._loop.stop(); this._micStop(); this._dropAll(); if (this._ws) this._ws.close(); }

    _ready(m) {
      this.state = m.away ? "away" : m.online ? "online" : "offline";
      this.office = m.office && m.office.id ? m.office : null;
      this.status = m.status; this.maxVisitors = m.max_visitors;
      this.key = typeof m.key === "string" ? m.key : null;
      this._guests(m);
      this.layout = Array.isArray(m.layout) ? m.layout : [];
      this.edges = Array.isArray(m.edges) ? m.edges : [];
      this.edgeProposals = [];
      this.knocks = []; this.knocking = [];
      this._avatarsFrom(m.avatars);
      this._huddleOn.clear();
      for (const v of m.visits || []) this._started(v);
      if (m.huddle && !this._mic) this._send({ type: "huddle", on: false });   // a huddle this page has no microphone for
      if (this._avatarOwn) this._avatarSend();   // a visit-client that came back has no avatar of this office's
      if (this._hooks) this._sendHost();   // a visit-client that came back: this page hosts, again
      if (this._world) this._send({ type: "world", on: true });
      this._changed();
    }

    _message(m) {
      switch (m.type) {
        case "online":   // (again, after a drop): its own knocks still waiting are these
          this.state = "online"; this.office = m.office;
          if (Array.isArray(m.knocking)) this.knocking = m.knocking.map(k => ({ id: k.id, to: k.to, link: k.link === true }));
          break;
        case "offline":   // away: this office left the lobby on purpose, and sees nobody until it joins again
          this.state = m.away ? "away" : "offline";
          if (m.away) { this.offices = []; this.knocks = []; this.knocking = []; }
          break;
        case "lobby":
          this.offices = (m.offices || []).map(o => ({ id: String(o.id), name: String(o.name), status: String(o.status), sim: o.sim || {},
            maxVisitors: Number(o.max_visitors) || 0, visitors: Number(o.visitors) || 0, visiting: o.visiting || null, ready: o.ready === true,
            key: typeof o.key === "string" ? o.key : null, links: o.links === true }));
          { const me = this.offices.find(o => this.office && o.id === this.office.id); if (me) { this.status = me.status; this.maxVisitors = me.maxVisitors; } }
          break;
        case "knock":
          this.knocks = this.knocks.filter(k => k.id !== m.id).concat([{ id: m.id, from: m.from, message: m.message || "", until: Date.now() + 1000 * (m.expires_in || 60), link: m.link === true }]);
          this._emit("knock", this.knocks[this.knocks.length - 1]);
          break;
        case "knock_cancelled": this.knocks = this.knocks.filter(k => k.id !== m.id); break;
        case "knock_sent": this.knocking = this.knocking.concat([{ id: m.id, to: m.to, link: m.link === true }]); break;
        case "answered": {
          const k = this.knocking.find(x => x.id === m.knock);
          this.knocking = this.knocking.filter(x => x.id !== m.knock);
          this._emit("answered", { to: k && k.to, accept: m.accept, reason: m.reason, message: m.message || "", link: m.link === true });
          break;
        }
        case "guests": this._guests(m); break;
        case "avatars": this._avatarsFrom(m); this._avatarWants(); this._visitorsList(); break;
        case "avatar": this._avatarIn(m); break;
        case "huddle_peer": if (m.on) this._huddleOn.set(m.channel, true); else this._huddleOn.delete(m.channel); this._huddlersList(); break;
        case "huddle": if (!m.on && this._mic) this._micStop(); this.huddling = m.on === true && !!this._mic; this._huddlersList(); break;
        case "layout": this.layout = Array.isArray(m.layout) ? m.layout : []; break;
        case "edges": this.edges = Array.isArray(m.edges) ? m.edges : []; this.edgeProposals = this.edgeProposals.filter(p => !this.edges.some(e => e.key === p.key)); break;
        case "edge_proposed": {
          const p = { key: String(m.key), name: String(m.name || ""), mine: m.mine, theirs: m.theirs, along: Number(m.along) || 0, size: m.size };
          this.edgeProposals = this.edgeProposals.filter(x => x.key !== p.key).concat([p]);
          this._emit("edge_proposed", p);
          break;
        }
        case "edge_declined": this._emit("edge_declined", { key: m.key }); break;
        case "enter": this._hostEnter(m); break;
        case "exit": this._hostExit(m); break;
        case "enter_refused": this._enterRefused(m); break;
        case "visit_started": this._started(m); break;
        case "visit_ended": this._ended(m); break;
        case "host_paused": case "host_resumed":
          if (this.visiting && this._viewer && this._viewer.channel === m.channel) this.visiting.paused = m.type === "host_paused";
          if (this._watches.has(m.channel)) this._watches.get(m.channel).paused = m.type === "host_paused";
          if (this._links.has(m.channel)) this._links.get(m.channel).paused = m.type === "host_paused";
          break;
        case "link_stats":
          if (this._viewer && this._viewer.channel === m.channel) { this.stats.rtt = Number(m.rtt_ms); this.stats.path = String(m.path); }
          break;
        case "keyframe": case "input": case "scene_resync": case "point": case "shared_adds": this._hostMessage(m); break;
        case "scene": this._sceneEdit(m); break;
        case "scene_lost": { const w = this._viewing(m.channel); if (w) this._sceneResync(w); break; }
        case "error": this._emit("error", { code: m.code, message: m.message, ref: m.ref }); break;
      }
    }

    // ---------- actions ----------
    setStatus(status) { this._send({ type: "status", status }); }
    setMaxVisitors(n) { this._send({ type: "max_visitors", n }); }
    rename(name) { this._send({ type: "rename", name }); }
    // A knock: to walk into their room as soon as they let you in. A link (8.5; to an office whose `links` is
    // true): let in, you see their room in a corner (the stage's), from above, and choose: go there (stepIn), put it
    // in your world (toWorld), or not (unlink). To an older office a link is a knock.
    knock(officeId, message = "") { this._send({ type: "knock", to: officeId, message }); }
    link(officeId, message = "") { this._send({ type: "knock", to: officeId, message, link: true }); }
    answer(knockId, accept, message = "") { this.knocks = this.knocks.filter(k => k.id !== knockId); this._send({ type: "answer", knock: knockId, accept, message }); this._changed(); }
    leave() { if (this.visiting) this._send({ type: "end", visit: this.visiting.id }); }   // a link: unlinked
    // Your links (by visit id; the corner's, by default). Into its room, as a visit is (its host's spawn says where),
    // facing the way the corner looked: the corner fills the stage, and your keys and mouse go there. A visit you
    // are on ends first (in one room at a time).
    stepIn(id) {
      const w = this._link(id);
      if (!w || w.inside || w.where === "world") return false;
      if (this._viewer && !this._viewer.link) { this._send({ type: "end", visit: this._viewer.id }); this._leaveCorner(); }
      if (w.where !== "corner") this._toCorner(w);
      const s = w.scene;
      if (this._view && s && s.lookYaw != null) { this._view.yaw = s.lookYaw - s.yaw0; this._view.pitch = 0; }
      w.inside = true; this.visiting.inside = true;
      this._send({ type: "enter", channel: w.channel });
      this._changed();
      return true;
    }
    // Back to your own room: the link's room in the corner again.
    stepOut(id) {
      const w = this._link(id);
      if (!w || !w.inside || w.where === "world") return false;
      w.inside = false;
      if (this.visiting && this.visiting.id === w.id) this.visiting.inside = false;
      this._send({ type: "exit", channel: w.channel });
      if (this._view) { this._view.keys.clear(); if (document.pointerLockElement) document.exitPointerLock(); }
      this._changed();
      return true;
    }
    // A link's room into your world (v.world first): a plot round yours, as a guest's, while the link lasts.
    toWorld(id) {
      const w = this._link(id);
      if (!w || !this._world || w.where === "world") return false;
      if (w.inside) this.stepOut(w.id);
      if (this._viewer === w) this._leaveCorner(); else this._sceneDrop(w);
      Object.assign(w, { where: "world", plot: true, failed: false, since: performance.now(), askedAt: 0, wantWorld: false });
      this._watches.set(w.channel, w);
      this._send({ type: "link_where", channel: w.channel, where: "world" });   // kept, for this page reloaded
      this._sceneResync(w);   // whole again, to be read with this page's three.js
      this._cornerNext();
      this._visitorsList();
      this._changed();
      return true;
    }
    unlink(id) { const w = this._link(id); if (w) this._send({ type: "end", visit: w.id }); }
    // What visitors may click in your room (8.3), by type: something marked userData.visitPoint = "<type>" does what
    // its entry's run says when a visitor clicks it; a type not named here does nothing, and is not shown to them.
    // An entry is cosmetic (it changes only how the room looks or sounds: something moves, lights up, plays) or it
    // is not: it reaches further (your agents, tools, files, accounts, messages, anything beyond the room's looks),
    // and is taken only with agreed: true, which means your user agreed to that one, by name. Each:
    // { cosmetic, agreed, label (what a visitor sees), who ("everyone" | "guests"), reach (scene units), run }, run
    // getting { id, visitor, type, object, point, distance }. Called again, it replaces them all.
    interactions(types) {
      const map = new Map();
      for (const [type, t] of Object.entries(types || {})) {
        if (!/^[\w.-]{1,40}$/.test(type)) throw new Error(`visit.interactions: "${type}" is not a type (letters, digits, _ . -, at most 40)`);
        if (!isObj(t) || typeof t.run !== "function") throw new Error(`visit.interactions: "${type}" needs run({ visitor, object, point })`);
        if (t.cosmetic !== true && t.agreed !== true) {
          throw new Error(`visit.interactions: "${type}" is not cosmetic: register it only once your user has agreed to it, by name (agreed: true)`);
        }
        map.set(type, { cosmetic: t.cosmetic === true, label: String(t.label || type).slice(0, 60), who: t.who === "guests" ? "guests" : "everyone",
          reach: Number(t.reach) > 0 ? Number(t.reach) : Infinity, run: t.run });
      }
      this._interactions = map;
    }
    _interList() { return [...this._interactions].map(([type, t]) => ({ type, label: t.label, cosmetic: t.cosmetic })); }
    // Avatars (8.6). Your own: a three.js object, its origin at its feet, facing -z, in your scene's units (`unit`
    // metres each, host()'s by default), with clips named "idle" and "walk" in its `animations` if it has them; a
    // room that would show you as yourself asks for it (null: none). And whose look your visitors have in your room:
    // their own avatars ("theirs"), or your models ("mine"), by default and for a friend (null: the default).
    avatar(object, { unit } = {}) {
      if (object == null) { this._avatarOwn = null; this._send({ type: "avatar_clear" }); return; }
      if (!object.isObject3D) throw new Error("visit.avatar: a three.js object (or null)");
      const u = Number(unit) > 0 ? Number(unit) : this._unit();
      this._avatarOwn = { object, unit: u };
      this._avatarSend();
    }
    async _avatarSend() {
      const a = this._avatarOwn;
      if (!a) return;
      const text = JSON.stringify({ unit: a.unit, json: sharedJSON(a.object) });
      const gz = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
      if (gz.byteLength > MAX_AVATAR) return this._emit("error", { code: "avatar", message: `your avatar is too big to send (${gz.byteLength} bytes gzipped, at most ${MAX_AVATAR})` });
      if (this._avatarOwn !== a || !this._ws || this._ws.readyState !== 1) return;
      const buf = new Uint8Array(11 + gz.byteLength), dv = new DataView(buf.buffer);
      dv.setUint16(0, 0); dv.setUint8(2, AVATAR); dv.setBigUint64(3, BigInt(Math.round(performance.now() * 1000)));
      buf.set(gz, 11);
      this._ws.send(buf);
    }
    useAvatars(use) { this._send({ type: "avatars", default: use === "theirs" ? "theirs" : "mine" }); }
    useAvatar(key, use) { this._send({ type: "avatar_use", key, use: use === "theirs" || use === "mine" ? use : null }); }
    avatarUse(key) { const b = this.avatars.by.find(x => x.key === key); return b ? b.use : this.avatars.default; }
    _avatarsFrom(m) {
      if (!isObj(m)) return;
      this.avatars = { default: m.default === "theirs" ? "theirs" : "mine",
        by: (Array.isArray(m.by) ? m.by : []).filter(isObj).map(b => ({ key: String(b.key), use: b.use === "theirs" ? "theirs" : "mine" })) };
    }
    // Host side: ask each visitor whose own look this room shows for its avatar, once a visit.
    _avatarWants() {
      for (const h of this._hosted.values()) {
        if (h.avatarAsked || !h.visitor.key || this.avatarUse(h.visitor.key) !== "theirs") continue;
        h.avatarAsked = true;
        this._send({ type: "avatar_want", channel: h.channel });
      }
    }
    // A visitor's avatar: read with this room's three.js (as data: cleanScene, and a size of its own), scaled to this
    // room's units, marked as its body (userData.visitor), its idle and walk clips ready to play.
    _avatarIn(m) {
      const h = this._hosted.get(m.channel), hk = this._hooks;
      if (!h || !hk || !isObj(m.avatar) || !isObj(m.avatar.json)) return;
      try {
        const T = hk.scene.three, budget = { vertices: 0, objects: 0 }, json = cleanScene(m.avatar.json, budget);
        if (budget.vertices > AVATAR_VERTICES || budget.objects > AVATAR_OBJECTS) throw new Error(`more than ${AVATAR_VERTICES} vertices or ${AVATAR_OBJECTS} objects`);
        const o = new T.ObjectLoader().parse(json), k = Math.min(1000, Math.max(0.001, (Number(m.avatar.unit) || 1) / this._unit()));
        o.scale.multiplyScalar(k);
        const body = new T.Group();
        body.add(o); body.name = "avatar:" + (h.visitor.name || ""); body.userData.visitor = h.id;
        const clip = re => (o.animations || []).find(c => re.test(c.name));
        const mixer = new T.AnimationMixer(o), idle = clip(/idle/i), walk = clip(/walk/i);
        this._avatarDrop(h);
        h.avatar = { object: body, mixer, idle: idle && mixer.clipAction(idle), walk: walk && mixer.clipAction(walk), playing: null, at: null };
        this._visitorsList();
        this._changed();
      } catch (e) { console.warn(`visit: ${h.visitor.name}'s avatar cannot be read`, e); }
    }
    _avatarDrop(h) {
      const a = h && h.avatar;
      if (!a) return;
      h.avatar = null;
      a.mixer.stopAllAction();
      if (a.object.parent) a.object.parent.remove(a.object);
      a.object.traverse(c => { if (c.geometry) c.geometry.dispose(); for (const mt of list(c.material)) { for (const k of MAPS) if (mt[k] && mt[k].isTexture) mt[k].dispose(); mt.dispose(); } });
    }
    // Its clips as it moves: walk while it goes (faster than a slow amble), else idle; eased between.
    _avatarStep(h, dt) {
      const a = h.avatar, p = h.pose;
      if (!a || !p) return;
      const moved = a.at ? Math.hypot(p.x - a.at.x, p.z - a.at.z) / Math.max(dt, 1e-3) : 0;
      a.at = { x: p.x, z: p.z };
      const want = moved > 0.3 / this._unit() ? a.walk || a.idle : a.idle || null;
      if (want !== a.playing) {
        if (a.playing) a.playing.fadeOut(0.2);
        if (want) want.reset().fadeIn(0.2).play();
        a.playing = want;
      }
      a.mixer.update(dt);
    }
    // Whether this office sees that one's room from outside it: a plot in its world (a guest's, or a link put there).
    watching(officeId) { return [...this._watches.values()].some(w => w.host.id === officeId); }
    _link(id) { return id == null ? (this._viewer && this._viewer.link ? this._viewer : null) : [...this._links.values()].find(w => w.id === id) || null; }
    // In the room in the stage (a visit, or a link gone there): where keys, the mouse and points go.
    _inRoom() { return !!this.visiting && (!this.visiting.link || this.visiting.inside); }
    // Out of the lobby (nobody sees this office or can knock; its visits end) and back. visit-client keeps
    // it out across its restarts when it has a state file (VISIT_STATE_FILE).
    leaveLobby() { this._send({ type: "leave_lobby" }); }
    joinLobby() { this._send({ type: "join_lobby" }); }
    kick(visitId) { this._send({ type: "end", visit: visitId }); }
    // Your door and your guests (kept by visit-client, with its state file): while the door is open, a guest's
    // knock lets them in at once, without asking you. A guest is a key, as v.offices lists it (or, surer, as a
    // visit's peer has it: its link proved it), with the name you knew them by.
    setDoor(open) { this._send({ type: "door", open: !!open }); }
    addGuest(key, name = "") { this._send({ type: "guest_add", key, name }); }
    removeGuest(key) { this._send({ type: "guest_remove", key }); }
    isGuest(key) { return !!key && this.guests.some(g => g.key === key); }
    // Your world's layout (kept by visit-client): where a friend's plot sits, its centre in your room's units and
    // 0-3 quarter turns; unplaced, it goes in a ring round yours by itself. And edges agreed with friends (both
    // must): your side ("north" -z, "east" +x, "south" +z, "west" -x) to theirs, their middle `along` metres from
    // yours (along your side, turning left); while agreed, their plot sits there, for both of you.
    place(key, { x, z, turn = 0 }) { this._send({ type: "place", key, x, z, turn }); }
    unplace(key) { this._send({ type: "unplace", key }); }
    proposeEdge(key, { mine, theirs, along = 0 }) { this._send({ type: "edge_propose", key, mine, theirs, along, size: this._plotMetres() }); }
    acceptEdge(key) { this._send({ type: "edge_accept", key, size: this._plotMetres() }); this.edgeProposals = this.edgeProposals.filter(p => p.key !== key); this._changed(); }
    declineEdge(key) { this._send({ type: "edge_decline", key }); this.edgeProposals = this.edgeProposals.filter(p => p.key !== key); this._changed(); }
    removeEdge(key) { this._send({ type: "edge_remove", key }); }
    // This room's plot ({ center, size } in its units: as host() said, or what its scene covers), and in metres.
    _plot() {
      const hk = this._hooks;
      if (!hk) return null;
      if (this._plotFrom !== hk) { this._plotFrom = hk; this._plotIs = plotOf(hk.plot, hk.scene.root, hk.scene.three); }
      return this._plotIs;
    }
    _unit() { return this._hooks && Number(this._hooks.unit) > 0 ? Number(this._hooks.unit) : 1; }
    _plotMetres() { const p = this._plot(); return p ? p.size.map(x => x * this._unit()) : [10, 10]; }
    // Your friends' plots around your room, and walking onto them (../../WORLD.md): see World.
    world(opts = {}) { if (this._world) this._world.release(); return new World(this, opts); }
    _guests(m) {
      this.door = m.door === "closed" ? "closed" : "open";
      this.guests = (Array.isArray(m.guests) ? m.guests : []).map(g => ({ key: String(g.key), name: String(g.name || "") }));
      this._guestLinksToWorld();
    }
    // A link with a guest is that guest's plot in your world, as watching it would be: visit-client counts the link
    // as watching that office and starts no world watch of it beside (watch_guests), so in the corner it would take
    // a guest's plot off your ground. With a world, such a link goes there (when it starts, or when its office
    // becomes a guest); a link with anyone else stays in the corner.
    _guestLinksToWorld() {
      if (!this._world) return;
      for (const w of [...this._links.values()]) if (w.where !== "world" && !w.inside && this.isGuest(w.host.key)) this.toWorld(w.id);
    }

    // ---------- visits ----------
    _started(m) {
      if (m.role === "host") {
        // A watcher (../../WORLD.md) sees this room's plot from outside it: sent the scene, never spawned, until it
        // steps in (`enter`).
        const h = { id: m.id, channel: m.channel, visitor: m.peer || {}, guest: m.guest === true, watch: m.watch === true, link: m.link === true, inside: m.watch !== true || m.inside === true,
          pose: null, yaw0: 0, input: null, inputAt: 0, keyNext: true, fails: 0, sceneSent: false, posed: null, sharedAdds: m.shared_adds === true };
        if (m.state && m.state.pose && h.inside) { h.pose = m.state.pose; h.yaw0 = m.state.yaw0 || 0; }   // back after this page reloaded
        this._hosted.set(m.channel, h);
        if (h.inside) this._spawn(h);
        this._avatarWants();
      } else if (m.watch) {
        // A plot watched (the world's), or a link (8.5): the corner's if it is free, else aside, waiting for it.
        const w = { id: m.id, channel: m.channel, host: m.peer || {}, watch: true, link: m.link === true, plot: m.link !== true, where: m.link ? "aside" : null,
          inside: false, paused: false, count: 0, scene: null, sceneQ: null, since: performance.now(), loading: false, failed: false };
        if (w.link) this._links.set(m.channel, w); else this._watches.set(m.channel, w);
        if (m.inside) this._send({ type: "exit", channel: m.channel });   // this page lost where it was: it starts at home
        if (w.link && m.where === "world") { w.wantWorld = true; if (this._world) this.toWorld(w.id); }   // where it was put, before a reload
        else if (w.link && this._world && this.isGuest(w.host.key)) this.toWorld(w.id);   // a guest's: its plot (_guestLinksToWorld)
        else if (w.link && !this._viewer) this._toCorner(w);
      } else {
        if (this._viewer && this._viewer.link) this._aside(this._viewer);   // a visit: the corner's link waits aside
        this.visiting = { id: m.id, host: m.peer || {}, paused: false, link: false, inside: true };
        this._viewer = { id: m.id, channel: m.channel, count: 0, scene: null, sceneQ: null, since: performance.now(), loading: false, failed: false };
        this._placeholder();
      }
      if (m.huddle) this._huddleOn.set(m.channel, true);
      this._visitorsList();
      this._emit("visit_started", { id: m.id, role: m.role, peer: m.peer, guest: m.guest === true, link: m.link === true });
    }

    _ended(m) {
      const h = this._hosted.get(m.channel);
      if (h && h.id === m.id) { this._avatarDrop(h); this._hosted.delete(m.channel); }
      const w = this._watches.get(m.channel);
      if (w && w.id === m.id) { this._sceneDrop(w); this._watches.delete(m.channel); }
      const l = this._links.get(m.channel);
      if (l && l.id === m.id) { this._links.delete(m.channel); this._sceneDrop(l); }
      if (this.visiting && this.visiting.id === m.id) { this._dropViewer(); this.visiting = null; this._cornerNext(); }
      this._huddleOn.delete(m.channel);
      this._visitorsList();
      this._emit("visit_ended", { id: m.id, reason: m.reason });
    }

    _dropAll() {
      this._hosted.clear();
      for (const w of this._watches.values()) this._sceneDrop(w);
      this._watches.clear();
      for (const w of this._links.values()) this._sceneDrop(w);
      this._links.clear();
      this._dropViewer();
      this.visiting = null;
      this._visitorsList();
    }

    _visitorsList() {
      const hs = [...this._hosted.values()];
      this.visitors = hs.filter(h => h.inside).map(h => ({ id: h.id, visitor: h.visitor, guest: h.guest, pose: h.pose, link: h.link,
        avatar: h.avatar && h.visitor.key && this.avatarUse(h.visitor.key) === "theirs" ? h.avatar.object : null }));
      this.watchers = hs.filter(h => h.watch).map(h => ({ id: h.id, visitor: h.visitor, inside: h.inside, link: h.link }));
      this.links = [...this._links.values()].map(w => ({ id: w.id, host: w.host, where: w.where, inside: w.inside }));
      this._huddlersList();
    }

    // ---------- the huddle (8.7) ----------
    // Voice with everyone you are linked to (a visit either way, a link, a plot in your world or yours in theirs)
    // who is in the huddle too: join (your microphone, with echo cancelled: headphones are better still), mute, leave.
    // A page that goes leaves it (its microphone goes with it).
    async huddle(on) {
      if (!on) { this._micStop(); this.huddling = false; this._send({ type: "huddle", on: false }); this._huddlersList(); this._changed(); return; }
      if (this._mic) return;
      if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") throw new Error("visit.huddle: this browser cannot encode voice (WebCodecs)");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      const ctx = this._audio();
      await ctx.resume();
      if (!this._micModule) {
        this._micModule = URL.createObjectURL(new Blob([MIC_WORKLET], { type: "text/javascript" }));
        await ctx.audioWorklet.addModule(this._micModule);
      }
      const src = ctx.createMediaStreamSource(stream), node = new AudioWorkletNode(ctx, "visit-mic"), hush = ctx.createGain();
      hush.gain.value = 0; src.connect(node); node.connect(hush); hush.connect(ctx.destination);   // pulled by the graph, heard by nobody here
      const enc = new AudioEncoder({ output: c => this._voiceOut(c), error: e => console.warn("visit: the voice encoder failed", e) });
      enc.configure({ codec: "opus", sampleRate: VOICE_RATE, numberOfChannels: 1, bitrate: VOICE_BITRATE });
      const mic = this._mic = { stream, src, node, hush, enc, t: 0, level: 0 };
      node.port.onmessage = e => {
        const pcm = e.data;
        mic.level = rms(pcm);
        if (this.muted || enc.state !== "configured") return;
        enc.encode(new AudioData({ format: "f32-planar", sampleRate: VOICE_RATE, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: mic.t, data: pcm }));
        mic.t += pcm.length * 1e6 / VOICE_RATE;
      };
      this.huddling = true;
      this._send({ type: "huddle", on: true });
      this._huddlersList();
      this._changed();
    }
    mute(on) { this.muted = !!on; this._changed(); }
    _audio() { return this._ctx && this._ctx.state !== "closed" ? this._ctx : (this._ctx = new AudioContext({ sampleRate: VOICE_RATE, latencyHint: "interactive" })); }
    _micStop() {
      const m = this._mic;
      if (!m) return;
      this._mic = null;
      m.node.port.onmessage = null;
      for (const t of m.stream.getTracks()) t.stop();
      try { m.src.disconnect(); m.node.disconnect(); m.hush.disconnect(); } catch (e) { /* gone */ }
      if (m.enc.state !== "closed") m.enc.close();
      for (const s of this._voices.values()) { if (s.dec.state !== "closed") s.dec.close(); s.gain.disconnect(); }
      this._voices.clear();
    }
    // A packet of your voice: to visit-client, which sends it to each office in the huddle with you.
    _voiceOut(chunk) {
      if (!this._ws || this._ws.readyState !== 1 || !this.huddling) return;
      const buf = new Uint8Array(11 + chunk.byteLength), dv = new DataView(buf.buffer);
      dv.setUint16(0, 0); dv.setUint8(2, AUDIO); dv.setBigUint64(3, BigInt(Math.round(performance.now() * 1000)));
      chunk.copyTo(buf.subarray(11));
      this._ws.send(buf);
    }
    // A packet of someone's voice: decoded, and played just after the last of theirs (a little behind now, to ride
    // out the network's unevenness; too far behind, caught up).
    _voiceIn(ch, data) {
      if (!this.huddling || !this._ctx) return;
      const p = this._peerOf(ch), key = (p && p.key) || "channel:" + ch;
      let s = this._voices.get(key);
      if (!s) {
        const ctx = this._ctx, gain = ctx.createGain();
        gain.connect(ctx.destination);
        s = { key, gain, next: 0, ts: 0, level: 0, heardAt: 0, frames: 0, dec: null };
        s.dec = new AudioDecoder({ output: d => this._voicePlay(s, d), error: e => { console.warn("visit: a voice could not be decoded", e); this._voices.delete(key); } });
        s.dec.configure({ codec: "opus", sampleRate: VOICE_RATE, numberOfChannels: 1 });
        this._voices.set(key, s);
      }
      if (s.dec.state !== "configured") return;
      s.dec.decode(new EncodedAudioChunk({ type: "key", timestamp: (s.ts += 20000), data }));
    }
    _voicePlay(s, d) {
      const ctx = this._ctx, n = d.numberOfFrames, buf = ctx.createBuffer(1, n, d.sampleRate), pcm = buf.getChannelData(0);
      try { d.copyTo(pcm, { planeIndex: 0, format: "f32-planar" }); } catch (e) { d.close(); return; }
      d.close();
      s.level = rms(pcm); s.frames++;
      if (s.level > 0.01) s.heardAt = performance.now();
      const src = ctx.createBufferSource(), now = ctx.currentTime;
      src.buffer = buf; src.connect(s.gain);
      if (s.next < now || s.next > now + VOICE_LATE) s.next = now + VOICE_LEAD;
      src.start(s.next);
      s.next += buf.duration;
    }
    _peerOf(ch) {
      const h = this._hosted.get(ch);
      if (h) return h.visitor;
      const w = this._viewing(ch) || this._links.get(ch);
      return w ? (w.host || (this.visiting && this.visiting.host)) : null;
    }
    // Who is in the huddle with you: each office once (two visits may join you), speaking if heard just now.
    _huddlersList() {
      const seen = new Map();
      if (this.huddling) for (const ch of this._huddleOn.keys()) {
        const p = this._peerOf(ch), key = p && (p.key || p.id);
        if (!p || seen.has(key)) continue;
        const s = this._voices.get(p.key);
        seen.set(key, { key: p.key || null, name: p.name || "", speaking: !!s && performance.now() - s.heardAt < 400 });
      }
      this.huddlers = [...seen.values()];
    }

    // ---------- links (8.5) ----------
    // A link into the corner: the stage's small picture, its room drawn as its host draws it, from above, until you
    // step in. A link back from aside or the world has no scene here: it asks for the whole one again.
    _toCorner(w) {
      if (this._viewer && this._viewer !== w) { if (this._viewer.link) this._aside(this._viewer); else return; }   // a visit keeps the stage
      if (w.where === "world") { this._watches.delete(w.channel); this._sceneDrop(w); w.stale = true; this._send({ type: "link_where", channel: w.channel, where: "corner" }); }
      const stale = w.stale;
      Object.assign(w, { where: "corner", plot: false, stale: false, failed: false, since: performance.now(), askedAt: 0 });
      this._viewer = w;
      this.visiting = { id: w.id, host: w.host, paused: w.paused, link: true, inside: w.inside };
      if (stale) this._sceneResync(w);
      this._placeholder();
      this._visitorsList();
    }
    // Out of the corner, waiting: no scene kept (its edits are not read meanwhile).
    _aside(w) {
      if (w.inside) this.stepOut(w.id);
      if (this._viewer === w) this._leaveCorner(); else this._sceneDrop(w);
      Object.assign(w, { where: "aside", stale: true });
      this._visitorsList();
    }
    _leaveCorner() { this._dropViewer(); this.visiting = null; }
    // The corner free: the newest link waiting takes it (not one on its way back into the world).
    _cornerNext() {
      if (this._viewer) return;
      const next = [...this._links.values()].filter(w => w.where === "aside" && !w.wantWorld).pop();
      if (next) this._toCorner(next);
    }

    // ---------- hosting ----------
    // `scene`: { root, three, renderer, near, far }, the room's three.js scene (or the part of it to share), the
    // THREE namespace it was made with, its renderer and its visitors' camera range. `fov`: that camera's vertical
    // field of view, in degrees. `walk` (optional): { speed }, when `move` walks with Visit.walk at that speed:
    // the visitor's page then walks at once, before the host's answer. Until this is called, this office is not
    // in the lobby to be visited, and cannot knock: every room takes part with its scene.
    host(hooks) {
      if (!hooks || typeof hooks.spawn !== "function" || typeof hooks.move !== "function") throw new Error("visit.host needs spawn and move functions");
      const sc = hooks.scene;
      if (!sc || !(sc.root && sc.root.isObject3D && sc.three && sc.three.REVISION)) {
        throw new Error("visit.host needs scene: { root, three }: the room's three.js scene, and the THREE it was made with");
      }
      const revs = Object.keys(THREE_FILES);
      if (!THREE_FILES[String(sc.three.REVISION)]) throw new Error(`visit.host: three.js r${sc.three.REVISION} is not one this visit.js knows (r${revs[0]} to r${revs[revs.length - 1]})`);
      // `plot` (optional): { center: [x, z], size: [w, d] }, the rectangle of this room's floor that is its land in a
      // world (../../WORLD.md), in its scene's units; `unit`: how many metres one of them is (1).
      const pl = hooks.plot;
      if (pl != null && !(isObj(pl) && Array.isArray(pl.center) && Array.isArray(pl.size) && pl.center.length === 2 && pl.size.length === 2
        && [...pl.center, ...pl.size].every(Number.isFinite) && pl.size[0] > 0 && pl.size[1] > 0)) throw new Error("visit.host: plot is { center: [x, z], size: [w, d] }");
      if (hooks.unit != null && !(Number(hooks.unit) > 0)) throw new Error("visit.host: unit is how many metres one of the scene's units is (a number above 0)");
      // `preview` (optional): { x, y, z, yaw, pitch }, where a link sees this room from before going in (8.5); without
      // it, from above its plot, going round.
      const pv = hooks.preview;
      if (pv != null && !(isObj(pv) && ["x", "y", "z", "yaw", "pitch"].every(k => Number.isFinite(pv[k])))) throw new Error("visit.host: preview is { x, y, z, yaw, pitch }");
      this._hooks = hooks;
      this._sync = null;
      this._plotFrom = null;
      for (const h of this._hosted.values()) { if (h.inside) this._spawn(h); h.sceneSent = false; }
      for (const w of this._watches.values()) if (w.failed) Object.assign(w, { failed: false, since: performance.now(), askedAt: 0 });   // now it can read them
      this._sendHost();
    }
    _sendHost() { this._send({ type: "host", three: String(this._hooks.scene.three.REVISION) }); }

    // A watcher stepping in is spawned where it stepped (`at`, in this room's terms; spawn may put it elsewhere), and
    // its input's yaw is its look in this room's terms (yaw0 0): it walks in from a world, not from its arrival.
    _spawn(h, at) {
      if (!this._hooks || h.pose) return;
      try { h.pose = Object.assign({}, this._hooks.spawn(h.visitor, at ? { at } : {})); h.yaw0 = h.watch ? 0 : h.pose.yaw || 0; }
      catch (e) { console.error("visit: spawn threw", e); }
    }

    _hostEnter(m) {
      const h = this._hosted.get(m.channel);
      if (!h || !h.watch) return;
      Object.assign(h, { inside: true, pose: null, input: null, keyNext: true, fails: 0 });
      const at = isObj(m.pose) ? { x: Number(m.pose.x) || 0, y: Number(m.pose.y) || 0, z: Number(m.pose.z) || 0, yaw: Number(m.pose.yaw) || 0 } : null;
      this._spawn(h, at);
      this._visitorsList();
    }

    _hostExit(m) {
      const h = this._hosted.get(m.channel);
      if (!h || !h.watch) return;
      Object.assign(h, { inside: false, pose: null, input: null });
      this._visitorsList();
    }

    _hostMessage(m) {
      const h = this._hosted.get(m.channel);
      if (!h) return;
      if (m.type === "input") { h.input = m; h.inputAt = performance.now(); this._step(h, h.inputAt); }   // at once: the next delta has it
      else if (m.type === "keyframe") h.keyNext = true;   // a key delta: where everything that moves is
      else if (m.type === "scene_resync") h.sceneSent = false;
      else if (m.type === "shared_adds") h.sharedAdds = true;   // its page reads an add naming what it has by uuid (8.3)
      else if (m.type === "point") this._point(h, m);
    }

    // A visitor pointed: clicked at the middle of its view (SPEC 8.3). The page hears "point" with where from
    // (where this page has the visitor: its eyes) and which way (where it looked as it clicked, in the room's own
    // terms: yaw 0 toward -z, positive turning left, pitch positive up), and decides what, if anything, that does.
    _point(h, m) {
      const p = h.pose;
      if (!p || !Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return;
      const yaw = h.yaw0 + m.yaw, pitch = Math.max(-1.4, Math.min(1.4, m.pitch)), c = Math.cos(pitch);
      const from = [Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0], dir = [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
      this._emit("point", { id: h.id, visitor: h.visitor, from, dir, yaw, pitch });
      if (this._interactions.size) this._interact(h, from, dir);
    }

    // A point at something marked with a type of interaction this room takes (8.3): the first thing on the ray that
    // is not a visitor's body or hidden, then the type on it or on what it is part of. Its entry runs if the type is
    // on, this visitor may (a guest, for who: "guests"), and it is within reach.
    _interact(h, from, dir) {
      const hk = this._hooks;
      if (!hk) return;
      const T = hk.scene.three, ray = this._ray || (this._ray = new T.Raycaster());
      ray.set(new T.Vector3(...from), new T.Vector3(...dir));
      const body = o => { for (; o; o = o.parent) if (!o.visible || (o.userData && o.userData.visitor)) return true; return false; };
      const hit = ray.intersectObject(hk.scene.root, true).find(x => !body(x.object));
      if (!hit) return;
      let object = hit.object, type = null;
      for (; object; object = object.parent) if (object.userData && typeof object.userData.visitPoint === "string") { type = object.userData.visitPoint; break; }
      const t = type && this._interactions.get(type);
      if (!t || hit.distance > t.reach || (t.who === "guests" && !this.isGuest(h.visitor.key))) return;
      const e = { id: h.id, visitor: h.visitor, type, object, point: hit.point.toArray(), distance: hit.distance };
      try { t.run(e); } catch (x) { console.error(`visit: interaction "${type}" threw`, x); }
      this._emit("interaction", { id: h.id, visitor: h.visitor, type, cosmetic: t.cosmetic, object });
    }

    // Every SCENE_MS, for this room's visitors: what changed in its scene (one edit for them all), where its
    // moving things and each visitor are (a delta each), and the whole scene to any visitor starting.
    _sceneTick(now) {
      const hs = [...this._hosted.values()].filter(h => h.pose || (h.watch && !h.inside));
      if (!hs.length || !this._hooks) { this._sync = null; return; }
      try {
        if (!this._sync || this._sync.cfg !== this._hooks.scene) {   // a new scene, or numbered anew: everyone gets it whole
          this._sync = new SceneSync(this._hooks.scene);
          for (const h of hs) h.sceneSent = false;
        }
        const sync = this._sync, ready = hs.filter(h => h.sceneSent);
        sync.inter = this._interList();
        sync.shared = ready.every(h => h.sharedAdds);   // one visitor on an older Visit: every add whole, as it reads them
        const { edit, moved } = sync.scan(now);
        if (edit && ready.length) this._sendScene(ready, edit);
        const key = now - sync.keyAt >= SCENE_KEY_MS;
        if (key) sync.keyAt = now;
        const body = sync.entries(moved), all = key || ready.some(h => h.keyNext) ? sync.entries(sync.dynamicRecs()) : null;
        for (const h of ready) {
          const k = key || h.keyNext, p = h.pose, posed = p ? [p.x, p.y, p.z, p.yaw, p.pitch, h.input && h.input.t].join() : "-";
          if (k || body.n || posed !== h.posed) { this._sendDelta(h, k ? all : body, k, now); h.posed = posed; h.keyNext = false; }
        }
        for (const h of hs) if (!h.sceneSent) { this._sendScene([h], sync.snapshot(h, this._hooks)); h.sceneSent = true; h.keyNext = true; }
      } catch (e) { console.error("visit: could not send the scene", e); }
    }

    // A scene edit to these visitors, gzipped, after any before it (SPEC 5.4: flags EDIT).
    _sendScene(hs, edit) {
      let text;
      try { text = JSON.stringify(edit); } catch (e) { return console.warn("visit: a scene edit that does not turn into JSON", e); }
      const channels = hs.map(h => h.channel);
      this._sceneOut = (this._sceneOut || Promise.resolve()).then(async () => {
        const gz = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
        if (gz.byteLength > 16 << 20) return console.warn(`visit: a scene edit too big to send (${gz.byteLength} bytes gzipped)`);
        for (const ch of channels) {
          if (!this._ws || this._ws.readyState !== 1) return;
          const buf = new Uint8Array(11 + gz.byteLength);
          new DataView(buf.buffer).setUint16(0, ch);
          buf[2] = EDIT;
          buf.set(gz, 11);
          this._ws.send(buf);
        }
      }).catch(e => console.warn("visit: could not send a scene edit", e));
    }

    // A delta (SPEC 8.3): where the host has this visitor (and the input it got that far with), then objects'
    // places; a key delta has everything that ever moved. To a watcher not in the room, version 2: no pose of its.
    _sendDelta(h, body, key, now) {
      if (!this._ws || this._ws.readyState !== 1) return;
      const buf = new Uint8Array(11 + 37 + body.bytes.byteLength), dv = new DataView(buf.buffer), p = h.pose || { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
      dv.setUint16(0, h.channel); dv.setUint8(2, key ? KEY : 0); dv.setBigUint64(3, BigInt(Math.round(now * 1000)));
      dv.setUint8(11, h.pose ? 1 : 2);
      dv.setFloat64(12, h.input ? Number(h.input.t) || 0 : 0);
      dv.setFloat32(20, h.input ? now - h.inputAt : 0);
      [p.x, p.y, p.z, p.yaw, p.pitch].forEach((x, i) => dv.setFloat32(24 + 4 * i, Number(x) || 0));
      dv.setUint32(44, body.n);
      buf.set(body.bytes, 48);
      this._ws.send(buf);
    }

    // The room visited, or a plot watched, on this channel.
    _viewing(ch) { return this._viewer && this._viewer.channel === ch ? this._viewer : this._watches.get(ch) || null; }
    _live(w) { return this._viewer === w || this._watches.get(w.channel) === w; }

    // Edits apply one after another, in order (the first, the whole scene, waits for three.js to load).
    _sceneEdit(m) {
      const w = this._viewing(m.channel);
      if (!w || !isObj(m.edit)) return;
      const whole = m.edit.type === "scene";
      if (whole) w.loading = true;
      w.sceneQ = (w.sceneQ || Promise.resolve()).then(() => !this._live(w) ? null : whole ? (w.plot ? this._watchStart(w, m.edit) : this._sceneStart(w, m.edit)) : this._sceneApply(w, m.edit))
        .finally(() => { if (whole) w.loading = false; })
        .catch(e => {
          if (!this._live(w)) return;
          if (whole) {   // this page cannot draw it (three.js would not load, say): it says so where the room would be
            console.warn("visit: cannot draw this room's scene", e);
            w.failed = true;
            this._sceneDrop(w);
            if (!w.plot) this._placeholder(`cannot draw ${(this.visiting && this.visiting.host.name) || "this"}'s room: ${e.message || e}`);
            this._emit("error", { code: "scene", message: String(e.message || e) });
          } else { console.warn("visit: a scene edit that did not apply; asking for the whole scene again", e); this._sceneResync(w); }
        });
    }

    // At most every 2 s (as visit-client passes them on): one asked for sooner goes when it may.
    _sceneResync(w) {
      const wait = 2000 - (performance.now() - (w.resyncAt || -1e9));
      if (wait > 0) {
        if (!w.resyncTimer) w.resyncTimer = setTimeout(() => { w.resyncTimer = 0; if (this._live(w)) this._sceneResync(w); }, wait);
        return;
      }
      w.resyncAt = performance.now();
      this._send({ type: "scene_resync", channel: w.channel });
    }

    // A host's whole scene, read (as data: cleanScene) with three.js release T: the host's own for a visit, this
    // page's for a plot it watches. `ownId`: the visit, whose body the host draws for others, not for these eyes.
    _sceneRead(T, e, ownId) {
      const budget = { vertices: 0, objects: 0 }, loader = new T.ObjectLoader();
      let root = loader.parse(cleanScene(e.json, budget));
      if (!root.isScene) { const sc = new T.Scene(); sc.add(root); root = sc; }
      const pose = isObj(e.pose) ? e.pose : {}, num = (x, d) => Number.isFinite(Number(x)) ? Number(x) : d;
      const s = { T, loader, budget, root, ownId, byIdx: new Map(), idxOf: new Map(), geos: new Map(), mats: new Map(), texs: new Map(), samples: new Map(),
        offs: [], offset: null, pose: { x: num(pose.x, 0), y: num(pose.y, 1.6), z: num(pose.z, 0) }, yaw0: num(e.yaw0, 0),
        walk: isObj(e.walk) && num(e.walk.speed, 0) > 0 ? { speed: Math.min(50, num(e.walk.speed, 2.5)) } : null,
        hist: [], vis: { x: 0, y: 0, z: 0 }, waitKey: true, own: [], last: 0, gcAt: performance.now(), q: new T.Quaternion(), v: new T.Vector3(), relight: null,
        interactions: interMap(e.interactions) };
      this._sceneAdopt(s, root);
      const byUuid = new Map();
      root.traverse(o => byUuid.set(o.uuid, o));
      for (const [uuid, idx] of Array.isArray(e.ids) ? e.ids : []) { const o = byUuid.get(uuid); if (o) { s.byIdx.set(idx, o); s.idxOf.set(o, idx); } }
      s.byIdx.set(0, root);
      this._sceneTargets(s, e.targets);
      return s;
    }

    // A plot watched (../../WORLD.md), read with this page's own three.js, to be drawn in its world (World.render)
    // where its layout puts it: its plot (or what its scene covers) and its units, lit as this page lights.
    async _watchStart(w, e) {
      const hk = this._hooks;
      if (!hk) throw new Error("a plot is drawn with this page's own three.js: v.host first");
      this._sceneDrop(w);
      const T = hk.scene.three, s = this._sceneRead(T, e, w.id);
      s.plot = plotOf(e.plot, s.root, T);
      s.unit = Number(e.unit) > 0 ? Math.min(1000, Number(e.unit)) : 1;
      s.pose = { x: 0, y: 0, z: 0 }; s.yaw0 = 0; s.hostPose = null;
      s.relight = [legacyLights(Number(e.three), isObj(e.renderer) ? e.renderer : null), legacyLights(Number(T.REVISION), hk.scene.renderer)];
      relight(s.root, ...s.relight);
      this._sceneOwn(s);
      w.scene = s;
      this._send({ type: "keyframe", channel: w.channel });   // where its moving things are now
      this._changed();
    }

    async _sceneStart(w, e) {
      const T = await loadThree(e.three, this._threeBase);
      if (this._viewer !== w) return;
      this._sceneDrop(w);
      const s = this._sceneRead(T, e, w.id), num = (x, d) => Number.isFinite(Number(x)) ? Number(x) : d;
      // Drawn as the host draws it: its renderer's settings, its camera's field of view and range.
      s.canvas = document.createElement("canvas");
      s.renderer = new T.WebGLRenderer({ canvas: s.canvas, antialias: true });
      const r = isObj(e.renderer) ? e.renderer : {};
      if (isObj(r.shadowMap)) { s.renderer.shadowMap.enabled = !!r.shadowMap.enabled; if (typeof r.shadowMap.type === "number") s.renderer.shadowMap.type = r.shadowMap.type; }
      for (const k of ["toneMapping", "toneMappingExposure", "sortObjects", "outputEncoding", "outputColorSpace", "physicallyCorrectLights", "useLegacyLights"]) {
        if (k in r && k in s.renderer && typeof r[k] === typeof s.renderer[k]) s.renderer[k] = r[k];
      }
      if (Array.isArray(r.clear)) s.renderer.setClearColor(num(r.clear[0], 0), num(r.clear[1], 1));
      if (typeof r.colorManagement === "boolean" && T.ColorManagement && "enabled" in T.ColorManagement) T.ColorManagement.enabled = r.colorManagement;
      s.camera = new T.PerspectiveCamera(Math.min(150, Math.max(10, num(e.fov, 70))), 1, Math.max(0.001, num(e.near, 0.1)), Math.max(1, num(e.far, 1000)));
      s.camera.rotation.order = "YXZ";
      if (w.link) {   // seen from outside until you go there: its plot from above, or where its host says to look from
        s.plot = plotOf(e.plot, s.root, T);
        const p = e.preview;
        s.preview = isObj(p) && ["x", "y", "z", "yaw", "pitch"].every(k => Number.isFinite(p[k])) ? p : null;
      }
      w.scene = s;
      this._sceneOwn(s);
      this._sceneAttach(w);
      this._send({ type: "keyframe", channel: w.channel });   // where its moving things are now
      const loop = () => {
        if (w.scene !== s) return;
        s.raf = requestAnimationFrame(loop);
        try { this._sceneFrame(w); } catch (x) { console.error("visit: drawing the scene", x); }
      };
      s.raf = requestAnimationFrame(loop);
    }

    // Each geometry, material and texture kept once, by its uuid: one the scene has already stays (the new copy
    // goes), so an added object made of what is already here shares it.
    _sceneAdopt(s, top) {
      const maps = m => {
        for (const k of MAPS) {
          const t = m[k];
          if (!t || !t.isTexture) continue;
          const have = s.texs.get(t.uuid);
          if (have && have !== t) { t.dispose(); m[k] = have; } else s.texs.set(t.uuid, t);
        }
      };
      top.traverse(o => {
        if (o.geometry && o.geometry.uuid) {
          const have = s.geos.get(o.geometry.uuid);
          if (have && have !== o.geometry) { o.geometry.dispose(); o.geometry = have; } else s.geos.set(o.geometry.uuid, o.geometry);
        }
        if (o.material) {
          const ms = list(o.material).map(m => {
            const have = s.mats.get(m.uuid);
            if (have && have !== m) { m.dispose(); return have; }
            s.mats.set(m.uuid, m); maps(m); return m;
          });
          o.material = Array.isArray(o.material) ? ms : ms[0];
        }
        if (o.isScene && o.background && o.background.isTexture) s.texs.set(o.background.uuid, o.background);
      });
    }

    _sceneTargets(s, targets) {
      for (const t of Array.isArray(targets) ? targets : []) {
        const light = s.byIdx.get(t[0]);
        if (!light || !(light.isDirectionalLight || light.isSpotLight)) continue;
        const to = t[1] != null && s.byIdx.get(t[1]);
        if (to) light.target = to;
        else if (Array.isArray(t[2]) && t[2].length === 3 && t[2].every(Number.isFinite)) { light.target.position.fromArray(t[2]); light.target.updateMatrixWorld(); }
      }
    }

    // The visitor's own body, which the host draws in its room for everyone else: not drawn in its own eyes
    // (the host marks it with userData.visitor = the visit's id). In a world, this page draws its own instead.
    _sceneOwn(s) {
      const id = s.ownId;
      s.own = [];
      s.root.traverse(o => { if (id && o.userData && o.userData.visitor === id) s.own.push(o); });
    }

    _sceneAttach(w) {
      const v = this._view, s = w.scene;
      if (v && s && v.gl !== s.canvas) v.attach(s.canvas);
    }

    _sceneApply(w, e) {
      const s = w.scene;
      if (!s) return this._sceneResync(w);   // an edit with no scene to apply it to: start again
      if (isObj(e.res)) this._sceneResources(s, e.res);
      if (Array.isArray(e.interactions)) s.interactions = interMap(e.interactions);
      for (const idx of Array.isArray(e.remove) ? e.remove : []) {
        const o = idx ? s.byIdx.get(idx) : null;
        if (!o) continue;
        if (o.parent) o.parent.remove(o);
        o.traverse(c => { const i = s.idxOf.get(c); if (i !== undefined) { s.byIdx.delete(i); s.idxOf.delete(c); s.samples.delete(i); } });
      }
      for (const a of Array.isArray(e.add) ? e.add : []) {
        if (!isObj(a)) continue;
        try {
          const budget = Object.assign({}, s.budget), o = this._sceneParse(s, cleanScene(a.json, s.budget));
          if (!o) {   // what it would have counted is not in the scene
            Object.assign(s.budget, budget);
            console.warn("visit: an object added to the scene made of what this page does not have: the whole scene again");
            this._sceneResync(w);
            continue;
          }
          if (s.relight) relight(o, ...s.relight);
          this._sceneAdopt(s, o);
          const byUuid = new Map();
          o.traverse(c => byUuid.set(c.uuid, c));
          for (const [uuid, idx] of Array.isArray(a.ids) ? a.ids : []) { const c = byUuid.get(uuid); if (c && idx) { s.byIdx.set(idx, c); s.idxOf.set(c, idx); } }
          (s.byIdx.get(a.parent) || s.root).add(o);
          this._sceneTargets(s, a.targets);
        } catch (x) { console.warn("visit: an object added to the scene that could not be read", x); }
      }
      for (const [idx, p] of Array.isArray(e.parent) ? e.parent : []) {
        const o = s.byIdx.get(idx), to = s.byIdx.get(p) || s.root;
        if (o && idx && o !== to && !o.getObjectById(to.id)) to.add(o);
      }
      for (const [idx, mats, geo] of Array.isArray(e.assign) ? e.assign : []) {
        const o = s.byIdx.get(idx);
        if (!o) continue;
        if (mats != null && "material" in o) {
          const ms = list(mats).map(u => s.mats.get(u)).filter(Boolean);
          if (ms.length) o.material = Array.isArray(mats) ? ms : ms[0];
        }
        if (geo != null && "geometry" in o && s.geos.get(geo)) o.geometry = s.geos.get(geo);
      }
      for (const p of Array.isArray(e.props) ? e.props : []) { const m = isObj(p) && s.mats.get(p.uuid); if (m) setProps(m, p); }
      if (isObj(e.scene)) {
        const { background: bg, fog } = e.scene, T = s.T;
        if (typeof bg === "number") s.root.background = new T.Color(bg);
        else if (isObj(bg)) s.root.background = s.texs.get(bg.texture) || null;
        else if (bg === null) s.root.background = null;
        if (fog === null) s.root.fog = null;
        else if (isObj(fog) && Number.isFinite(fog.color)) s.root.fog = fog.type === "FogExp2" ? new T.FogExp2(fog.color, Number(fog.density) || 0.00025) : new T.Fog(fog.color, Number(fog.near) || 1, Number(fog.far) || 1000);
      }
      this._sceneOwn(s);
    }

    // An added object, read with the geometries and materials this scene already has: the host sends each once,
    // and an added object names the ones sent before only by uuid. Null when it names one this page does not have
    // (an edit or a whole scene that never arrived, or an add that could not be read).
    _sceneParse(s, json) {
      const has = (k, map) => { const here = new Set((json[k] || []).map(x => x.uuid)); return u => here.has(u) || map.has(u); };
      const geo = has("geometries", s.geos), mat = has("materials", s.mats), stack = [json.object];
      while (stack.length) {
        const o = stack.pop();
        if (!isObj(o)) continue;
        if (o.geometry !== undefined && !geo(o.geometry)) return null;
        for (const u of list(o.material)) if (!mat(u)) return null;
        if (Array.isArray(o.children)) stack.push(...o.children);
      }
      const L = s.loader, P = Object.getPrototypeOf(L), had = { parseGeometries: s.geos, parseMaterials: s.mats };
      for (const [k, map] of Object.entries(had)) L[k] = (...a) => Object.assign(Object.fromEntries(map), P[k].apply(L, a));
      try { return L.parse(json); } finally { for (const k of Object.keys(had)) delete L[k]; }
    }

    // Geometries, materials and textures sent again (changed in place) or new: one the scene has takes the new
    // one's content, where it is used; a new one is kept for what refers to it.
    _sceneResources(s, res) {
      const L = s.loader, json = cleanScene(Object.assign({}, res), s.budget);
      const geos = L.parseGeometries(json.geometries, L.parseShapes(Array.isArray(res.shapes) ? res.shapes : []));
      const texs = L.parseTextures(Array.isArray(res.textures) ? res.textures : [], L.parseImages(json.images));
      const mats = L.parseMaterials(json.materials, Object.assign(Object.fromEntries(s.texs), texs));
      for (const [uuid, g] of Object.entries(geos)) {
        const have = s.geos.get(uuid);
        if (have) { have.dispose(); have.copy(g); g.dispose(); } else s.geos.set(uuid, g);
      }
      for (const [uuid, t] of Object.entries(texs)) {
        const have = s.texs.get(uuid);
        if (have) { have.copy(t); have.needsUpdate = true; } else s.texs.set(uuid, t);
      }
      for (const [uuid, m] of Object.entries(mats)) {
        const have = s.mats.get(uuid);
        for (const k of MAPS) if (m[k] && m[k].isTexture && s.texs.get(m[k].uuid)) m[k] = s.texs.get(m[k].uuid);
        if (have && have.type === m.type) { have.copy(m); have.needsUpdate = true; m.dispose(); continue; }
        if (have) s.root.traverse(o => { if (o.material === have) o.material = m; else if (Array.isArray(o.material)) o.material = o.material.map(x => x === have ? m : x); });
        s.mats.set(uuid, m);
      }
    }

    // A delta: where the host has this visitor, and its moving things' places, each kept with the host's time
    // to be shown INTERP_MS later, between two of them.
    _sceneDelta(w, dv, key) {
      const s = w.scene, ver = dv.byteLength >= 48 ? dv.getUint8(11) : 0;
      if (!s || (ver !== 1 && ver !== 2)) return;   // 2: a watcher's, not in the room: no pose of its
      if (s.waitKey && !key) return;
      if (key) s.waitKey = false;
      const ts = Number(dv.getBigUint64(3)) / 1000, now = performance.now();
      // The host's clock against this page's: the least (arrival - sent) of the last 2 s (a one-way trip's
      // floor: no update is shown before it could have come).
      s.offs.push([now, now - ts]);
      while (s.offs.length > 1 && now - s.offs[0][0] > 2000) s.offs.shift();
      s.offset = s.offs.reduce((a, x) => Math.min(a, x[1]), Infinity);
      if (ver === 1 && (!w.watch || w.inside)) {
        this._sceneReconcile(s, dv.getFloat64(12), dv.getFloat32(20), dv.getFloat32(24), dv.getFloat32(28), dv.getFloat32(32), now);
        if (w.watch) s.hostPose = { x: dv.getFloat32(24), y: dv.getFloat32(28), z: dv.getFloat32(32) };
      }
      const n = dv.getUint32(44);
      let at = 48;
      for (let i = 0; i < n && at + 33 <= dv.byteLength; i++) {
        const idx = dv.getUint32(at), fl = dv.getUint8(at + 4), f = k => dv.getFloat32(at + 5 + 4 * k);
        const p = [f(0), f(1), f(2)], q = [f(3), f(4), f(5), f(6)];
        at += 33;
        let sc = null;
        if (fl & 2) { if (at + 12 > dv.byteLength) break; sc = [dv.getFloat32(at), dv.getFloat32(at + 4), dv.getFloat32(at + 8)]; at += 12; }
        const o = s.byIdx.get(idx);
        if (!o || !idx || ![...p, ...q, ...(sc || [])].every(x => Number.isFinite(x) && Math.abs(x) < 1e7)) continue;
        let l = s.samples.get(idx);
        if (!l) s.samples.set(idx, l = []);
        const last = l[l.length - 1];
        if (last && ts <= last.ts) continue;   // older than what it has
        // At rest until now: where it was, just before this, so it moves from there rather than glides from long ago.
        if (!last || ts - last.ts > 2.5 * SCENE_MS) l.push({ ts: ts - SCENE_MS, p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray(), vis: o.visible });
        l.push({ ts, p, q, s: sc, vis: !!(fl & 1) });
        if (l.length > 8) l.splice(0, l.length - 8);
      }
    }

    // Where the host has this visitor, for the input of time `t` (this page's clock) it had got `age` ms into:
    // against where this page had predicted it would be by then, the difference is put right at once in where
    // it stands, and eased away (in 100 ms or so) in what it sees. A host that does not say how its visitors
    // walk gets followed, eased the same way.
    _sceneReconcile(s, t, age, x, y, z, now) {
      if (![x, y, z].every(Number.isFinite)) return;
      s.vis.y -= y - s.pose.y; s.pose.y = y;
      let px = s.pose.x, pz = s.pose.z, when = null;
      if (s.walk && t > 0 && s.hist.length) {
        when = Math.min(now, t + Math.max(0, age));
        const h = s.hist;
        let i = h.length - 1;
        while (i > 0 && h[i][0] > when) i--;
        const a = h[i], b = h[i + 1];
        const k = b && b[0] > a[0] ? Math.max(0, Math.min(1, (when - a[0]) / (b[0] - a[0]))) : 0;
        px = b ? a[1] + (b[1] - a[1]) * k : a[1]; pz = b ? a[2] + (b[2] - a[2]) * k : a[2];
      }
      const ex = x - px, ez = z - pz;
      if (Math.hypot(ex, ez) > 4) { s.pose.x = x; s.pose.z = z; s.vis.x = s.vis.z = 0; s.hist.length = 0; return; }   // far off (put elsewhere): there at once
      if (Math.abs(ex) + Math.abs(ez) < 1e-5) return;
      s.pose.x += ex; s.pose.z += ez; s.vis.x -= ex; s.vis.z -= ez;
      if (when !== null) for (const e of s.hist) if (e[0] >= when) { e[1] += ex; e[2] += ez; }
    }

    // One frame of the room visited, drawn here: this visitor walked as its keys say (when the host said how its
    // visitors walk), looking where its mouse says, the room's moving things where they were INTERP_MS ago.
    _sceneFrame(w) {
      const s = w.scene, v = this._view, c = s.canvas, now = performance.now();
      const dt = Math.min(0.1, s.last ? (now - s.last) / 1000 : 0);
      s.last = now;
      const cw = c.clientWidth, ch = c.clientHeight;
      if (!cw || !ch) return;   // not shown
      const k = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (cw * ch))), W = Math.max(2, Math.round(cw * k)), H = Math.max(2, Math.round(ch * k));
      if (c.width !== W || c.height !== H) { s.renderer.setSize(W, H, false); s.camera.aspect = W / H; s.camera.updateProjectionMatrix(); }
      const yaw = s.yaw0 + (v ? v.yaw : 0), pitch = v ? v.pitch : 0, outside = w.link && !w.inside;
      if (s.walk && v && v.active && !outside && this.visiting && !this.visiting.paused) {
        const key = x => v.keys.has(x);
        const p = walk({ x: s.pose.x, z: s.pose.z, yaw }, { forward: (key("KeyW") || key("ArrowUp") ? 1 : 0) - (key("KeyS") || key("ArrowDown") ? 1 : 0),
          strafe: (key("KeyD") || key("ArrowRight") ? 1 : 0) - (key("KeyA") || key("ArrowLeft") ? 1 : 0), run: key("ShiftLeft") || key("ShiftRight") }, dt, s.walk);
        s.pose.x = p.x; s.pose.z = p.z;
      }
      s.hist.push([now, s.pose.x, s.pose.z]);
      while (s.hist.length > 2 && now - s.hist[0][0] > 2000) s.hist.shift();
      const fade = Math.exp(-dt / 0.1);
      s.vis.x *= fade; s.vis.y *= fade; s.vis.z *= fade;
      if (outside) this._lookOn(s, now);
      else { s.camera.position.set(s.pose.x + s.vis.x, s.pose.y + s.vis.y, s.pose.z + s.vis.z); s.camera.rotation.set(pitch, yaw, 0); }
      if (s.offset !== null) this._sceneInterp(s, now - s.offset - INTERP_MS);
      for (const o of s.own) o.visible = false;
      if (!outside) this._aim(s, now);
      s.renderer.render(s.root, s.camera);
      w.count++;
      this.frames = (this.frames || 0) + 1;
      const done = performance.now();
      keep(this._samples.drawn, done);
      if (v && v.changedAt) {   // input to screen: drawn here, the next frame after the keys or mouse changed
        const ms = done - v.changedAt;
        v.changedAt = 0;
        this.stats.latency = this.stats.latency == null ? ms : this.stats.latency * 0.9 + ms * 0.1;
        keep(this._samples.latency, ms);
      }
      if (now - s.gcAt > 30000) { s.gcAt = now; this._sceneGc(s); }
    }

    // A link's room from outside: from where its host says (`preview`), or from above its plot, going round it once a
    // minute. lookYaw: the way it looks, which a visitor going there walks in facing.
    _lookOn(s, now) {
      const c = s.camera, p = s.preview;
      if (p) { c.position.set(p.x, p.y, p.z); c.rotation.set(Math.max(-1.4, Math.min(1.4, p.pitch)), p.yaw, 0); s.lookYaw = p.yaw; return; }
      const pl = s.plot, r = Math.max(pl.size[0], pl.size[1]), a = now / 60000 * 2 * Math.PI;
      c.position.set(pl.center[0] + Math.sin(a) * r * 0.85, r * 0.6, pl.center[1] + Math.cos(a) * r * 0.85);
      c.lookAt(pl.center[0], 0, pl.center[1]);
      s.lookYaw = a;
    }

    _sceneInterp(s, at) {
      for (const [idx, l] of s.samples) {
        const o = s.byIdx.get(idx);
        if (!o || !l.length) { s.samples.delete(idx); continue; }
        let i = 0;
        while (i < l.length - 1 && l[i + 1].ts <= at) i++;
        const a = l[i], b = l[i + 1], k = b && at > a.ts ? Math.min(1, (at - a.ts) / (b.ts - a.ts)) : 0;
        o.position.fromArray(a.p);
        o.quaternion.fromArray(a.q);
        if (a.s) o.scale.fromArray(a.s); else o.scale.set(1, 1, 1);
        if (b && k > 0) {
          o.position.lerp(s.v.fromArray(b.p), k);
          o.quaternion.slerp(s.q.fromArray(b.q), k);
          o.scale.lerp(b.s ? s.v.fromArray(b.s) : s.v.set(1, 1, 1), k);
        }
        o.visible = (b && k >= 1 ? b : a).vis;
        if (i > 0) l.splice(0, i);
        if (!b && at - a.ts > 1000) s.samples.delete(idx);   // at rest: as it is
      }
    }

    // What no object uses any more (removed with them): freed, and the scene's size counted again.
    _sceneGc(s) {
      const used = new Set();
      let objects = 0, vertices = 0;
      s.root.traverse(o => {
        objects++;
        if (o.geometry) used.add(o.geometry.uuid);
        for (const m of list(o.material)) { used.add(m.uuid); for (const k of MAPS) if (m[k] && m[k].isTexture) used.add(m[k].uuid); }
      });
      if (s.root.background && s.root.background.isTexture) used.add(s.root.background.uuid);
      for (const map of [s.geos, s.mats, s.texs]) for (const [uuid, x] of map) if (!used.has(uuid)) { x.dispose(); map.delete(uuid); }
      for (const g of s.geos.values()) vertices += g.attributes && g.attributes.position ? g.attributes.position.count : 0;
      Object.assign(s.budget, { objects, vertices });
    }

    _sceneDrop(w) {
      const s = w && w.scene;
      if (!s) return;
      w.scene = null;
      cancelAnimationFrame(s.raf);
      if (this._world) this._world._forget(w);
      for (const map of [s.geos, s.mats, s.texs]) for (const x of map.values()) { try { x.dispose(); } catch (e) { /* gone */ } }
      if (!s.renderer) return;   // a plot watched: drawn by the world, with this page's renderer
      try { s.renderer.dispose(); s.renderer.forceContextLoss(); } catch (e) { /* gone */ }
      if (this._view && this._view.gl === s.canvas) this._view.detach(); else s.canvas.remove();
    }


    // 60 times a second: a visitor's input (when it is due), every visitor moved, and (every SCENE_MS) what
    // changed in this room's scene sent; once a second the stats.
    _tick() {
      const now = performance.now();
      if (this._view) this._sendInput(now, this._view.pending);
      const w = this._viewer;
      if (w && !w.scene && !w.loading && !w.failed && now - (w.askedAt || w.since) > 3000) { w.askedAt = now; this._sceneResync(w); }   // no scene yet: ask again
      if (this._viewer && now - (this._statsAt || 0) >= 1000) {
        this._statsAt = now;
        this.stats.fps = this._viewer.count; this._viewer.count = 0;
        this._emit("stats", this.stats);
      }
      for (const w of this._watches.values()) if (!w.scene && !w.loading && !w.failed && now - (w.askedAt || w.since) > 3000) { w.askedAt = now; this._sceneResync(w); }
      if (!this._hooks || !this._hosted.size) return;
      for (const h of [...this._hosted.values()]) if (h.inside) this._step(h, now);
      if (now - (this._avatarAt || 0) >= 33) {   // visitors' own avatars, walking or idle, 30 times a second
        const dt = Math.min(0.25, (now - (this._avatarAt || now)) / 1000);
        this._avatarAt = now;
        for (const h of this._hosted.values()) if (h.inside && h.avatar && this.avatarUse(h.visitor.key) === "theirs") this._avatarStep(h, dt);
      }
      if (now - (this._sceneAt || 0) >= SCENE_MS - 2) { this._sceneAt = now; this._sceneTick(now); }
      this._visitorsList();
    }

    // One visitor: moved up to now from its latest input. Every tick, and at once when its input comes, so the
    // next delta has where it went.
    _step(h, now) {
      if (!this._hooks) return;
      if (!h.pose) { this._spawn(h); if (!h.pose) return; }
      const dt = Math.min(0.25, (now - (h.movedAt || now)) / 1000);
      h.movedAt = now;
      const fresh = h.input && now - h.inputAt < STALE_MS;
      const input = fresh ? h.input : { forward: 0, strafe: 0, run: false, yaw: h.input ? h.input.yaw : 0, pitch: h.input ? h.input.pitch : 0 };
      try {
        const turned = Object.assign({}, h.pose, { yaw: h.yaw0 + (input.yaw || 0), pitch: input.pitch || 0 });
        h.pose = Object.assign({}, this._hooks.move(turned, input, dt, { id: h.id, visitor: h.visitor }) || turned);
        h.fails = 0;
      } catch (e) { return this._hookFailed(h, "move", e); }
      if (now - (h.keptAt || 0) >= 200) {   // where the visitor stands, kept by visit-client for a reload of this page
        h.keptAt = now;
        this._send({ type: "pose", channel: h.channel, state: { pose: h.pose, yaw0: h.yaw0 } });
      }
    }

    _hookFailed(h, hook, e) {
      console.error(`visit: ${hook} threw, for ${h.visitor.name}`, e);
      if (++h.fails >= 3) this.kick(h.id);
    }

    // ---------- visiting ----------
    // Where the room you are visiting is drawn. While the view is active (the default) it takes WASD, Shift and
    // the mouse; inactive (setActive(false): a picture-in-picture, say) it takes nothing, and the page's own
    // keys are its own again. `viewFocused` says which.
    get viewFocused() { return !!(this._inRoom() && this._view && this._view.active); }

    view(element) {
      if (this._view) this._view.release();
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "display:block;width:100%;height:100%;background:#000;cursor:pointer;outline:none";
      canvas.tabIndex = 0;
      element.appendChild(canvas);
      const view = { element, canvas, ctx: canvas.getContext("2d"), keys: new Set(), yaw: 0, pitch: 0, sentAt: 0, resizeAt: 0, active: true, pending: false, raf: 0,
        gl: null, changedAt: 0, pointAt: 0, cross: null };   // gl: the canvas a scene is drawn on, in this one's place
      // The crosshair: where a click points, shown while the mouse looks about (the pointer locked); hot over
      // something the host marked with userData.visitPoint.
      if (getComputedStyle(element).position === "static") element.style.position = "relative";
      const cross = view.cross = document.createElement("div");
      cross.className = "visit-cross";
      cross.style.cssText = "position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-6px 0 0 -6px;border:2px solid rgba(255,255,255,.9);" +
        "border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.55);pointer-events:none;display:none;transition:transform .08s,background .08s";
      element.appendChild(cross);
      const hint = view.hint = document.createElement("div");   // what a hot thing does: its interaction's label
      hint.className = "visit-hint";
      hint.style.cssText = "position:absolute;left:50%;top:50%;margin:12px 0 0 0;transform:translateX(-50%);padding:2px 8px;border-radius:6px;" +
        "font:12px/1.4 system-ui,sans-serif;color:#fff;background:rgba(13,17,23,.7);pointer-events:none;display:none;white-space:nowrap";
      element.appendChild(hint);
      const locked = () => !!document.pointerLockElement && (document.pointerLockElement === canvas || document.pointerLockElement === view.gl);
      const ignore = e => e.ctrlKey || e.metaKey || e.altKey || (e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)));
      const KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"];
      const changed = () => { view.changedAt = view.changedAt || performance.now(); this._sendInput(performance.now(), true); };   // at once (at most every 8 ms): no waiting for a tick
      const down = e => {
        if (!this._inRoom() || !view.active || ignore(e) || !KEYS.includes(e.code)) return;
        e.preventDefault();
        if (!view.keys.has(e.code)) { view.keys.add(e.code); changed(); }
      };
      const up = e => { if (view.keys.delete(e.code)) changed(); };
      const blur = () => { if (view.keys.size) { view.keys.clear(); changed(); } };
      const click = e => { if (view.active && this._inRoom() && e.currentTarget.requestPointerLock) e.currentTarget.requestPointerLock(); };
      const press = e => { if (e.button === 0 && locked() && view.active && this._inRoom()) this._pointNow(); };
      const lock = () => { cross.style.display = locked() && view.active ? "block" : "none"; if (cross.style.display === "none") hint.style.display = "none"; };
      const look = e => {
        if (!locked()) return;
        view.yaw -= e.movementX * LOOK;
        view.pitch = Math.max(-1.4, Math.min(1.4, view.pitch - e.movementY * LOOK));
        changed();
      };
      addEventListener("keydown", down); addEventListener("keyup", up); addEventListener("blur", blur);
      canvas.addEventListener("click", click); document.addEventListener("mousemove", look);
      canvas.addEventListener("mousedown", press); document.addEventListener("pointerlockchange", lock);
      const resize = new ResizeObserver(() => { view.resizeAt = performance.now() + 250; });
      resize.observe(element);
      view.attach = gl => {
        view.detach();
        gl.style.cssText = canvas.style.cssText; gl.tabIndex = 0;
        element.insertBefore(gl, canvas);
        canvas.style.display = "none";
        gl.addEventListener("click", click); gl.addEventListener("mousedown", press);
        view.gl = gl;
      };
      view.detach = () => {
        if (!view.gl) return;
        if (document.pointerLockElement === view.gl) document.exitPointerLock();
        view.gl.removeEventListener("click", click); view.gl.removeEventListener("mousedown", press);
        view.gl.remove();
        view.gl = null;
        canvas.style.display = "block";
      };
      view.release = () => {
        removeEventListener("keydown", down); removeEventListener("keyup", up); removeEventListener("blur", blur);
        canvas.removeEventListener("click", click); document.removeEventListener("mousemove", look);
        canvas.removeEventListener("mousedown", press); document.removeEventListener("pointerlockchange", lock);
        cross.remove(); hint.remove();
        resize.disconnect();
        if (locked()) document.exitPointerLock();
        view.detach();
        canvas.remove();
        if (this._view === view) this._view = null;
      };
      view.setActive = on => {
        view.active = !!on;
        if (!view.active) {
          if (locked()) document.exitPointerLock();
          if (view.keys.size) { view.keys.clear(); changed(); }
        }
        lock();
      };
      this._view = view;
      this._sizeView();
      if (this._viewer && this._viewer.scene) this._sceneAttach(this._viewer);   // a scene being drawn: here now
      return { release: () => view.release(), setActive: on => view.setActive(on), get active() { return view.active; }, canvas };
    }

    _sizeView() {
      const v = this._view;
      if (!v) return;
      const r = v.element.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      v.canvas.width = Math.max(2, Math.round(r.width * dpr)); v.canvas.height = Math.max(2, Math.round(r.height * dpr));
      v.resizeAt = 0;
      if (!(this._viewer && this._viewer.scene)) this._placeholder();
    }

    // Where the room visited will be, until its scene is drawn: what is happening, in words.
    _placeholder(text) {
      const v = this._view;
      if (!v) return;
      const { canvas, ctx } = v;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const say = text || (this.visiting && !(this._viewer && this._viewer.scene) ? `${this.visiting.link ? "looking into" : "walking into"} ${this.visiting.host.name || "their"}'s room…` : "");
      if (!say) return;
      const px = Math.max(14, Math.round(canvas.height / 30));
      ctx.fillStyle = "#e6edf3"; ctx.font = `${px}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(say, canvas.width / 2, canvas.height / 2);
    }
    // A click at the middle of the visitor's view: where it looks now (SPEC 8.3), at most one every POINT_MS.
    _pointNow() {
      const v = this._view, now = performance.now();
      if (!v || now - v.pointAt < POINT_MS) return;
      v.pointAt = now;
      this._send({ type: "point", yaw: v.yaw, pitch: v.pitch });
      if (v.cross) { v.cross.style.transform = "scale(1.6)"; setTimeout(() => { v.cross.style.transform = ""; }, 120); }
    }

    // What the crosshair is on, in the room visited: hot when the first thing there, or what it is part of, is
    // marked userData.visitPoint with a type the host takes (with its label beside it), or true (an older host's
    // mark). The visitor's own body never counts.
    _aim(s, now) {
      const v = this._view;
      if (!v || !v.cross || v.cross.style.display === "none" || now - (s.aimAt || 0) < AIM_MS) return;
      s.aimAt = now;
      if (!s.ray) { s.ray = new s.T.Raycaster(); s.mid = new s.T.Vector2(0, 0); }
      s.ray.setFromCamera(s.mid, s.camera);
      s.ray.camera = s.camera;
      const shown = o => { for (; o; o = o.parent) if (!o.visible || s.own.includes(o)) return false; return true; };
      let hot = false, label = "";
      for (const h of s.ray.intersectObject(s.root, true)) {
        if (!shown(h.object)) continue;
        for (let o = h.object; o; o = o.parent) {
          const p = o.userData && o.userData.visitPoint;
          if (p === true) { hot = true; break; }
          if (typeof p === "string") { const i = s.interactions.get(p); if (i) { hot = true; label = i.label; } break; }
        }
        break;
      }
      v.cross.style.background = hot ? "rgba(255,255,255,.95)" : "";
      if (v.hint && v.hint.textContent !== label) { v.hint.textContent = label; v.hint.style.display = label ? "block" : "none"; }
    }

    // The visitor's input: the state of its keys and look, whole each time (the newest wins; none is ever
    // queued). When it changes, now (at most every 8 ms; a change sooner goes on the next tick); and every
    // 33 ms regardless, so a host knows it is still held. `t` is this page's clock, which the host's frames
    // carry back: their age when drawn is the latency figure.
    _sendInput(now, changed) {
      const v = this._view;
      if (!v) return;
      if (v.resizeAt && now >= v.resizeAt) this._sizeView();
      if (!this._inRoom()) return;
      if (now - v.sentAt < (changed ? INPUT_MIN_MS : INPUT_MS)) { if (changed) v.pending = true; return; }
      v.sentAt = now; v.pending = false;
      const k = c => v.keys.has(c);
      this._send({ type: "input", forward: (k("KeyW") || k("ArrowUp") ? 1 : 0) - (k("KeyS") || k("ArrowDown") ? 1 : 0),
        strafe: (k("KeyD") || k("ArrowRight") ? 1 : 0) - (k("KeyA") || k("ArrowLeft") ? 1 : 0),
        run: k("ShiftLeft") || k("ShiftRight"), yaw: v.yaw, pitch: v.pitch, t: now });
    }

    // A delta of the scene of the room visited, or of a plot watched (SPEC 5.4).
    _frame(buf) {
      if (buf.byteLength < 11) return;
      if (new DataView(buf).getUint8(2) === AUDIO) return this._voiceIn(new DataView(buf).getUint16(0), new Uint8Array(buf, 11));
      const dv = new DataView(buf), w = this._viewing(dv.getUint16(0));
      if (w) this._sceneDelta(w, dv, (dv.getUint8(2) & KEY) !== 0);
    }

    // Stepping onto a plot refused by its host (full), or ended by a visit elsewhere: back where this was before. A
    // link's: in the corner again.
    _enterRefused(m) {
      const l = this._links.get(m.channel);
      if (l && l.where !== "world") {
        l.inside = false;
        if (this.visiting && this.visiting.id === l.id) this.visiting.inside = false;
        if (m.reason !== "moved") this._emit("error", { code: "enter_refused", message: `${l.host.name || "their"} room: ${m.reason || "refused"}` });
        return;
      }
      const w = this._watches.get(m.channel);
      if (!w) return;
      w.inside = false;
      if (this._world) this._world._refused(w, m.reason);
      this._emit("error", { code: "enter_refused", message: `${w.host.name || "that"} plot: ${m.reason || "refused"}` });
    }

    _dropViewer() {
      const w = this._viewer;
      this._sceneDrop(w);
      this._viewer = null;
      this.stats = { latency: null, rtt: null, path: null, fps: 0 };
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

  // ---------- the world (../../WORLD.md): friends' plots around your room, and walking onto them ----------
  // A side of a plot, by where it faces in the plot's own terms; turning left a (radians) on the floor.
  const SIDE_NORMAL = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
  const turnXZ = (x, z, a) => [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)];
  const MAX_PLOT = 200, WORLD_GAP = 4, ENTER_WAIT = 3000;

  // A plot as a host says it ({ center: [x, z], size: [w, d] }, in its scene's units), or, not said, what its
  // scene covers (at most MAX_PLOT a side).
  function plotOf(plot, root, T) {
    if (isObj(plot) && Array.isArray(plot.center) && Array.isArray(plot.size)) {
      const [cx, cz] = plot.center.map(Number), [w, d] = plot.size.map(Number);
      if ([cx, cz, w, d].every(Number.isFinite) && w > 0 && d > 0) return { center: [cx, cz], size: [Math.min(w, 1e4), Math.min(d, 1e4)] };
    }
    if (!root || !T) return { center: [0, 0], size: [10, 10] };
    const b = new T.Box3().setFromObject(root);
    if (b.isEmpty()) return { center: [0, 0], size: [10, 10] };
    return { center: [(b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2], size: [Math.min(MAX_PLOT, b.max.x - b.min.x || 1), Math.min(MAX_PLOT, b.max.z - b.min.z || 1)] };
  }

  // Lights the old way (before r155, three.js multiplied lights by pi; r155 to r164 could still): from a renderer,
  // or the settings a host sent of its own.
  function legacyLights(rev, r) {
    if (rev >= 165) return false;
    if (r && typeof r.useLegacyLights === "boolean") return r.useLegacyLights;
    if (r && typeof r.physicallyCorrectLights === "boolean") return !r.physicallyCorrectLights;
    return rev < 155;
  }
  // A plot lit one way drawn in a page lit the other keeps roughly its look: its lights' strength times pi (or
  // over it), and its bulbs no longer dimming with distance as the old way's did not. Approximate, on purpose.
  function relight(root, theirsLegacy, mineLegacy) {
    if (theirsLegacy === mineLegacy) return;
    root.traverse(o => {
      if (!o.isLight) return;
      if (theirsLegacy) { o.intensity *= Math.PI; if (o.isPointLight || o.isSpotLight) o.decay = 0; } else o.intensity /= Math.PI;
    });
  }

  // The interactions a host takes, as its scene says them: type -> { label, cosmetic }.
  const interMap = list => new Map((Array.isArray(list) ? list : []).filter(i => isObj(i) && typeof i.type === "string")
    .map(i => [i.type, { label: String(i.label || i.type).slice(0, 60), cosmetic: i.cosmetic === true }]));

  const hashKey = k => { let h = 2166136261; for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619); return h >>> 0; };
  // A rectangle on the floor, [x0, z0, x1, z1]; plots are only ever turned by quarter turns, so it is one.
  const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const within = (r, x, z) => x > r[0] && x < r[2] && z > r[1] && z < r[3];

  // Your world: your own room, at home in its own coordinates, and each plot you watch (a guest's, whose door is
  // open to you) where your layout puts it: an edge you agreed, else where you placed it, else a ring round yours.
  // You walk in your own room with your own walking; step onto a plot and you are in its owner's room (it moves
  // you, by its walls), drawn there by your page as yourself; walk off it and you are home again.
  //
  //   const world = v.world({ scene, renderer });   // your whole scene, and its renderer (default: host()'s)
  //   every frame:  const me = world.frame(dt, { x, y, z, yaw, pitch }, { forward, strafe, run });
  //                 (where your page has its user, in its room's terms, and what they press; `me` is where they
  //                 are now: at home as you said, or in a plot as its host has them, `me.in` = { key, name })
  //                 world.render(camera);   (instead of renderer.render(scene, camera))
  class World {
    constructor(v, { scene, renderer, ground = 0x30363d, gap = WORLD_GAP, clipOwn = true } = {}) {
      const hk = v._hooks;
      if (!hk) throw new Error("visit.world: v.host first (the world is drawn with your three.js, round your plot)");
      this.v = v; this.T = hk.scene.three;
      this.scene = scene || (hk.scene.root.isScene ? hk.scene.root : null);
      this.renderer = renderer || hk.scene.renderer;
      if (!this.scene || !this.renderer) throw new Error("visit.world needs { scene, renderer }: your whole scene, and the renderer that draws it");
      Object.assign(this, { gap: Number(gap) >= 0 ? Number(gap) : WORLD_GAP, clipOwn: clipOwn !== false, in: null, home: null, bounce: null, yHome: null,
        refused: new Map(), holders: new Map(), sent: { at: 0, sig: "" }, look: { yaw: 0, pitch: 0 }, list: [], listAt: -1, plots: [] });
      const T = this.T;
      this.commons = new T.Scene();   // the ground between plots, and the outlines of agreed neighbours not seen
      if (ground !== null) {
        const g = new T.Mesh(new T.PlaneGeometry(4000, 4000), new T.MeshBasicMaterial({ color: ground }));
        g.rotation.x = -Math.PI / 2; g.position.y = -0.02; g.name = "visit:commons";
        this.commons.add(g);
      }
      this.outlines = new T.Group(); this.commons.add(this.outlines); this.outlineSig = "";
      v._world = this;
      v._send({ type: "world", on: true });
      for (const w of [...v._links.values()]) if (w.wantWorld) v.toWorld(w.id);   // links that were in it before this page reloaded
      v._guestLinksToWorld();   // a guest's link already in the corner: its plot now there is a world
    }

    get inside() { return this.in != null; }

    // Every plot, placed: watched ones (with their scenes), and agreed neighbours not watched (an outline).
    _layout() {
      const now = performance.now();
      if (now - this.listAt < 4) return this.list;   // once a frame
      const v = this.v, mine = v._plot(), unit = v._unit(), taken = [], out = [], wait = [];
      taken.push([mine.center[0] - mine.size[0] / 2, mine.center[1] - mine.size[1] / 2, mine.center[0] + mine.size[0] / 2, mine.center[1] + mine.size[1] / 2]);
      const xs = [];
      for (const w of v._watches.values()) if (w.scene && w.host.key) xs.push({ key: w.host.key, name: w.host.name || "", w, plot: w.scene.plot, k: w.scene.unit / unit });
      for (const e of v.edges) if (!xs.some(x => x.key === e.key)) xs.push({ key: e.key, name: e.name, w: null, plot: { center: [0, 0], size: e.size }, k: 1 / unit });
      for (const x of xs) {
        const edge = v.edges.find(e => e.key === x.key), placed = v.layout.find(p => p.key === x.key);
        x.edge = !!edge;
        x.at = edge ? this._fromEdge(edge, x, mine, unit) : placed ? { x: placed.x, z: placed.z, turn: placed.turn | 0 } : null;
        if (x.at) { x.rect = this._rect(x); taken.push(x.rect); out.push(x); } else wait.push(x);
      }
      // The rest by themselves: round yours, each in the first of eight places (from one its key picks) it fits.
      wait.sort((a, b) => a.key < b.key ? -1 : 1);
      const R = Math.hypot(...mine.size) / 2;
      for (const x of wait) {
        const r = Math.hypot(...x.plot.size) * x.k / 2, first = hashKey(x.key) % 8;
        for (let i = 0; i < 64; i++) {
          const a = ((first + i) % 8) * Math.PI / 4, ring = Math.floor(i / 8), d = R + r + this.gap + ring * (2 * r + this.gap);
          x.at = { x: mine.center[0] + Math.cos(a) * d, z: mine.center[1] - Math.sin(a) * d, turn: 0 };
          x.rect = this._rect(x);
          if (!taken.some(t => overlap(t, x.rect))) break;
        }
        taken.push(x.rect); out.push(x);
      }
      this.list = out; this.listAt = now;
      this.plots = out.map(x => ({ key: x.key, name: x.name, at: x.at, rect: x.rect, seen: !!x.w, edge: x.edge, inside: !!(x.w && x.w.inside) }));
      return out;
    }

    // Where an agreed edge puts a friend's plot: their side against yours, facing it, their middle `along` metres
    // from yours (along your side, turning left).
    _fromEdge(e, x, mine, unit) {
      const n = SIDE_NORMAL[e.mine], nt = SIDE_NORMAL[e.theirs];
      if (!n || !nt) return null;
      let turn = 0;
      for (; turn < 4; turn++) { const [a, b] = turnXZ(nt[0], nt[1], turn * Math.PI / 2); if (Math.abs(a + n[0]) < 1e-6 && Math.abs(b + n[1]) < 1e-6) break; }
      const mid = [mine.center[0] + n[0] * mine.size[0] / 2, mine.center[1] + n[1] * mine.size[1] / 2];
      const ext = (e.theirs === "east" || e.theirs === "west" ? x.plot.size[0] : x.plot.size[1]) * x.k / 2, t = turnXZ(n[0], n[1], Math.PI / 2), along = (Number(e.along) || 0) / unit;
      return { x: mid[0] + n[0] * ext + t[0] * along, z: mid[1] + n[1] * ext + t[1] * along, turn: turn % 4 };
    }

    _rect(x) {
      const odd = x.at.turn % 2 === 1, hw = (odd ? x.plot.size[1] : x.plot.size[0]) * x.k / 2, hd = (odd ? x.plot.size[0] : x.plot.size[1]) * x.k / 2;
      return [x.at.x - hw, x.at.z - hd, x.at.x + hw, x.at.z + hd];
    }

    // A plot's scene in this world: turned and scaled into place (its middle where the layout says), its fog too.
    _holder(x) {
      const T = this.T, w = x.w, s = w.scene;
      let h = this.holders.get(w.channel);
      if (!h || h.s !== s) {
        if (h && h.s.root.parent === h.place) h.place.remove(h.s.root);
        const holder = new T.Scene(), place = new T.Group();
        place.matrixAutoUpdate = false; holder.add(place); place.add(s.root);
        h = { holder, place, s, sig: "", fog: undefined, inverse: new T.Matrix4(), planes: [] };
        this.holders.set(w.channel, h);
      }
      const sig = [x.at.x, x.at.z, x.at.turn, x.k].join();
      if (sig !== h.sig) {
        h.sig = sig;
        const m = new T.Matrix4().makeTranslation(x.at.x, 0, x.at.z).multiply(new T.Matrix4().makeRotationY(x.at.turn * Math.PI / 2))
          .multiply(new T.Matrix4().makeScale(x.k, x.k, x.k)).multiply(new T.Matrix4().makeTranslation(-x.plot.center[0], 0, -x.plot.center[1]));
        h.place.matrix.copy(m); h.place.matrixWorldNeedsUpdate = true;
        h.inverse.copy(m).invert();
        const [x0, z0, x1, z1] = x.rect;
        h.planes = [new T.Plane(new T.Vector3(1, 0, 0), -x0), new T.Plane(new T.Vector3(-1, 0, 0), x1), new T.Plane(new T.Vector3(0, 0, 1), -z0), new T.Plane(new T.Vector3(0, 0, -1), z1)];
      }
      const f = s.root.fog;
      if (h.fog !== f || h.fogK !== x.k) {
        h.fog = f; h.fogK = x.k;
        h.holder.fog = !f ? null : f.isFogExp2 ? new T.FogExp2(f.color.getHex(), f.density / x.k) : new T.Fog(f.color.getHex(), f.near * x.k, f.far * x.k);
      }
      return h;
    }

    _forget(w) {
      const h = this.holders.get(w.channel);
      if (h && h.s.root.parent === h.place) h.place.remove(h.s.root);
      this.holders.delete(w.channel);
      if (this.in === w.channel) this.in = null;
      this.listAt = -1;
    }

    // Agreed neighbours whose plots are not seen (their door shut to you, or away): where they are, and who.
    _outlines(list) {
      const T = this.T, unseen = list.filter(x => !x.w), sig = unseen.map(x => [x.key, x.name, ...x.rect].join()).join("|");
      if (sig === this.outlineSig) return;
      this.outlineSig = sig;
      for (const o of [...this.outlines.children]) { this.outlines.remove(o); o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); } }); }
      for (const x of unseen) {
        const [x0, z0, x1, z1] = x.rect, y = 0.02;
        const g = new T.BufferGeometry().setFromPoints([[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([a, b]) => new T.Vector3(a, y, b)));
        this.outlines.add(new T.LineLoop(g, new T.LineBasicMaterial({ color: 0x8b949e })));
        const c = document.createElement("canvas"); c.width = 256; c.height = 64;
        const cx = c.getContext("2d"); cx.font = "28px system-ui, sans-serif"; cx.fillStyle = "#e6edf3"; cx.textAlign = "center"; cx.fillText(x.name || "?", 128, 42);
        const label = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true, depthWrite: false }));
        label.position.set((x0 + x1) / 2, 1.5, (z0 + z1) / 2); label.scale.set(4, 1, 1);
        this.outlines.add(label);
      }
    }

    // Where your user is now: at home, where your page says (stepping onto a plot takes them in); in a plot, where
    // its host has them (walked at once as it walks, put right by its answers), until it has them off it.
    frame(dt, me, input = {}) {
      const v = this.v, T = this.T, now = performance.now();
      dt = Math.min(0.1, Math.max(0, Number(dt) || 0));
      me = { x: Number(me.x) || 0, y: Number(me.y) || 0, z: Number(me.z) || 0, yaw: Number(me.yaw) || 0, pitch: Number(me.pitch) || 0 };
      this.look = { yaw: me.yaw, pitch: me.pitch };
      if (this.bounce) { const b = this.bounce; this.bounce = null; this.home = b; return Object.assign({}, b, { yaw: me.yaw, pitch: me.pitch, in: null }); }
      const list = this._layout();
      let x = this.in != null ? list.find(y => y.w && y.w.channel === this.in) : null;
      if (x && !(x.w.inside && x.w.scene)) x = null;
      if (!x) {
        // Out of a plot by any way but walking off it (its door shut, its page gone, leave()): home at the height we
        // came with, not one its host had us at, which a page that keeps the y it is given would otherwise keep.
        if (this.yHome != null) { me.y = this.yHome; this.yHome = null; }
        this.in = null;
        x = list.find(y => y.w && y.w.scene && !y.w.inside && (this.refused.get(y.w.channel) || 0) <= now && within(y.rect, me.x, me.z));
        if (!x) { this.home = me; return Object.assign({}, me, { in: null }); }
        this._enter(x, me, now);
      }
      const w = x.w, s = w.scene, h = this._holder(x), yaw = me.yaw - x.at.turn * Math.PI / 2;
      const inp = { forward: Math.sign(Number(input.forward) || 0), strafe: Math.sign(Number(input.strafe) || 0), run: !!input.run };
      if (s.walk && !w.paused) { const q = walk({ x: s.pose.x, z: s.pose.z, yaw }, inp, dt, s.walk); s.pose.x = q.x; s.pose.z = q.z; }
      s.hist.push([now, s.pose.x, s.pose.z]);
      while (s.hist.length > 2 && now - s.hist[0][0] > 2000) s.hist.shift();
      const fade = Math.exp(-dt / 0.1); s.vis.x *= fade; s.vis.y *= fade; s.vis.z *= fade;
      this._input(w, inp, yaw, me.pitch, now);
      const hp = s.hostPose, pl = s.plot, margin = 0.3 / x.k;
      if (hp && s.yBase == null) { s.yBase = s.pose.y; s.vis.y = 0; }   // the height its host first had us at: where we stepped on
      if (!hp && now - s.inAt > ENTER_WAIT) { this._refused(w, "no answer"); return this.frame(0, me, {}); }   // its host never had us: back out
      if (hp && (Math.abs(hp.x - pl.center[0]) > pl.size[0] / 2 + margin || Math.abs(hp.z - pl.center[1]) > pl.size[1] / 2 + margin)) {
        this._exit(w);   // its host has us off its plot: home again, walking on from there
        const out = new T.Vector3(hp.x, 0, hp.z).applyMatrix4(h.place.matrix);
        this.home = { x: out.x, y: this.yHome, z: out.z, yaw: me.yaw, pitch: me.pitch };
        this.yHome = null;
        return Object.assign({}, this.home, { in: null });
      }
      const at = new T.Vector3(s.pose.x + s.vis.x, 0, s.pose.z + s.vis.z).applyMatrix4(h.place.matrix);
      // Up or down as its host has us (a stair, a lift), from where we stepped on, in this world's units; the height
      // we came with stays ours, so a page that keeps the y it is given rises no further.
      const rise = s.yBase == null ? 0 : (s.pose.y + s.vis.y - s.yBase) * x.k;
      return { x: at.x, y: this.yHome + rise, z: at.z, yaw: me.yaw, pitch: me.pitch, in: { key: x.key, name: x.name } };
    }

    _enter(x, me, now) {
      const w = x.w, s = w.scene, h = this._holder(x), p = new this.T.Vector3(me.x, 0, me.z).applyMatrix4(h.inverse), yaw = me.yaw - x.at.turn * Math.PI / 2;
      this.v._send({ type: "enter", channel: w.channel, pose: { x: p.x, y: me.y / x.k, z: p.z, yaw } });
      w.inside = true; this.in = w.channel;
      Object.assign(s, { pose: { x: p.x, y: 0, z: p.z }, yaw0: 0, hist: [], vis: { x: 0, y: 0, z: 0 }, hostPose: null, inAt: now, yBase: null });
      this.yHome = me.y;
      this.v._changed();
    }

    _exit(w) {
      this.v._send({ type: "exit", channel: w.channel });
      w.inside = false; this.in = null;
      if (w.scene) w.scene.hostPose = null;
      this.v._changed();
    }

    _refused(w, why) {
      if (w.inside) this._exit(w);
      w.inside = false;
      if (this.in === w.channel) this.in = null;
      this.refused.set(w.channel, performance.now() + ENTER_WAIT);
      this.bounce = this.home;   // back where it was before it stepped on
    }

    // The input while in a plot, in its terms (its look absolute: it came from a world): on every change (at most
    // every 8 ms) and every 33 ms regardless.
    _input(w, inp, yaw, pitch, now) {
      const sig = [inp.forward, inp.strafe, inp.run, yaw.toFixed(3), pitch.toFixed(3)].join();
      if (now - this.sent.at < (sig !== this.sent.sig ? INPUT_MIN_MS : INPUT_MS)) return;
      this.sent = { at: now, sig };
      this.v._send({ type: "input", forward: inp.forward, strafe: inp.strafe, run: inp.run, yaw, pitch: Math.max(-1.4, Math.min(1.4, pitch)), t: now });
    }

    // While in a plot: point where you look (SPEC 8.3). Home: out of the plot you are in.
    point() {
      const x = this.in != null && this.list.find(y => y.w && y.w.channel === this.in);
      if (!x) return false;
      this.v._send({ type: "point", yaw: this.look.yaw - x.at.turn * Math.PI / 2, pitch: this.look.pitch });
      return true;
    }
    leave() { const w = this.in != null && this.v._watches.get(this.in); if (w) this._exit(w); }

    // Your room (clipped to your plot), the ground between plots, then each plot (clipped to its own), into one
    // depth buffer: what is nearer hides what is behind, across plots. Each plot lit by its own lights.
    render(camera) {
      const r = this.renderer, auto = r.autoClear, planes = r.clippingPlanes, now = performance.now(), v = this.v;
      const list = this._layout(), mine = v._plot();
      try {
        r.clippingPlanes = !this.clipOwn ? [] : (() => {
          const T = this.T, x0 = mine.center[0] - mine.size[0] / 2, x1 = mine.center[0] + mine.size[0] / 2, z0 = mine.center[1] - mine.size[1] / 2, z1 = mine.center[1] + mine.size[1] / 2;
          const sig = [x0, z0, x1, z1].join();
          if (this.mineSig !== sig) { this.mineSig = sig; this.minePlanes = [new T.Plane(new T.Vector3(1, 0, 0), -x0), new T.Plane(new T.Vector3(-1, 0, 0), x1), new T.Plane(new T.Vector3(0, 0, 1), -z0), new T.Plane(new T.Vector3(0, 0, -1), z1)]; }
          return this.minePlanes;
        })();
        r.render(this.scene, camera);
        r.autoClear = false;
        r.clippingPlanes = [];
        this._outlines(list);
        this.commons.fog = this.scene.fog || null;
        r.render(this.commons, camera);
        for (const x of list) {
          if (!x.w || !x.w.scene) continue;
          const h = this._holder(x), s = x.w.scene;
          if (s.offset !== null) v._sceneInterp(s, now - s.offset - INTERP_MS);
          for (const o of s.own) o.visible = false;
          r.clippingPlanes = h.planes;
          r.render(h.holder, camera);
          if (now - s.gcAt > 30000) { s.gcAt = now; v._sceneGc(s); }   // what its room no longer uses, freed
        }
      } finally { r.autoClear = auto; r.clippingPlanes = planes; }
    }

    release() {
      this.leave();
      for (const w of this.v._watches.values()) this._forget(w);
      this.v._send({ type: "world", on: false });
      if (this.v._world === this) this.v._world = null;
    }
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
.visit-panel button.star { border: 0; background: none; padding: 0 2px; color: #6e7681; font-size: 14px; line-height: 1; }
.visit-panel button.star.on { color: #e3b341; }
.visit-panel .knock label { display: flex; align-items: center; gap: 4px; color: #7a4a00; }
.visit-panel .lnk { display: block; } .visit-panel .lnk .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.visit-panel .speaking { color: #3fb950; } .visit-panel button.on { background: #9e2f2f; border-color: #9e2f2f; color: #fff; }
.visit-panel .knock input[type=checkbox] { flex: none; }
.visit-panel input { flex: 1; min-width: 0; }`;

  function panel(element, v) {
    if (!document.getElementById("visit-panel-css")) {
      const st = document.createElement("style"); st.id = "visit-panel-css"; st.textContent = PANEL_CSS; document.head.appendChild(st);
    }
    const root = document.createElement("div");
    root.className = "visit-panel";
    element.appendChild(root);
    let composing = null, timer = null, drawn = "";
    const always = new Set();   // links on your door to let in for good (a guest, ★), as you answer them
    function draw() {
      if (root.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // never under a typing hand
      const me = v.office, rows = [];
      rows.push(`<div class="row hd"><span class="dot ${v.state === "online" ? esc(v.status) : ""}"></span><span class="grow">Visit${me ? " · " + esc(me.name) : ""}</span><span class="muted">${esc(v.state)}</span>${v.state === "online" ? `<button data-v="away" title="leave the lobby: nobody sees you or can link until you come back">Go offline</button>` : ""}</div>`);
      if (v.state === "away") rows.push(`<div class="row"><span class="grow muted">out of the lobby: nobody sees you or can link</span><button class="go" data-v="back">Go online</button></div>`);
      if (v.state === "online") {
        rows.push(`<div class="row"><span class="grow">you are</span><select data-v="status">${["available", "busy"].map(s => `<option${s === v.status ? " selected" : ""}>${s}</option>`).join("")}</select>
          <select data-v="max" title="how many visitors at once">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}"${n === v.maxVisitors ? " selected" : ""}>${n} visitors</option>`).join("")}</select></div>`);
        rows.push(`<div class="row"><span class="grow">your door</span><select data-v="door" title="open: your guests (★) link and walk in without asking">
          <option value="open"${v.door === "open" ? " selected" : ""}>open to guests</option><option value="closed"${v.door === "closed" ? " selected" : ""}>closed: everyone asks</option></select>
          <span class="muted">${v.guests.length} ★</span></div>`);
        rows.push(`<div class="row"><span class="grow">visitors look like</span><select data-v="looks" title="in your room: the look each one brings (their avatar), or your own models; a friend can be set apart">
          <option value="mine"${v.avatars.default === "mine" ? " selected" : ""}>your models</option><option value="theirs"${v.avatars.default === "theirs" ? " selected" : ""}>their own avatars</option></select></div>`);
      }
      // A star: whether this key is a guest (click to change); nothing for an office with no key yet.
      const star = (key, name) => !key ? "" : `<button class="star${v.isGuest(key) ? " on" : ""}" data-v="guest" data-key="${esc(key)}" data-name="${esc(name)}"
        title="${v.isGuest(key) ? `a guest: links and walks in without asking while your door is open (click: no longer)` : `make ${esc(name)} a guest: in without asking while your door is open`}">${v.isGuest(key) ? "★" : "☆"}</button>`;
      for (const k of v.knocks) {
        const forGood = k.link && k.from.key && !v.isGuest(k.from.key)
          ? `<label title="make ${esc(k.from.name)} a guest: in without asking from now on, while your door is open"><input type="checkbox" data-v="always" data-k="${esc(k.id)}"${always.has(k.id) ? " checked" : ""}>★ always</label>` : "";
        rows.push(`<div class="row knock"><b>${esc(k.from.name)}</b> ${k.link ? "wants to link" : "is knocking"}${k.message ? `: “${esc(k.message)}”` : ""}
          <div class="btns"><button class="go" data-v="in" data-k="${esc(k.id)}">${k.link ? "Link" : "Let in"}</button><button data-v="out" data-k="${esc(k.id)}">Not now</button>
          ${forGood}<span class="muted">${Math.max(0, Math.round((k.until - Date.now()) / 1000))}s</span></div></div>`);
      }
      for (const p of v.edgeProposals) {
        rows.push(`<div class="row knock"><b>${esc(p.name)}</b> proposes their plot's ${esc(p.theirs)} side against your ${esc(p.mine)} side
          <div class="btns"><button class="go" data-v="edge_yes" data-key="${esc(p.key)}">Agree</button><button data-v="edge_no" data-key="${esc(p.key)}">No</button></div></div>`);
      }
      // The huddle (8.7): voice with those you are linked to who are in it too.
      if (v.state === "online") {
        if (!v.huddling) rows.push(`<div class="row"><span class="grow">huddle <span class="muted">· voice with those you are linked to</span></span><button data-v="huddle" title="your microphone, to everyone linked to you who joins too (headphones are best)">Join huddle</button></div>`);
        else rows.push(`<div class="row lnk"><div>in the huddle${v.huddlers.length ? ": " + v.huddlers.map(h => `<b class="${h.speaking ? "speaking" : ""}">${h.speaking ? "🔊 " : ""}${esc(h.name)}</b>`).join(", ") : ` <span class="muted">(nobody else yet: those linked to you who join)</span>`}</div>
          <div class="btns"><button data-v="mute" class="${v.muted ? "on" : ""}">${v.muted ? "Unmute" : "Mute"}</button><button data-v="unhuddle">Leave</button></div></div>`);
      }
      if (v._world && v.state === "online") rows.push(`<div class="row"><span class="grow">your world: ${v._world.plots.length} ${v._world.plots.length === 1 ? "room" : "rooms"} round yours</span><button data-v="map" title="where your friends' rooms sit round yours, from above">Map</button></div>`);
      if (v.visiting && !v.visiting.link) rows.push(`<div class="row"><span class="grow">in <b>${esc(v.visiting.host.name)}</b>'s room${v.visiting.paused ? " (reloading)" : ""}</span><button data-v="leave">Leave</button></div>`);
      // Your links: in the corner (go there, or into your world), in their room, waiting for the corner, in your world.
      for (const l of v.links) {
        const n = `<b>${esc(l.host.name)}</b>`, id = esc(l.id), un = `<button data-v="unlink" data-x="${id}" title="the link ends: their room goes">Unlink</button>`;
        rows.push(`<div class="row lnk"><div>${
          l.where === "world" ? `${n}'s room is in your world` : l.where === "aside" ? `linked with ${n} <span class="muted">(waiting for the corner)</span>`
          : l.inside ? `in ${n}'s room` : `linked with ${n}: their room is in the corner`}</div><div class="btns">${
          l.where === "aside" ? `<button data-v="show" data-x="${id}">Show</button>`
          : l.where === "corner" && l.inside ? `<button data-v="step_out" data-x="${id}" title="your own room; theirs back in the corner">Back to my room</button>`
          : l.where === "corner" ? `<button class="go" data-v="step_in" data-x="${id}" title="walk into their room">Go there</button>${v._world ? `<button data-v="to_world" data-x="${id}" title="their room as a plot beside yours, walked onto">Put in my world</button>` : ""}` : ""}${un}</div></div>`);
      }
      // Whose look a visitor has in your room: click to set them apart from your default (8.6).
      const look = (key, name) => !key ? "" : (u => `<button data-v="look" data-key="${esc(key)}" data-use="${u === "theirs" ? "mine" : "theirs"}"
        title="${u === "theirs" ? `${esc(name)} looks like their own avatar here (click: your model)` : `${esc(name)} looks like your model here (click: their own avatar)`}">${u === "theirs" ? "their look" : "your model"}</button>`)(v.avatarUse(key));
      for (const x of v.visitors) rows.push(`<div class="row">${star(x.visitor.key, x.visitor.name)}<span class="grow"><b>${esc(x.visitor.name)}</b> ${x.guest && !x.link ? "walked in" : "is visiting"}</span>${look(x.visitor.key, x.visitor.name)}<button data-v="kick" data-x="${esc(x.id)}">Kick</button></div>`);
      // Who sees your room from outside it: links (unlink them here) and your guests' worlds (un-star them to stop it).
      for (const x of v.watchers) {
        if (x.inside) continue;
        rows.push(`<div class="row">${star(x.visitor.key, x.visitor.name)}<span class="grow"><b>${esc(x.visitor.name)}</b> ${x.link ? "is linked: sees your room" : "sees your plot from their world"}</span>${look(x.visitor.key, x.visitor.name)}${
          x.link ? `<button data-v="kick" data-x="${esc(x.id)}">Unlink</button>` : ""}</div>`);
      }
      for (const o of v.offices) {
        if (me && o.id === me.id) continue;
        const word = o.links ? "Link" : "Knock", asking = v.knocking.some(k => k.to === o.id);
        const why = !o.ready ? "not ready" : o.status !== "available" ? o.status : !o.links && o.visitors >= o.maxVisitors ? "full"
          : v.visiting && v.visiting.host.id === o.id ? "you are there" : v.links.some(l => l.host.id === o.id) ? "linked"
          : v.watching(o.id) ? "in your world" : asking ? "asking…" : "";
        rows.push(`<div class="row"><span class="dot ${esc(o.status)}"></span>${star(o.key, o.name)}<span class="grow" title="${esc(o.name)}">${esc(o.name)} <span class="muted">${esc(o.sim.name || "")} ${o.visitors}/${o.maxVisitors}</span></span>
          <button data-v="knock" data-o="${esc(o.id)}" ${why ? `disabled title="${esc(why)}"` : `title="${o.links ? "see their room in a corner, once they say yes: then go there, or put it in your world" : "an older Visit: you walk into their room once they say yes"}"`}>${asking ? `${word}ing…` : word}</button></div>`);
        if (composing === o.id) rows.push(`<form class="row" data-o="${esc(o.id)}"><input maxlength="280" placeholder="a message for ${esc(o.name)}"><button class="go">${word}</button></form>`);
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
      else if (act === "in" || act === "out") {
        const k = v.knocks.find(x => x.id === b.dataset.k);
        if (act === "in" && k && always.has(k.id) && k.from.key) v.addGuest(k.from.key, k.from.name);
        always.delete(b.dataset.k);
        v.answer(b.dataset.k, act === "in");
      }
      else if (act === "leave") v.leave();
      else if (act === "map") (v._mapView || (v._mapView = map(v))).open();
      else if (act === "huddle") v.huddle(true).catch(x => v._emit("error", { code: "huddle", message: String(x.message || x) }));
      else if (act === "mute") v.mute(!v.muted);
      else if (act === "unhuddle") v.huddle(false);
      else if (act === "look") v.useAvatar(b.dataset.key, b.dataset.use === v.avatars.default ? null : b.dataset.use);
      else if (act === "unlink") v.unlink(b.dataset.x);
      else if (act === "step_in") v.stepIn(b.dataset.x);
      else if (act === "step_out") v.stepOut(b.dataset.x);
      else if (act === "to_world") v.toWorld(b.dataset.x);
      else if (act === "show") v._toCorner(v._link(b.dataset.x)), v._changed();
      else if (act === "kick") v.kick(b.dataset.x);
      else if (act === "away") v.leaveLobby();
      else if (act === "back") v.joinLobby();
      else if (act === "guest") v.isGuest(b.dataset.key) ? v.removeGuest(b.dataset.key) : v.addGuest(b.dataset.key, b.dataset.name);
      else if (act === "edge_yes") v.acceptEdge(b.dataset.key);
      else if (act === "edge_no") v.declineEdge(b.dataset.key);
    });
    root.addEventListener("change", e => {
      if (e.target.dataset.v === "always") { if (e.target.checked) always.add(e.target.dataset.k); else always.delete(e.target.dataset.k); }
      if (e.target.dataset.v === "status") v.setStatus(e.target.value);
      if (e.target.dataset.v === "max") v.setMaxVisitors(Number(e.target.value));
      if (e.target.dataset.v === "door") v.setDoor(e.target.value === "open");
      if (e.target.dataset.v === "looks") v.useAvatars(e.target.value);
    });
    root.addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target.closest("form"), o = v.offices.find(x => x.id === f.dataset.o);
      (o && o.links ? v.link : v.knock).call(v, f.dataset.o, f.querySelector("input").value.trim());
      composing = null;
      f.querySelector("input").blur();
      draw();
    });
    root.addEventListener("focusout", () => setTimeout(draw, 0));
    v.on("change", draw);
    timer = setInterval(() => { if (v.knocks.length) draw(); }, 1000);   // the knocks' countdown
    const speaking = setInterval(() => { if (v.huddling) { v._huddlersList(); draw(); } }, 250);   // who is speaking
    draw();
    return { element: root, release() { clearInterval(timer); clearInterval(speaking); v.off("change", draw); root.remove(); } };
  }

  // ---------- your world's map: where friends' rooms sit round yours, seen from above ----------
  const MAP_CSS = `
.visit-map { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: rgba(1,4,9,.55); font: 12px/1.4 ui-monospace, Consolas, monospace; color: #e6edf3; }
.visit-map[hidden] { display: none; }
.visit-map .box { width: min(1000px, 94vw); height: min(680px, 88vh); display: flex; flex-direction: column; background: #0d1117; border: 1px solid #2d333b; border-radius: 10px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
.visit-map .hd { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #2d333b; }
.visit-map .ft { padding: 6px 12px; border-top: 1px solid #2d333b; color: #8b949e; }
.visit-map .grow { flex: 1; min-width: 0; } .visit-map .muted { color: #8b949e; }
.visit-map .main { flex: 1; display: flex; min-height: 0; }
.visit-map canvas { flex: 1; min-width: 0; display: block; cursor: grab; background: #161b22; touch-action: none; outline: none; }
.visit-map .side { width: 250px; flex: none; border-left: 1px solid #2d333b; padding: 10px 12px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.visit-map button, .visit-map input { font: inherit; color: inherit; background: #161b22; border: 1px solid #2d333b; border-radius: 6px; padding: 3px 8px; }
.visit-map button { cursor: pointer; } .visit-map button.go { background: #2f9e4f; border-color: #2f9e4f; color: #fff; }
.visit-map button.pick { text-align: left; } .visit-map input { width: 76px; }
.visit-map .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }`;

  // Your world from above (v.world first): your room's plot, and each friend's where your layout puts it. Drag one
  // to put it there (it snaps to half units, and flush against what is near), turn it, or type where its middle
  // goes; flush against a side of yours, propose an edge (both must agree: then it is there for both). What you
  // place is kept by visit-client (with VISIT_STATE_FILE, across reloads and restarts); a room with an agreed edge
  // is where the edge puts it. { element, open(), close(), release() }
  function map(v, { parent = document.body } = {}) {
    if (!document.getElementById("visit-map-css")) {
      const st = document.createElement("style"); st.id = "visit-map-css"; st.textContent = MAP_CSS; document.head.appendChild(st);
    }
    const root = document.createElement("div");
    root.className = "visit-map"; root.hidden = true;
    root.innerHTML = `<div class="box"><div class="hd"><b>Your world</b><span class="grow muted">where your friends' rooms sit round yours: your layout (theirs is theirs)</span>`
      + `<button type="button" data-m="fit">Fit</button><button type="button" data-m="close">Close</button></div>`
      + `<div class="main"><canvas tabindex="0"></canvas><div class="side"></div></div>`
      + `<div class="ft">drag a room to move it · R turns it right (Shift+R left) · Delete: back to the ring · drag the ground to look about, the wheel to zoom</div></div>`;
    parent.appendChild(root);
    const canvas = root.querySelector("canvas"), side = root.querySelector(".side"), ctx = canvas.getContext("2d");
    const pending = new Map();   // key -> where you just put it, until the layout says so
    const proposed = new Set();  // keys you proposed an edge to, waiting
    let view = null, sel = null, drag = null, pan = null, timer = 0, sideSig = "";

    // Your plot, and each friend's as the world lays it out now (what you just moved where you put it).
    function plots() {
      const w = v._world;
      if (!w) return null;
      w.listAt = -1;   // laid out anew, not the frame's: a placement kept a moment ago is in it
      w._layout();
      for (const [key, p] of pending) {
        const l = v.layout.find(q => q.key === key);
        if (l && Math.abs(l.x - p.x) < 1e-6 && Math.abs(l.z - p.z) < 1e-6 && (l.turn | 0) === p.turn) pending.delete(key);
      }
      const mp = v._plot(), mine = [mp.center[0] - mp.size[0] / 2, mp.center[1] - mp.size[1] / 2, mp.center[0] + mp.size[0] / 2, mp.center[1] + mp.size[1] / 2];
      const list = w.list.map(x => {
        const at = drag && drag.key === x.key ? drag.at : !x.edge && pending.get(x.key) || x.at;
        return { key: x.key, name: x.name, at, rect: w._rect({ at, plot: x.plot, k: x.k }), seen: !!x.w, edge: x.edge, plot: x.plot, k: x.k,
          placed: !x.edge && (pending.has(x.key) || v.layout.some(p => p.key === x.key)) };
      });
      for (const k of proposed) if (v.edges.some(e => e.key === k) || !list.some(p => p.key === k)) proposed.delete(k);
      return { mp, mine, list };
    }

    const dpr = () => window.devicePixelRatio || 1;
    const toPx = (x, z) => [canvas.clientWidth / 2 + (x - view.ox) * view.s, canvas.clientHeight / 2 + (z - view.oz) * view.s];
    const toWorld = (px, py) => [view.ox + (px - canvas.clientWidth / 2) / view.s, view.oz + (py - canvas.clientHeight / 2) / view.s];
    function fit() {
      const d = plots();
      if (!d || !canvas.clientWidth) return;
      let [x0, z0, x1, z1] = d.mine;
      for (const p of d.list) { x0 = Math.min(x0, p.rect[0]); z0 = Math.min(z0, p.rect[1]); x1 = Math.max(x1, p.rect[2]); z1 = Math.max(z1, p.rect[3]); }
      const pad = Math.max(x1 - x0, z1 - z0) * 0.12 + 2;
      view = { s: Math.min(canvas.clientWidth / (x1 - x0 + 2 * pad), canvas.clientHeight / (z1 - z0 + 2 * pad)), ox: (x0 + x1) / 2, oz: (z0 + z1) / 2 };
    }

    // Which side of yours a room is flush against (and over), if any: where an edge can be proposed.
    function flush(r, m) {
      const e = 1e-3, oz = r[1] < m[3] - e && r[3] > m[1] + e, ox = r[0] < m[2] - e && r[2] > m[0] + e;
      return oz && Math.abs(r[0] - m[2]) < e ? "east" : oz && Math.abs(r[2] - m[0]) < e ? "west" : ox && Math.abs(r[1] - m[3]) < e ? "south" : ox && Math.abs(r[3] - m[1]) < e ? "north" : null;
    }
    // That edge in its own terms (World._fromEdge, the other way): their side against yours, their middle `along`
    // metres from yours, along your side turning left.
    function edgeTerms(p, mine, mp) {
      const n = SIDE_NORMAL[mine], t = turnXZ(n[0], n[1], Math.PI / 2);
      const theirs = Object.keys(SIDE_NORMAL).find(s => { const [a, b] = turnXZ(SIDE_NORMAL[s][0], SIDE_NORMAL[s][1], p.at.turn * Math.PI / 2); return Math.abs(a + n[0]) < 1e-6 && Math.abs(b + n[1]) < 1e-6; });
      const mid = [mp.center[0] + n[0] * mp.size[0] / 2, mp.center[1] + n[1] * mp.size[1] / 2];
      return { mine, theirs, along: Math.round(((p.at.x - mid[0]) * t[0] + (p.at.z - mid[1]) * t[1]) * v._unit() * 1000) / 1000 };
    }

    // Where a room being dragged goes: on half units, then flush against a side near it (within 8 pixels).
    function snapAt(p, at, d) {
      const x0 = Math.round(at.x * 2) / 2, z0 = Math.round(at.z * 2) / 2, r = v._world._rect({ at: { x: x0, z: z0, turn: at.turn }, plot: p.plot, k: p.k });
      const hw = (r[2] - r[0]) / 2, hd = (r[3] - r[1]) / 2, tol = 8 / view.s, others = [d.mine, ...d.list.filter(q => q.key !== p.key).map(q => q.rect)];
      let bx = null, bz = null;
      for (const o of others) {
        for (const [a, b] of [[x0 - hw, o[2]], [x0 + hw, o[0]], [x0 - hw, o[0]], [x0 + hw, o[2]]]) if (Math.abs(b - a) < tol && (bx === null || Math.abs(b - a) < Math.abs(bx))) bx = b - a;
        for (const [a, b] of [[z0 - hd, o[3]], [z0 + hd, o[1]], [z0 - hd, o[1]], [z0 + hd, o[3]]]) if (Math.abs(b - a) < tol && (bz === null || Math.abs(b - a) < Math.abs(bz))) bz = b - a;
      }
      return { x: x0 + (bx || 0), z: z0 + (bz || 0), turn: at.turn };
    }
    const put = (p, at) => { pending.set(p.key, at); v.place(p.key, at); };

    function draw() {
      if (root.hidden) return;
      const d = plots(), W = canvas.clientWidth, H = canvas.clientHeight, k = dpr();
      if (canvas.width !== Math.round(W * k) || canvas.height !== Math.round(H * k)) { canvas.width = Math.round(W * k); canvas.height = Math.round(H * k); }
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.fillStyle = "#161b22"; ctx.fillRect(0, 0, W, H);
      if (!d) { ctx.fillStyle = "#8b949e"; ctx.font = "13px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText("this room has no world (v.world)", W / 2, H / 2); return side.innerHTML = ""; }
      if (!view) fit();
      if (!view) return;
      // A grid of whole units (or tens), north (-z) up.
      const step = [0.5, 1, 2, 5, 10, 20, 50, 100, 200].find(s => s * view.s >= 24) || 500, [wx0, wz0] = toWorld(0, 0), [wx1, wz1] = toWorld(W, H);
      ctx.strokeStyle = "#21262d"; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) { const [px] = toPx(x, 0); ctx.moveTo(Math.round(px) + 0.5, 0); ctx.lineTo(Math.round(px) + 0.5, H); }
      for (let z = Math.ceil(wz0 / step) * step; z <= wz1; z += step) { const [, py] = toPx(0, z); ctx.moveTo(0, Math.round(py) + 0.5); ctx.lineTo(W, Math.round(py) + 0.5); }
      ctx.stroke();
      ctx.fillStyle = "#8b949e"; ctx.font = "11px ui-monospace, monospace"; ctx.textAlign = "left"; ctx.fillText(`N ↑   grid ${step} ${step === 1 ? "unit" : "units"}`, 8, 16);
      const rect = (r, fill, stroke, dash, lw) => {
        const [a, b] = toPx(r[0], r[1]), [c, e] = toPx(r[2], r[3]);
        if (fill) { ctx.fillStyle = fill; ctx.fillRect(a, b, c - a, e - b); }
        ctx.setLineDash(dash || []); ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1.5; ctx.strokeRect(a, b, c - a, e - b); ctx.setLineDash([]);
      };
      const label = (r, text, sub) => {
        const [cx, cz] = toPx((r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
        ctx.textAlign = "center"; ctx.fillStyle = "#e6edf3"; ctx.font = "bold 12px system-ui, sans-serif"; ctx.fillText(text, cx, cz);
        if (sub) { ctx.fillStyle = "#8b949e"; ctx.font = "11px system-ui, sans-serif"; ctx.fillText(sub, cx, cz + 14); }
      };
      rect(d.mine, "rgba(63,185,80,.18)", "#3fb950");
      label(d.mine, "your room", v.office ? v.office.name : "");
      for (const p of d.list) {
        const on = sel === p.key, f = flush(p.rect, d.mine);
        rect(p.rect, p.seen ? (on ? "rgba(88,166,255,.32)" : "rgba(88,166,255,.16)") : null, p.edge ? "#e3b341" : on ? "#e6edf3" : p.seen ? "#58a6ff" : "#8b949e", p.seen ? null : [5, 4], on ? 2.5 : 1.5);
        // its own north: an arrow near that side, pointing out of it (how it is turned)
        const [nx, nz] = turnXZ(0, -1, p.at.turn * Math.PI / 2), hw = (p.rect[2] - p.rect[0]) / 2, hd = (p.rect[3] - p.rect[1]) / 2;
        const [ax, az] = toPx(p.at.x + nx * hw * 0.75, p.at.z + nz * hd * 0.75);
        ctx.fillStyle = "#8b949e"; ctx.beginPath(); ctx.moveTo(ax + nx * 6, az + nz * 6); ctx.lineTo(ax - nx * 3 - nz * 5, az - nz * 3 + nx * 5);
        ctx.lineTo(ax - nx * 3 + nz * 5, az - nz * 3 - nx * 5); ctx.closePath(); ctx.fill();
        label(p.rect, p.name || "?", p.edge ? "edge agreed" : !p.seen ? "not seen now" : f ? `flush: your ${f}` : p.placed ? "placed" : "in the ring");
      }
      drawSide(d);
    }

    function drawSide(d) {
      const p = d.list.find(q => q.key === sel);
      const sig = p ? [p.key, p.at.x, p.at.z, p.at.turn, p.edge, p.seen, p.placed, flush(p.rect, d.mine), proposed.has(p.key)].join() : "list:" + d.list.map(q => q.key + q.name).join();
      if (sig === sideSig || (side.contains(document.activeElement) && document.activeElement.tagName === "INPUT")) return;
      sideSig = sig;
      if (!p) {
        side.innerHTML = `<div class="muted">your room: ${d.mp.size.map(x => Math.round(x * 100) / 100).join(" × ")} units</div>`
          + (d.list.length ? d.list.map(q => `<button type="button" class="pick" data-m="pick" data-k="${esc(q.key)}">${esc(q.name || "?")}${q.edge ? " · edge" : ""}</button>`).join("")
            : `<div class="muted">no friends' rooms in your world yet: star a friend (a guest, with their door open to you), or put a link here</div>`);
        return;
      }
      const f = !p.edge && p.seen ? flush(p.rect, d.mine) : null, terms = f && edgeTerms(p, f, d.mp), e = v.edges.find(x => x.key === p.key);
      const r2 = x => Math.round(x * 100) / 100;
      side.innerHTML = `<div><b>${esc(p.name || "?")}</b> <span class="muted">${p.seen ? "" : "(not seen now)"}</span></div>`
        + (p.edge ? `<div>edge agreed: your ${esc(e ? e.mine : "?")}, their ${esc(e ? e.theirs : "?")}</div><button type="button" data-m="unedge">Take the edge back</button>`
          : `<div class="row">x <input data-f="x" value="${r2(p.at.x)}"> z <input data-f="z" value="${r2(p.at.z)}"></div>`
          + `<div class="row">${["not turned", "turned a quarter left", "turned half round", "turned a quarter right"][p.at.turn]} <button type="button" data-m="ccw" title="a quarter turn left">⟲</button><button type="button" data-m="cw" title="a quarter turn right">⟳</button></div>`
          + `<div class="row"><button type="button" data-m="auto" title="where the world puts it by itself">Back to the ring</button></div>`
          + (proposed.has(p.key) ? `<div class="muted">edge proposed: waiting for them</div>`
            : terms && terms.theirs ? `<button type="button" class="go" data-m="edge">Propose an edge: your ${terms.mine} to their ${terms.theirs}</button>`
            : `<div class="muted">${p.seen ? "flush against a side of yours, you can propose an edge" : "seen again, you can propose an edge"}</div>`))
        + `<button type="button" data-m="unsel">All rooms</button>`;
    }

    function hit(px, py) {
      const d = plots();
      if (!d || !view) return null;
      const [x, z] = toWorld(px, py);
      return [...d.list].reverse().find(p => x >= p.rect[0] && x <= p.rect[2] && z >= p.rect[1] && z <= p.rect[3]) || null;
    }
    const pos = e => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    canvas.addEventListener("pointerdown", e => {
      canvas.focus();
      const [px, py] = pos(e), p = hit(px, py);
      canvas.setPointerCapture(e.pointerId);
      if (p) {
        sel = p.key;
        if (!p.edge) { const [x, z] = toWorld(px, py); drag = { key: p.key, dx: x - p.at.x, dz: z - p.at.z, at: { ...p.at }, moved: false }; }
      } else pan = { px, py, ox: view.ox, oz: view.oz };
      draw();
    });
    canvas.addEventListener("pointermove", e => {
      const [px, py] = pos(e);
      if (drag) {
        const d = plots(), p = d && d.list.find(q => q.key === drag.key);
        if (!p) return;
        const [x, z] = toWorld(px, py);
        drag.at = snapAt(p, { x: x - drag.dx, z: z - drag.dz, turn: drag.at.turn }, d); drag.moved = true;
        draw();
      } else if (pan) { view.ox = pan.ox - (px - pan.px) / view.s; view.oz = pan.oz - (py - pan.py) / view.s; draw(); }
      else canvas.style.cursor = hit(px, py) ? "move" : "grab";
    });
    const up = () => {
      if (drag && drag.moved) { const d = plots(), p = d && d.list.find(q => q.key === drag.key); if (p) put(p, drag.at); }
      drag = null; pan = null; draw();
    };
    canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const [px, py] = pos(e), [x, z] = toWorld(px, py), f = Math.exp(-e.deltaY * 0.0015);
      view.s = Math.max(0.2, Math.min(400, view.s * f));
      const [x2, z2] = toWorld(px, py); view.ox += x - x2; view.oz += z - z2;
      draw();
    }, { passive: false });
    const turnSel = by => { const d = plots(), p = d && d.list.find(q => q.key === sel); if (p && !p.edge) put(p, { x: p.at.x, z: p.at.z, turn: (p.at.turn + by + 4) % 4 }); draw(); };
    canvas.addEventListener("keydown", e => {
      if (e.key === "r" || e.key === "R") { e.preventDefault(); turnSel(e.shiftKey ? 1 : -1); }   // R right, Shift+R left
      else if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); pending.delete(sel); v.unplace(sel); }
      else if (e.key === "Escape") close();
    });
    root.addEventListener("click", e => {
      if (e.target === root) return close();   // outside the box
      const b = e.target.closest("button[data-m]");
      if (!b) return;
      const m = b.dataset.m, d = plots(), p = d && d.list.find(q => q.key === sel);
      if (m === "close") close();
      else if (m === "fit") { fit(); draw(); }
      else if (m === "pick") { sel = b.dataset.k; draw(); }
      else if (m === "unsel") { sel = null; draw(); }
      else if (m === "cw" || m === "ccw") turnSel(m === "cw" ? -1 : 1);   // a turn is a quarter turn left
      else if (m === "auto" && p) { pending.delete(p.key); v.unplace(p.key); }
      else if (m === "edge" && p) { const f = flush(p.rect, d.mine), t = f && edgeTerms(p, f, d.mp); if (t && t.theirs) { v.proposeEdge(p.key, t); proposed.add(p.key); draw(); } }
      else if (m === "unedge" && p) v.removeEdge(p.key);
    });
    side.addEventListener("change", e => {
      const f = e.target.dataset.f, d = plots(), p = d && d.list.find(q => q.key === sel), n = Number(e.target.value);
      if (!p || !f || !Number.isFinite(n) || Math.abs(n) > 1e5) return draw();
      put(p, { x: f === "x" ? n : p.at.x, z: f === "z" ? n : p.at.z, turn: p.at.turn });
      e.target.blur(); sideSig = ""; draw();
    });
    function open() { root.hidden = false; view = null; sideSig = ""; draw(); canvas.focus(); clearInterval(timer); timer = setInterval(draw, 200); }
    function close() { root.hidden = true; clearInterval(timer); drag = pan = null; }
    v.on("change", draw);
    return { element: root, open, close, get shown() { return !root.hidden; },
      // for tests: where a room's middle is on screen (clientX, clientY)
      _px(key) { const d = plots(), p = d && view && d.list.find(q => q.key === key); if (!p) return null; const b = canvas.getBoundingClientRect(), [x, y] = toPx(p.at.x, p.at.z); return [b.left + x, b.top + y]; },
      release() { close(); v.off("change", draw); root.remove(); } };
  }

  // ---------- the ready-made stage: the room you are visiting, full-window or in a corner ----------
  const STAGE_CSS = `
.visit-stage { position: fixed; z-index: 5; background: #000; overflow: hidden; }
.visit-stage.big { inset: 0; }
.visit-stage.small { right: 16px; bottom: 16px; width: 320px; height: 180px; border: 1px solid #2d333b; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.4); cursor: pointer; }
.visit-stage .screen { position: absolute; inset: 0; }
.visit-stage .bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 8px; align-items: center; padding: 6px 10px; font: 12px/1.3 ui-monospace, Consolas, monospace; color: #e6edf3; background: rgba(13,17,23,.78); }
.visit-stage .bar .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.visit-stage .bar .stats { color: #8b949e; white-space: nowrap; }
.visit-stage .bar button { font: inherit; color: inherit; background: #161b22; border: 1px solid #2d333b; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
.visit-stage.small .bar button, .visit-stage.small .bar .stats { display: none; }
.visit-stage .menu { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; background: rgba(13,17,23,.72); font: 12px/1.3 ui-monospace, Consolas, monospace; color: #e6edf3; }
.visit-stage .menu[hidden] { display: none; }
.visit-stage .menu button { font: inherit; color: inherit; background: #161b22; border: 1px solid #2d333b; border-radius: 6px; padding: 3px 12px; cursor: pointer; min-width: 150px; }
.visit-stage .menu button.go { background: #2f9e4f; border-color: #2f9e4f; color: #fff; }`;

  // While you visit: the room you are in fills the window, with how it is going (the link's path and round
  // trip, input to screen, frames a second), "Back to my room" and "Leave". Back in your room, the visit
  // shrinks to a corner (and takes no keys: v.viewFocused is false, so the page's own are its own); a click
  // on it brings it back to the full window. A link (8.5) starts in the corner, seen from outside: a click on it
  // offers "Go there" (the full window, in their room: "Back to my room" puts it in the corner again), "Put in my
  // world" (with v.world) and "Unlink". Gone when the visit or link ends. { element, big, shrink(), grow(),
  // release() }
  function stage(v, { parent = document.body } = {}) {
    if (!document.getElementById("visit-stage-css")) {
      const st = document.createElement("style"); st.id = "visit-stage-css"; st.textContent = STAGE_CSS; document.head.appendChild(st);
    }
    const root = document.createElement("div");
    root.className = "visit-stage big"; root.hidden = true;
    root.innerHTML = `<div class="screen"></div><div class="bar"><span class="grow"></span><span class="stats"></span>`
      + `<button type="button" data-s="small" title="your own room, with this one in the corner">Back to my room</button><button type="button" data-s="leave">Leave</button></div>`
      + `<div class="menu" hidden><button type="button" class="go" data-s="in">Go there</button><button type="button" data-s="world">Put in my world</button>`
      + `<button type="button" data-s="leave">Unlink</button><button type="button" data-s="close">Not now</button></div>`;
    parent.appendChild(root);
    const screen = root.querySelector(".screen"), cap = root.querySelector(".grow"), nums = root.querySelector(".stats"), menu = root.querySelector(".menu");
    const leaveB = root.querySelector(".bar button[data-s=leave]"), worldB = menu.querySelector("button[data-s=world]");
    let view = null, big = true, shown = null;
    function set(on) { big = on; root.className = "visit-stage " + (on ? "big" : "small"); if (view) view.setActive(on); menu.hidden = true; draw(); stats(); }
    function draw() {
      if (v.visiting && !view) { root.hidden = false; view = v.view(screen); big = true; root.className = "visit-stage big"; }
      if (!v.visiting && view) { view.release(); view = null; root.hidden = true; menu.hidden = true; shown = null; }
      if (!v.visiting) return;
      const vi = v.visiting, name = vi.host.name || "Their";
      if (vi.link) {   // a link: big while in their room, in the corner while not
        const want = !!vi.inside, now = vi.id + ":" + want;
        if (shown !== now) { shown = now; if (want !== big) set(want); if (!want) menu.hidden = true; }
      } else if (shown !== vi.id) { shown = vi.id; if (!big) set(true); }
      leaveB.textContent = vi.link ? "Unlink" : "Leave";
      worldB.hidden = !v._world;
      cap.textContent = big ? `${name}'s room${vi.paused ? " (reloading)" : ""} · click to look around, WASD to walk, Shift to run, Esc frees the mouse`
        : vi.link ? `${name}'s room · click: go there, or not` : `${name}'s room · click to go back in`;
    }
    function stats() {
      const x = v.stats;
      nums.textContent = !v.visiting ? "" : [x.path, x.rtt != null && `link ${Math.round(x.rtt)} ms`,
        x.latency != null && `input to screen ${Math.round(x.latency)} ms`, x.fps ? `${x.fps} fps` : ""].filter(Boolean).join(" · ");
    }
    root.addEventListener("click", e => {
      const b = e.target.closest("button[data-s]"), s = b && b.dataset.s, link = v.visiting && v.visiting.link;
      if (b) {
        e.stopPropagation();
        menu.hidden = true;
        if (s === "leave") return v.leave();
        if (s === "in") return v.stepIn();
        if (s === "world") return v.toWorld();
        if (s === "close") return;
        return link ? v.stepOut() : set(false);   // Back to my room
      }
      if (big) return;
      if (link) menu.hidden = !menu.hidden; else set(true);
    });
    v.on("change", draw); v.on("stats", stats);
    draw();
    return {
      element: root, get big() { return big; }, shrink: () => set(false), grow: () => set(true),
      release() { v.off("change", draw); v.off("stats", stats); if (view) view.release(); root.remove(); },
    };
  }

  window.Visit = {
    version: VERSION,
    // `threeBase`: where to fetch three.js from instead of the CDN ("{r}" the revision; the same files, checked
    // against the same hashes).
    connect({ port, token, sim = {}, threeBase = null }) {
      const c = new Client(port, token, sim, { threeBase });
      return c._open().then(() => c, e => { c.close(); throw e; });
    },
    walk,
    panel,
    stage,
    map,
    _test: { cleanScene, imageDims },   // for visit-client's own tests
  };
})();
