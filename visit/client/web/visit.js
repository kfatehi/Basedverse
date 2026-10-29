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
  const VERSION = "1.0.1", PROTO = "basedverse-visit-local/2";
  const MOVE_MS = 1000 / 60, INPUT_MS = 1000 / 30, INPUT_MIN_MS = 8, STALE_MS = 300, LOOK = 0.0025;
  const POINT_MS = 200, AIM_MS = 125;   // a visitor's points, at most one this often; what it aims at, looked for this often
  // A visitor's up and down (SPEC 8.2: its input's `up`), as WoW flies: what they do is the room's (its move).
  const UP_KEYS = ["Space", "PageUp"], DOWN_KEYS = ["KeyX", "PageDown"];
  // Positions (SPEC 8.1, MODELS.md): where someone is, is where their feet are, on the ground, in the room's units: a
  // room's spawn and move say it so, and so does a world's frame. Their eyes are above that: their own model's `eyes`
  // point where a room shows it (else 92% of its height), else the room's `eye`, EYES metres unless it says. Only a
  // visitor's camera is at their eyes (what goes over the wire to them is where it is).
  // Possessions (SPEC 8.11): what an office's user owns and brings along, as their own room makes them; for now,
  // mounts. A page gives at most POSSESSIONS (each as big as an avatar may be); MOUNT_KEY gets your user on their
  // mount and off again (the panel's, once your room gives one).
  const POSSESSIONS = 8, MOUNT_KEY = "KeyM", EYES = 1.6;
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
  const KEY = 1, EDIT = 2, AVATAR = 4, AUDIO = 8, RELAY = 16, LAND = 32, POSSESSION = 64, MEDIA = 128;   // frames' flags: bit 0 a key delta; bit 1 a scene edit, bit 2 this office's avatar (page to visit-client); bit 3 voice; bit 5 this room's landscape (page to visit-client); bit 6 one of its possessions, its slot the channel (8.11); bit 7 a picture shared in chat (8.12) (SPEC 5.4)
  const MEDIA_MAX = 8 << 20, MEDIA_KINDS = ["image/png", "image/jpeg", "image/webp", "image/gif"];   // a picture shared (8.12): at most 8 MB, of these kinds
  const VOICE_MAX = 2 << 20, VOICE_SECS = 60, VOICE_KINDS = ["audio/webm", "audio/ogg", "audio/mp4"];   // a voice message (0.22.0): at most 2 MB, a minute, of these kinds
  // A landscape (SPEC 8.10) goes to visit-client this long after what is static last changed: once, for a room still
  // loading.
  const LAND_QUIET = 1000;
  // A visitor starting gets the whole room once its visit-client says it reads landscapes, or after this long.
  const LAND_WAIT = 400;
  // A canvas texture redrawn is encoded again in the background, and sent, at most this often (ms).
  const TEX_EVERY = 1000;
  // Voice (SPEC 8.7): 20 ms of 48 kHz mono a packet, Opus at 24 kbps; played this far behind, to ride out jitter.
  // Heard within v.voiceRange metres (as visit-client says: VOICE_RANGE until it has), fading to nothing there. Who
  // hears whom the room's visit-client decides; a page's voice says where it may go: the room its user is in, their
  // calls, or both (VOICE_ROOM, VOICE_CALLS: its frame's channel).
  const VOICE_RATE = 48000, VOICE_FRAME = 960, VOICE_BITRATE = 24000, VOICE_LEAD = 0.06, VOICE_LATE = 0.4, VOICE_RANGE = 45, VOICE_ROOM = 1, VOICE_CALLS = 2, VOICE_CHANNEL = 4;
  const ROUTE_CALL = 1, ROUTE_VOICE = 2;   // how a voice came (to the page: the frame's first timestamp byte): in person (0), a call, a room voice
  // A phone (SPEC 8.8) rings this long, unanswered, then stops.
  const CALL_RING_MS = 30000;
  // Chat (SPEC 8.9): a line is at most CHAT_LEN characters, at most CHATS of them every CHAT_WINDOW ms (as visit-client
  // takes them), and shows over its speaker's head a while, the longer the longer it is.
  const CHAT_LEN = 200, CHATS = 5, CHAT_WINDOW = 10000, chatShows = text => Math.min(12000, 4000 + 70 * text.length);
  // The chat window (Visit.chat) keeps the last CHAT_LOG lines, and fades CHAT_FADE ms after the last one.
  const CHAT_LOG = 100, CHAT_FADE = 20000;
  // Someone is looking at the chat window while its page is shown and focused, and they used a key, a click or the
  // pointer this recently (ms): what comes meanwhile is seen, not in the mailbox (8.9).
  const LOOKING = 120000, STIRS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"];
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
  // A binary frame to visit-client (SPEC 5.4): a channel, flags, the page's clock, and what it carries.
  const frameOf = (ch, flags, data) => {
    const buf = new Uint8Array(11 + data.byteLength), dv = new DataView(buf.buffer);
    dv.setUint16(0, ch); dv.setUint8(2, flags); dv.setBigUint64(3, BigInt(Math.round(performance.now() * 1000)));
    buf.set(data, 11);
    return buf;
  };
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
  const bansFrom = l => (Array.isArray(l) ? l : []).filter(b => isObj(b) && typeof b.key === "string").map(b => ({ key: b.key, name: String(b.name || ""), voice: b.voice === true, chat: b.chat === true }));
  // A line's pictures and links (8.12), as the visit-client gives them: [{ id, mime, size }], [{ url, title, description,
  // site, image }].
  // A line's pictures, and its voice message (`secs`: how long, as its sender says).
  const picturesFrom = l => (Array.isArray(l) ? l : []).filter(p => isObj(p) && /^[0-9a-f]{64}$/.test(p.id)).slice(0, 4).map(p => ({ id: p.id, mime: String(p.mime || ""), size: Number(p.size) || 0,
    ...(VOICE_KINDS.includes(String(p.mime)) ? { secs: Math.round(Math.min(VOICE_SECS, Math.max(0, Number(p.secs) || 0)) * 10) / 10 } : {}) }));
  const isVoice = p => VOICE_KINDS.includes(p.mime);
  const linksFrom = l => (Array.isArray(l) ? l : []).filter(x => isObj(x) && /^https?:\/\/\S+$/.test(String(x.url || ""))).slice(0, 2).map(x => ({ url: String(x.url),
    title: String(x.title || ""), description: String(x.description || ""), site: String(x.site || ""), image: picturesFrom(isObj(x.image) ? [x.image] : [])[0] || null }));
  // A picture made small enough to share (8.12): at most 4096 px a side and MEDIA_MAX, as WebP (else JPEG).
  async function smaller(blob) {
    const bmp = await createImageBitmap(blob);
    let scale = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
    for (let i = 0; i < 6; i++, scale *= 0.7) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      for (const [kind, q] of [["image/webp", 0.85], ["image/jpeg", 0.85]]) {
        const out = await new Promise(r => c.toBlob(r, kind, q));
        if (out && out.type === kind && out.size <= MEDIA_MAX) return out;
      }
    }
    throw new Error("too big to share, even made smaller");
  }
  const membersFrom = l => (Array.isArray(l) ? l : []).filter(x => isObj(x) && typeof x.key === "string").map(x => ({ key: x.key, name: String(x.name || ""), speaking: false }));
  function cleanScene(json, budget) {
    if (!isObj(json)) throw new Error("a scene is a JSON object");
    const arr = k => (Array.isArray(json[k]) ? json[k] : []).filter(isObj);
    json.materials = arr("materials").map(m => MATERIALS.has(m.type) ? m : { uuid: String(m.uuid), type: "MeshLambertMaterial", color: 0x808080 });
    json.geometries = arr("geometries").map(g => {
      if (NO_RECIPE.has(g.type)) return { uuid: String(g.uuid), type: "BufferGeometry", data: { attributes: {} } };   // from an older host, with nothing to make it from: empty, not a warning an object
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
  // (SPEC 8.1): `visitor` (a visitor's own body), `visitRider` (a visitor's mount, 8.11) and `visitPoint` (something
  // a visitor may point at). The rest is
  // the host's own, where a sim keeps its state (who a figure is, its handles), and never leaves its page; it is
  // put back as it was the moment the JSON is made.
  const SHARED_DATA = ["visitor", "visitPoint", "visitRider"];
  // A geometry three.js's loader makes from no recipe: an EdgesGeometry or a WireframeGeometry (lines along another
  // geometry's edges) says in its JSON only what it was made from, which is not there to make it from again.
  const NO_RECIPE = new Set(["EdgesGeometry", "WireframeGeometry"]);
  function sharedJSON(o, meta) {
    const kept = [], lines = [];
    o.traverse(x => {
      if (x.geometry && NO_RECIPE.has(x.geometry.type) && x.geometry.attributes && x.geometry.attributes.position) lines.push(x.geometry);
      const u = x.userData;
      if (!u || typeof u !== "object" || !Object.keys(u).length) return;
      const shared = {};
      for (const k of SHARED_DATA) if (["string", "number", "boolean"].includes(typeof u[k])) shared[k] = u[k];
      kept.push([x, u]);
      x.userData = shared;
    });
    try {
      const json = o.toJSON(meta);
      // Those travel as their lines: a plain geometry with their vertices, loaded anywhere.
      for (const g of lines) {
        const at = meta && meta.geometries ? meta.geometries : null, pos = g.attributes.position;
        if (!at || !at[g.uuid] || at[g.uuid].type !== g.type) continue;
        at[g.uuid] = { uuid: g.uuid, type: "BufferGeometry", data: { attributes: { position: { itemSize: pos.itemSize, type: pos.array.constructor.name, array: Array.from(pos.array), normalized: !!pos.normalized } } } };
      }
      return json;
    } finally { for (const [x, u] of kept) x.userData = u; }
  }

  // Every uuid in a landscape's JSON named anew, in the order each first comes (L1, L2, ...), and every mention of
  // it with it: three.js makes new uuids at every load, and the same landscape must be the same JSON (its hash).
  function renumber(json) {
    const names = new Map(), stack = [json];
    while (stack.length) {   // depth first, in the JSON's own order
      const x = stack.pop();
      if (Array.isArray(x)) { for (let i = x.length - 1; i >= 0; i--) stack.push(x[i]); continue; }
      if (!isObj(x)) continue;
      if (typeof x.uuid === "string" && !names.has(x.uuid)) names.set(x.uuid, "L" + (names.size + 1));
      const vs = Object.values(x);
      for (let i = vs.length - 1; i >= 0; i--) if (typeof vs[i] === "object") stack.push(vs[i]);
    }
    const swap = x => {
      if (typeof x === "string") return names.has(x) ? names.get(x) : x;
      if (Array.isArray(x)) return x.map(swap);
      if (!isObj(x)) return x;
      const out = {};
      for (const [k, v] of Object.entries(x)) out[k] = swap(v);
      return out;
    };
    return swap(json);
  }

  // The host's side of a scene: what it last sent of each object, material, geometry and texture, so that each
  // round (every SCENE_MS) sends only what changed. One for all of a host's visitors: they get the same edits.
  class SceneSync {
    constructor(cfg) {
      const t = cfg.three;
      // `shared`: every visitor this round's edit goes to reads an added object that names what it has by uuid.
      // `statics`: the landscape (8.10), [object, its parent's record] in the scene's order; `landAt`, when it last changed.
      Object.assign(this, { cfg, objs: new Map(), next: 1, mats: new Map(), geos: new Map(), texs: new Map(), dynamic: new Set(), sent: new Set(), shared: false,
        statics: [], staticSig: null, landDirty: false, landAt: 0, enc: new Map(), perf: null,
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
      const stack = [[root, null, false]], statics = [];
      while (stack.length) {
        const [o, parent, fresh] = stack.pop();
        if (o !== root && o.userData && o.userData.visitStatic === true) { statics.push([o, parent]); continue; }   // landscape: sent apart, once (8.10)
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
      for (const t of usedTexs) {   // a canvas redrawn: encoded in the background (_encode); anything else as it is
        const c = t.image;
        if (this.texs.has(t.uuid) && typeof HTMLCanvasElement !== "undefined" && c instanceof HTMLCanvasElement) this._encode(t, c, now, res);
        else again(this.texs, t, t.version, 500, "texture");
      }
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
      // The landscape: which objects, under which. Changed, it goes again (_landSend) and visitors put it where it goes.
      const ssig = statics.map(([o, p]) => o.uuid + ">" + (p ? p.o.uuid : "")).join();
      let land = null;
      if (ssig !== this.staticSig) {
        const was = this.staticSig;
        Object.assign(this, { staticSig: ssig, statics, landDirty: statics.length > 0 || was !== null, landAt: now });
        if (was !== null) land = { parents: this.landParents() };
      }
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
      if (land) edit.landscape = land;
      return { edit: Object.keys(edit).length > 1 ? edit : null, moved };
    }

    // Where each landscape object goes: its parent's number (0: the scene), in the landscape's order.
    landParents() { return this.statics.map(([, p]) => p ? p.idx : 0); }

    // What `f` makes of `top` with the landscape under it left out: each static object taken from its parent's
    // children while it runs (no events, nothing moved), put back after.
    _without(top, f) {
      const out = [];
      for (const [o] of this.statics) {
        if (o === top || !o.parent) continue;
        let under = false;
        for (let p = o.parent; p && !under; p = p.parent) under = p === top;
        const i = under ? o.parent.children.indexOf(o) : -1;
        if (i >= 0) { out.push([o.parent, i, o]); o.parent.children.splice(i, 1); }
      }
      try { return f(); } finally { for (let k = out.length - 1; k >= 0; k--) { const [p, i, o] = out[k]; p.children.splice(i, 0, o); } }
    }

    // The landscape (8.10): every static object and what is under it, as three.js's own JSON of a group of them, its
    // uuids named in order (renumber): the same landscape, the same JSON at every load.
    landscape() {
      const meta = { geometries: {}, materials: {}, textures: {}, images: {}, shapes: {}, skeletons: {}, animations: {}, nodes: {} };
      const children = this.statics.map(([o]) => sharedJSON(o, meta).object), json = { metadata: { version: 4.5, type: "Object", generator: "Visit landscape" } };
      for (const k of ["geometries", "materials", "textures", "images", "shapes", "skeletons", "animations"]) {
        const xs = Object.values(meta[k]).map(x => { delete x.metadata; return x; });
        if (xs.length) json[k] = xs;
      }
      json.object = { uuid: "landscape", type: "Group", layers: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], children };
      return renumber(json);
    }

    // An added object: its JSON (with what it is made of, but, when its visitors read that, the geometries and
    // materials they have: those it names by uuid), each object's number, its lights' targets.
    _added(r) {
      const json = this._without(r.o, () => sharedJSON(r.o)), ids = [];
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

    // A canvas texture redrawn: its picture encoded by the browser in the background (WebP: toBlob, off this page's
    // main thread), and sent once it is ready, at most every TEX_EVERY. A room that redraws a canvas every second (a
    // board, a screen) then never stops to encode it while it has visitors.
    _encode(t, c, now, res) {
      const rec = this.texs.get(t.uuid), job = this.enc.get(t.uuid);
      if (job && job.url) {   // ready: it goes now, as the picture it was then
        Object.assign(rec, { ver: job.ver, at: now });
        res.set(t.uuid, ["texture", t, job.url]);
        this.enc.delete(t.uuid);
        if (this.perf) this.perf("textures", performance.now() - job.t0);
        return;
      }
      if (rec.ver === t.version || (job && job.busy) || now - rec.at < TEX_EVERY) return;
      const j = { ver: t.version, busy: true, url: null, t0: performance.now() }, fail = () => { this.enc.delete(t.uuid); Object.assign(rec, { ver: j.ver, at: now }); res.set(t.uuid, ["texture", t]); };
      this.enc.set(t.uuid, j);
      try {
        c.toBlob(b => {
          if (!b) return this.enc.delete(t.uuid);
          const r = new FileReader();
          r.onload = () => { j.url = String(r.result); j.busy = false; };
          r.onerror = () => this.enc.delete(t.uuid);
          r.readAsDataURL(b);
        }, "image/webp", 0.85);
      } catch (e) { fail(); }   // (a canvas the browser will not encode this way: as before, at once)
    }

    // Geometries, materials and textures to send again (or for the first time), as three.js's toJSON makes them; a
    // texture encoded already (_encode), with that picture, not one made now.
    _resources(items) {
      const meta = { geometries: {}, materials: {}, textures: {}, images: {}, shapes: {}, skeletons: {}, animations: {}, nodes: {} };
      for (const [kind, x, url] of items) {
        if (kind === "geometry") {
          meta.geometries[x.uuid] = x.toJSON();
          for (const sh of list(x.parameters && x.parameters.shapes)) meta.shapes[sh.uuid] = sh.toJSON();
        } else if (kind === "material") meta.materials[x.uuid] = x.toJSON(meta);
        else if (url) {
          const img = x.image, tiny = document.createElement("canvas");
          tiny.width = tiny.height = 1;
          x.image = tiny;   // (so that toJSON encodes nothing big)
          try { meta.textures[x.uuid] = x.toJSON(meta); } finally { x.image = img; }
          const im = meta.images[meta.textures[x.uuid].image];
          if (im) im.url = url;
        } else meta.textures[x.uuid] = x.toJSON(meta);
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
    // number, and what the visitor needs to draw it as the host does and to walk in it. Its landscape apart (where it
    // goes: `landscape`) for a visitor that reads landscapes, else in it.
    snapshot(h, hooks) {
      const { root, three, renderer } = this.cfg, w = hooks.walk, apart = !!h.landscapes && this.statics.length > 0;
      root.updateMatrixWorld();
      const json = apart ? this._without(root, () => sharedJSON(root)) : sharedJSON(root);
      this.sent = new Set(["geometries", "materials", "textures", "images"].flatMap(k => (json[k] || []).map(x => x.uuid)));
      this.interSig = JSON.stringify(this.inter);
      return { type: "scene", three: String(three.REVISION), json, ids: [...this.objs.values()].map(r => [r.o.uuid, r.idx]), targets: this.targets(root), interactions: this.inter,
        renderer: rendererProps(renderer, three), fov: Number(hooks.fov) || 70, near: Number(this.cfg.near) || 0.1, far: Number(this.cfg.far) || 1000,
        walk: w && Number(w.speed) > 0 ? { speed: Number(w.speed), mounts: w.mounts === true } : null, yaw0: h.yaw0,
        pose: h.pose ? Object.assign({}, h.pose, { y: (Number(h.pose.y) || 0) + (h.eyes || 0) }) : h.pose,   // its eyes: where its camera goes
        eye: h.eyes || (Number(hooks.eye) > 0 ? Number(hooks.eye) : EYES) / (Number(hooks.unit) > 0 ? Number(hooks.unit) : 1),
        plot: hooks.plot ? { center: hooks.plot.center.map(Number), size: hooks.plot.size.map(Number) } : null, unit: Number(hooks.unit) > 0 ? Number(hooks.unit) : 1,
        preview: hooks.preview ? ["x", "y", "z", "yaw", "pitch"].reduce((o, k) => Object.assign(o, { [k]: Number(hooks.preview[k]) }), {}) : null,
        landscape: apart ? { parents: this.landParents() } : null };
    }
  }

  class Client {
    constructor(port, token, sim, { threeBase = null, url = null, role = null } = {}) {
      // Where visit-client is (SPEC 7): a URL (ws:// or wss://), a path on this page's own origin (a workroom's
      // server's relay, "/visit/ws"), or, as before, a port on 127.0.0.1. And which role this page is: the room
      // ("host"), the person ("user"), or both (null: every page before the engine).
      if (role != null && role !== "host" && role !== "user") throw new Error('Visit.connect: role is "host", "user", or none');
      const where = url ? (/^wss?:\/\//.test(url) ? url : (location.protocol === "https:" ? "wss://" : "ws://") + location.host + (url.startsWith("/") ? url : "/" + url)) : `ws://127.0.0.1:${port}/ws`;
      Object.assign(this, { port, token, sim, _threeBase: threeBase, url: where, role, _wantRole: role });
      this.home = null;        // the user's: their own room as a visit (engine/SPEC.md 4): { id, channel, paused }, while the room is up
      this.owner = null;       // the host's: the person in it, as a visitor of its own: { id, channel }, while they are here
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
      this.seen = [];          // where friends have put your room in their worlds (8.4): [{ key, name, at: { dx, dz, turn, size } }]
      this.watchers = [];      // who sees your room from outside it (your guests' worlds, links): [{ id, visitor, inside, link }]
      this.links = [];         // your links (8.5): [{ id, host, where ("corner", "aside" or "world"), inside }]
      this.avatars = { default: "theirs", by: [] };
      this.riding = null;      // the mount your user rides (8.11): its id, or null
      this.mount = null;       // the one M (the panel's) gets them on, as they last chose
      try { const m = localStorage.getItem("visit:mount"); if (m) this.mount = m; } catch (e) { /* none kept */ }
      this._own = [];          // your page's own possessions (8.11): [{ id, name, object, unit, mount, fly, speed, lift }]   // whose look your visitors have in your room (8.6): "theirs" or "mine"
      this.mic = false;        // your microphone on (8.7): those near you hear you
      this.voices = [];        // who you can hear, near you: [{ key, name, distance (m), speaking }] (in your room, the one you
                               //   are in, and friends across your plot's side, near in both worlds)
      this.roomVoice = null;   // the room voice you are in (8.7): { key (its room's owner's; yours: v.key), name, members:
                               //   [{ key, name, speaking }], joining }
      this.voiceMembers = [];  // who is in your own room's voice, you too if you are: [{ key, name, speaking }]
      this.bans = [];          // whom you keep out of your room's voice or chat (8.9): [{ key, name, voice, chat }]
      this.bannedBy = [];      // rooms that keep you out of their voice or chat: [{ key, name, voice, chat }]
      this._userName = null;      // the name your user goes by (8.9), as setName gave it
      this._users = new Map();    // the names linked offices' users go by, by key (8.9)
      this._asks = new Map();     // what the page asked its visit-client and waits for (history, shared, preview), by req
      this._reqN = 0;
      this._puts = new Map();     // pictures being kept (8.12), by slot: { resolve, reject, t }
      this._slot = 0;
      this._media = new Map();    // pictures by id: a promise of a URL this page can show (null: not to be had)
      this._mediaWait = new Map();   // id -> its promise's resolve, while the visit-client fetches it
      this.voiceRange = VOICE_RANGE;   // metres: farther, nobody is heard (visit-client's, from ready)
      this._voices = new Map();   // their key -> a decoder, its panner, and where its next moment plays
      this._voiceTo = 0;          // where your voice may go: VOICE_ROOM, VOICE_CALLS, both, or nowhere (nothing encoded)
      this._chats = new Map();    // lines said in the rooms you are in or host (8.9), still showing, by who said them
      this._bodies = new Map();   // channel -> how the room on it draws your user: { look, eyes, problem } (8.6)
      this.chatLog = [];       // the last CHAT_LOG lines of chat, of every scope (8.9), as "chat" gave them, with `at` (ms);
                               //   `old`, from before this page (kept by the visit-client: a reload keeps the chat)
      this.lobbyChat = false;  // the lobby relays chat (8.9): say(text, "lobby") goes to everyone in it
      this.unseen = { count: 0, conversations: [], lines: [] };   // the mailbox (8.9): lines meant for you, not read yet
      this.held = [];          // whispers you left for someone away, still with your visit-client: [{ id, key, name, text, at }]
      this._attention = false; // someone looking at this page's chat (Visit.chat says), as last told
      this._kept = new Map();     // guests' plots kept while they are away (8.10): key -> { key, name, plot, unit, json, asked, built }
      this._landText = null;      // this room's landscape, as last given to visit-client
      this._said = [];            // when you last said lines (CHATS every CHAT_WINDOW)
      this._saidAs = new Map();   // and each of your room's figures (sayAs), by its id
      this._nearHome = [];        // who is near your user in your room, as your visit-client says (voice_near)
      this._nearBy = new Map();   // and in another's room, as its owner's says: channel -> [{ key, name, distance, id, phone }]
      this._whereTold = { sig: "", at: 0 };   // where everyone in your room is, as last told to your visit-client
      this._voiceRoom = null;     // the room your user is in, as voice last saw it
      this._calls = new Map();    // their key -> a call: { key, name, channel, state, timer }
      this._phoneOn = new Set();  // channels whose other office's room has a phone
      this._phone = false;        // this room has one
      this._mic = null;
      this._home = null;          // where your user is at home (your world's frame, or listener()), in your units
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
        const ws = this._ws = new WebSocket(this.url);
        ws.binaryType = "arraybuffer";
        let ready = false;
        ws.onopen = () => ws.send(JSON.stringify({ type: "hello", proto: PROTO, sim: this.sim, ...(token ? { token } : {}), ...(this._wantRole ? { role: this._wantRole } : {}) }));
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
            const err = new Error(e.code === 4401 ? "visit-client refused the token" : e.code === 4400 ? "visit-client refused this page's hello" : `visit-client is not running at ${this.url}, or refused this page`);
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
    close() { this._closed = true; this._loop.stop(); this._micStop(); for (const k of [...this._calls.keys()]) this.hangUp(k); this._dropAll(); if (this._ws) this._ws.close(); }

    _ready(m) {
      this.state = m.away ? "away" : m.online ? "online" : "offline";
      this.role = m.role === "host" || m.role === "user" ? m.role : null;
      this.home = isObj(m.home) ? { id: String(m.home.id), channel: Number(m.home.channel), paused: m.home.paused === true } : null;
      this.owner = isObj(m.owner) ? { id: String(m.owner.id), channel: Number(m.owner.channel) } : null;
      this.office = m.office && m.office.id ? m.office : null;
      this.status = m.status; this.maxVisitors = m.max_visitors;
      this.key = typeof m.key === "string" ? m.key : null;
      this.lobbyChat = m.lobby_chat === true;
      this.unseen = { count: 0, conversations: [], lines: [] }; this.held = [];   // (said again after, if any)
      if (this._attention) this._send({ type: "attention", on: true });
      this._guests(m);
      this.layout = Array.isArray(m.layout) ? m.layout : [];
      this.voiceRange = Number(m.voice_range) > 0 ? Number(m.voice_range) : VOICE_RANGE;
      this._kept = new Map((Array.isArray(m.kept) ? m.kept : []).filter(k => isObj(k) && typeof k.key === "string" && isObj(k.plot))
        .map(k => [k.key, { key: k.key, name: String(k.name || ""), plot: k.plot, unit: Number(k.unit) > 0 ? Number(k.unit) : 1, json: null, asked: false, built: null }]));
      this._landText = null;   // this room's landscape: to visit-client again (it may be a new one)
      if (!this._perfAsked) {   // telemetry on, if it was on in this browser (or ?visit-perf=1)
        this._perfAsked = true;
        let on = /[?&]visit-perf=1\b/.test(location.search);
        try { on = on || localStorage.getItem("visit:perf") === "on"; } catch (e) { /* not kept */ }
        if (on) this.perf(true);
      }
      if (this._sync) Object.assign(this._sync, { landDirty: true, landAt: 0 });
      this._nearHome = []; this._nearBy.clear(); this._whereTold.sig = "";
      this.seen = (Array.isArray(m.seen) ? m.seen : []).filter(x => isObj(x) && isObj(x.at)).map(x => ({ key: String(x.key), name: String(x.name || ""), at: x.at }));
      this.bans = bansFrom(m.bans); this.bannedBy = bansFrom(m.banned_by); this.voiceMembers = membersFrom(m.voice_members);
      this._users = new Map((Array.isArray(m.users) ? m.users : []).filter(u => isObj(u) && typeof u.key === "string" && typeof u.name === "string").map(u => [u.key, u.name]));
      this._roomVoiceFrom(m.room_voice);
      this.knocks = []; this.knocking = [];
      this._avatarsFrom(m.avatars);
      this._phoneOn.clear();
      for (const v of m.visits || []) this._started(v);
      if (this._phone) this._send({ type: "phone", on: true });   // a visit-client that came back: this room's phone again
      if (!this._mic && !this._micAsked) {   // the microphone on last time, its permission given: on again
        this._micAsked = true;
        let want = false;
        try { want = localStorage.getItem("visit:mic") === "on"; } catch (e) { /* not kept */ }
        if (want && navigator.permissions) navigator.permissions.query({ name: "microphone" })
          .then(p => { if (p.state === "granted") return this.setMic(true); }).catch(e => console.warn("visit: the microphone did not come back on", e));
      }
      if (this._own.length) this._possessionsSend();   // nor its possessions
      if (this._userName) this._send({ type: "user", name: this._userName });   // nor the name your user goes by
      if (this._avatarOwn) this._avatarSend();   // a visit-client that came back has no avatar of this office's
      if (this._hooks) this._sendHost();   // a visit-client that came back: this page hosts, again
      if (this._world) this._send({ type: "world", on: true });
      this._changed();
    }

    _message(m) {
      switch (m.type) {
        case "online":   // (again, after a drop): its own knocks still waiting are these
          this.state = "online"; this.office = m.office; this.lobbyChat = m.lobby_chat === true;
          if (Array.isArray(m.knocking)) this.knocking = m.knocking.map(k => ({ id: k.id, to: k.to, link: k.link === true }));
          break;
        case "offline":   // away: this office left the lobby on purpose, and sees nobody until it joins again
          this.state = m.away ? "away" : "offline";
          if (m.away) { this.offices = []; this.knocks = []; this.knocking = []; }
          break;
        case "lobby":
          this.offices = (m.offices || []).map(o => ({ id: String(o.id), name: String(o.name), status: String(o.status), sim: o.sim || {},
            maxVisitors: Number(o.max_visitors) || 0, visitors: Number(o.visitors) || 0, visiting: o.visiting || null, ready: o.ready === true,
            key: typeof o.key === "string" ? o.key : null, links: o.links === true, whisper: o.whisper === true }));
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
        case "avatar_none": this._avatarNone(m); break;
        case "body": this._bodyIn(m); break;
        case "possessions": { const h = this._hosted.get(m.channel); if (h) h.possessions = possessionsFrom(m.list); break; }
        case "possession": this._possessionIn(m); break;
        case "phone": if (m.on) this._phoneOn.add(m.channel); else { this._phoneOn.delete(m.channel); const p = this._peerOf(m.channel); if (p && p.key) this._callEnd(p.key, "their phone went", false); } break;
        case "call": this._callIn(m); break;
        case "layout": this.layout = Array.isArray(m.layout) ? m.layout : []; break;
        case "chat": this._chatMsg(m, false); break;
        case "unseen": {   // the mailbox (8.9): lines meant for you that came while nobody looked, until read
          const lines = [];
          for (const l of Array.isArray(m.lines) ? m.lines : []) { const c = isObj(l) && this._chatFrom(l, true); if (c) lines.push(this._lineOf(c, true)); }
          this.unseen = { count: Number(m.count) || 0, lines,
            conversations: (Array.isArray(m.conversations) ? m.conversations : []).filter(c => isObj(c) && typeof c.conversation === "string").map(c => ({ conversation: c.conversation, count: Number(c.count) || 0 })) };
          this._emit("unseen", this.unseen); this._changed(); break;
        }
        case "held": this.held = (Array.isArray(m.held) ? m.held : []).filter(h => isObj(h) && typeof h.id === "string")
          .map(h => ({ id: h.id, key: String(h.key || ""), name: String(h.name || ""), text: String(h.text || ""), at: Number(h.at) || 0 })); this._emit("held", this.held); this._changed(); break;
        case "held_sent": this._emit("held_sent", { id: String(m.id || ""), key: String(m.key || ""), name: String(m.name || ""), text: String(m.text || ""), at: Number(m.at) || 0 }); break;
        case "media_ready": {   // a picture shared, kept by the visit-client (8.12): its id
          const put = this._puts.get(m.slot);
          if (put) { this._puts.delete(m.slot); clearTimeout(put.t); put.resolve({ id: String(m.id), mime: String(m.mime), size: Number(m.size) || 0 }); }
          break;
        }
        case "media_none": { const w = this._mediaWait.get(m.id); this._mediaWait.delete(m.id); this._media.delete(m.id); if (w) w(null); break; }
        case "preview": case "history": case "shared": { const a = this._asks.get(m.req); if (a) { this._asks.delete(m.req); a.resolve(m); } break; }
        case "bans": this.bans = bansFrom(m.bans); this._changed(); break;
        case "user": if (typeof m.name === "string" && m.name) this._users.set(String(m.key), m.name); else this._users.delete(String(m.key)); this._changed(); break;
        case "banned": {   // a room that keeps your user out of its voice or its chat (8.9), or no longer
          const b = bansFrom([m])[0];
          if (!b) break;
          this.bannedBy = this.bannedBy.filter(x => x.key !== b.key).concat(b.voice || b.chat ? [b] : []);
          this._emit("banned", b); this._changed(); break;
        }
        case "room_voice": this._roomVoiceFrom(m.key == null ? null : m, m.out); break;   // the room voice you are in, who is in it; or none
        case "voice_members": this.voiceMembers = membersFrom(m.members); this._changed(); break;   // who is in your room's voice
        case "chat_log": {   // the chat your user had, kept by the visit-client (8.9): all of it, for a page that comes back
          // (a reload); after a blip, what came meanwhile
          const had = this.chatLog.length ? this.chatLog[this.chatLog.length - 1].at : 0;
          for (const l of Array.isArray(m.lines) ? m.lines : []) if (isObj(l) && Number(l.at) > had && !(had && l.mine)) this._chatMsg(l, true);
          break;
        }
        case "voice_near": {   // who is near your user (8.7): in your room (no channel), or in the one you are in
          const near = (Array.isArray(m.near) ? m.near : []).filter(isObj).map(n => ({ key: String(n.key), name: String(n.name || ""), distance: Number(n.distance) || 0,
            id: typeof n.id === "string" ? n.id : null, phone: n.phone === true }));
          if (m.channel == null) this._nearHome = near; else this._nearBy.set(m.channel, near);
          break;
        }
        case "seen": {   // where a friend has put your room in their world (8.4), or that it is not in it now
          const at = isObj(m.at) ? m.at : null;
          this.seen = this.seen.filter(x => x.key !== m.key).concat(at ? [{ key: String(m.key), name: String(m.name || ""), at }] : []);
          this._emit("seen", { key: m.key, name: m.name, at });
          break;
        }
        case "enter": this._hostEnter(m); break;
        case "exit": this._hostExit(m); break;
        case "enter_refused": this._enterRefused(m); break;
        case "visit_started": this._started(m); break;
        case "visit_ended": this._ended(m); break;
        case "host_paused": case "host_resumed":
          if (this.home && this.home.channel === m.channel) this.home.paused = m.type === "host_paused";
          if (this.visiting && this._viewer && this._viewer.channel === m.channel) this.visiting.paused = m.type === "host_paused";
          if (this._watches.has(m.channel)) this._watches.get(m.channel).paused = m.type === "host_paused";
          if (this._links.has(m.channel)) this._links.get(m.channel).paused = m.type === "host_paused";
          break;
        case "link_stats":
          if (this._viewer && this._viewer.channel === m.channel) { this.stats.rtt = Number(m.rtt_ms); this.stats.path = String(m.path); }
          break;
        case "keyframe": case "input": case "scene_resync": case "point": case "shared_adds": case "landscapes": this._hostMessage(m); break;
        case "landscape": this._landIn(m); break;
        case "plot_forgotten": this._kept.delete(String(m.key)); if (this._world) this._world._keptForget(String(m.key)); break;
        case "scene": this._sceneEdit(m); break;
        case "scene_lost": { const w = this._viewing(m.channel); if (w) this._sceneResync(w); break; }
        case "error": {
          const put = m.ref === "media_put" && this._puts.get(m.slot), a = typeof m.ref === "number" && this._asks.get(m.ref);
          if (put) { this._puts.delete(m.slot); clearTimeout(put.t); put.reject(new Error(m.message || m.code)); }
          if (a) { this._asks.delete(m.ref); a.reject(new Error(m.message || m.code)); }
          this._emit("error", { code: m.code, message: m.message, ref: m.ref });
          break;
        }
      }
    }

    // ---------- actions ----------
    // What is the room's to do, and what the person's (engine/SPEC.md 7): a page of the other role is refused here, as
    // its visit-client would refuse it (`wrong_role`).
    _as(role, what) {
      if (this.role && this.role !== role) {
        const e = new Error(`visit.${what}: the ${role === "host" ? "room's" : "person's"} to do, and this page is the ${this.role === "host" ? "room" : "person"}`);
        e.code = "wrong_role";
        throw e;
      }
    }
    setStatus(status) { this._send({ type: "status", status }); }
    setMaxVisitors(n) { this._send({ type: "max_visitors", n }); }
    rename(name) { this._send({ type: "rename", name }); }
    // A knock: to walk into their room as soon as they let you in. A link (8.5; to an office whose `links` is
    // true): let in, you see their room in a corner (the stage's), from above, and choose: go there (stepIn), put it
    // in your world (toWorld), or not (unlink). To an older office a link is a knock.
    knock(officeId, message = "") { this._as("user", "knock"); this._send({ type: "knock", to: officeId, message }); }
    link(officeId, message = "") { this._as("user", "link"); this._send({ type: "knock", to: officeId, message, link: true }); }
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
      this._as("host", "interactions");
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
      this._as("user", "avatar");
      if (object == null) { this._avatarOwn = null; this._send({ type: "avatar_clear" }); return; }
      if (!object.isObject3D) throw new Error("visit.avatar: a three.js object (or null)");
      const u = Number(unit) > 0 ? Number(unit) : this._unit();
      this._avatarOwn = { object, unit: u };
      this._modelCheck("your avatar", object, u, "avatar");
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
    // ---------- possessions (8.11): what your user owns and brings along; for now, mounts ----------
    // possessions([{ id, name, object, unit, mount, fly, speed, lift }]): what your user owns, as your room makes
    // them (Visit has none of its own: what they are is your room's to say): a three.js object each (its origin at its feet, facing −z, in `unit` metres; clips
    // named idle, walk, run and fly, if it has them); `mount`: it can be ridden; `fly`: it flies; `speed`: times
    // walking pace (1); `lift`: how far up its rider is, in metres (0). A room your user is in is told what they
    // own, and gets a model when it would show it. v.mounts: what they can ride, [{ id, name, fly, speed, lift }];
    // ride(id) gets them on one (null: off), v.riding; v.mount, the one M (the panel's) gets them on. The room they
    // are in decides: one may keep mounts out (`mounts: false`) or anyone from flying (`fly: false`); one that says
    // nothing lets them ride, and a mount that flies, fly.
    possessions(list) {
      this._as("user", "possessions");
      if (!Array.isArray(list) || list.length > POSSESSIONS) throw new Error(`visit.possessions: a list of at most ${POSSESSIONS}`);
      const ids = new Set(), num = (x, d, lo, hi) => x != null && Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : d;
      const own = list.map(p => {
        const id = String((p && p.id) || "");
        if (!/^[A-Za-z0-9_.-]{1,40}$/.test(id) || ids.has(id)) throw new Error(`visit.possessions: "${id}" is not an id of its own (1-40 letters, digits, _ . -)`);
        if (!p.object || !p.object.isObject3D) throw new Error(`visit.possessions: ${id} is a three.js object`);
        ids.add(id);
        const unit = Number(p.unit) > 0 ? Number(p.unit) : this._unit(), c = this._modelCheck(String(p.name || id), p.object, unit, p.mount === true ? "mount" : "thing");
        return { id, name: String(p.name || id).slice(0, 24), object: p.object, unit,
          mount: p.mount === true, fly: p.fly === true, speed: num(p.speed, 1, 0.25, 5), lift: num(p.lift, c && c.seat != null ? c.seat : 0, 0, 5) };   // its "seat" point, unless you say
      });
      this._own = own;
      this._possessionsSend();
      if (this.riding && !this._mountOf(this.riding)) this.ride(null);
      this._changed();
    }
    _possessionsSend() {
      this._send({ type: "possessions", list: this._own.map(({ id, name, mount, fly, speed, lift }) => ({ id, name, mount, fly, speed, lift })) });
      this._own.forEach((p, slot) => this._possessionSend(p, slot));
    }
    async _possessionSend(p, slot) {   // its model, as an avatar goes: gzipped JSON, a frame by its slot in the list
      const text = JSON.stringify({ unit: p.unit, json: sharedJSON(p.object) });
      const gz = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
      if (gz.byteLength > MAX_AVATAR) return this._emit("error", { code: "possession", message: `${p.name} is too big to send (${gz.byteLength} bytes gzipped, at most ${MAX_AVATAR})` });
      if (this._own[slot] !== p || !this._ws || this._ws.readyState !== 1) return;
      const buf = new Uint8Array(11 + gz.byteLength), dv = new DataView(buf.buffer);
      dv.setUint16(0, slot); dv.setUint8(2, POSSESSION); dv.setBigUint64(3, BigInt(Math.round(performance.now() * 1000)));
      buf.set(gz, 11);
      this._ws.send(buf);
    }
    get mounts() { return this._own.filter(p => p.mount).map(({ id, name, fly, speed, lift }) => ({ id, name, fly, speed, lift })); }
    _mountOf(id) { return id ? this.mounts.find(m => m.id === id) || null : null; }
    ride(id) {
      const m = id == null ? null : this._mountOf(String(id));
      if (id != null && !m) throw new Error(`visit.ride: no mount "${id}" (v.mounts)`);
      if (m && m.id !== this.mount) { this.mount = m.id; try { localStorage.setItem("visit:mount", m.id); } catch (e) { /* not kept */ } }
      if ((m ? m.id : null) === this.riding) return;
      this.riding = m ? m.id : null;
      this._sendInput(performance.now(), true);   // the room you are in hears it at once (a world's, at its next frame)
      this._emit("ride", { riding: this.riding });
      this._changed();
    }
    // Your mount, for your own room's walking and drawing at home (8.11): times walking pace, metres up, whether it flies.
    get rideSpeed() { const m = this._mountOf(this.riding); return m ? m.speed : 1; }
    get rideLift() { const m = this._mountOf(this.riding); return m ? m.lift : 0; }
    get rideFly() { const m = this._mountOf(this.riding); return !!(m && m.fly); }
    // Walking ahead of the room's answer: at its pace, and at your mount's when it says riders go at theirs (walk.mounts).
    _rideWalk(w) { const k = this.rideSpeed; return k === 1 || !w || !w.mounts ? w : Object.assign({}, w, { speed: w.speed * k }); }

    // A model of yours, checked as other rooms will read it (checkModel): what is wrong is warned of in the console and
    // said ("model": { what, problems, notes }); the panel says it too.
    _modelCheck(what, object, unit, kind) {
      const T = (this._hooks && this._hooks.scene.three) || (typeof THREE !== "undefined" ? THREE : null);
      if (!T) return null;
      const c = checkModel(object, { three: T, unit, kind });
      if (c.problems.length) console.warn(`visit: ${what}, as other rooms will read it:\n- ` + c.problems.join("\n- "));
      this._emit("model", { what, problems: c.problems, notes: c.notes });
      return c;
    }

    useAvatars(use) { this._send({ type: "avatars", default: use === "theirs" ? "theirs" : "mine" }); }
    useAvatar(key, use) { this._send({ type: "avatar_use", key, use: use === "theirs" || use === "mine" ? use : null }); }
    avatarUse(key) { const b = this.avatars.by.find(x => x.key === key); return b ? b.use : this.avatars.default; }
    // How a visitor hosted here is drawn: as the room's `look` hook says of them ("mine": the room draws them, "theirs":
    // their own model, drawn by Visit), else as the panel has it (avatarUse). A room that poses its owner itself
    // (engine/SPEC.md 4) says "mine" of who.owner.
    _lookUse(h) {
      const hk = this._hooks, say = hk && typeof hk.look === "function" ? hk.look(h.visitor) : undefined;
      return say === "mine" || say === "theirs" ? say : h.visitor.key ? this.avatarUse(h.visitor.key) : "mine";
    }
    _avatarsFrom(m) {
      if (!isObj(m)) return;
      this.avatars = { default: m.default === "theirs" ? "theirs" : "mine",
        by: (Array.isArray(m.by) ? m.by : []).filter(isObj).map(b => ({ key: String(b.key), use: b.use === "theirs" ? "theirs" : "mine" })) };
    }
    // Host side: ask each visitor whose own look this room shows for its avatar, once a visit; and tell each how it is
    // drawn here now (its look changed: their model, or ours).
    _avatarWants() {
      if (this.role === "user") return;   // the room's visits, seen, not served
      for (const h of this._hosted.values()) {
        if (!h.avatarAsked && this._lookUse(h) === "theirs") {
          h.avatarAsked = true;
          this._send({ type: "avatar_want", channel: h.channel });
        }
        this._bodyTell(h);
      }
    }
    // This room's eyes over a visitor's feet (scene units): its `eye`, EYES metres unless it says.
    _eyeRoom() { return (Number(this._hooks && this._hooks.eye) > 0 ? Number(this._hooks.eye) : EYES) / this._unit(); }
    // How a visitor is drawn here (SPEC 8.1, 8.6), said to its visit-client when it changes: as itself (`look`
    // "theirs": its own model, which Visit draws, its eyes that model's) or as this room's model ("mine": the room draws
    // it, its eyes the room's `eye`); and why not as itself, if this room would show it so (`problem`).
    _bodyTell(h) {
      if (h.mirror) return;
      const want = this._lookUse(h) === "theirs", look = want && h.avatar ? "theirs" : "mine";
      const problem = want && !h.avatar ? (h.modelProblem || null) : null;
      h.look = look;
      h.eyes = look === "theirs" ? h.avatar.eyes || this._eyeRoom() : this._eyeRoom();
      const sig = [look, h.eyes.toFixed(3), problem].join("|");
      if (sig === h.bodySaid) return;
      h.bodySaid = sig;
      this._bodyPlace(h);
      this._send({ type: "body", channel: h.channel, look, eyes: h.eyes, problem });
      this._visitorsList();
      this._changed();
    }
    // A visitor's own model in this room's scene, at its feet, facing its way (as its look says; else none: the room
    // draws its own).
    _bodyPlace(h) {
      const a = h.avatar, hk = this._hooks;
      if (!a || !hk) return;
      if (h.look !== "theirs" || !h.pose || !h.inside) { if (a.object.parent) a.object.parent.remove(a.object); return; }
      if (a.object.parent !== hk.scene.root) hk.scene.root.add(a.object);
      a.object.position.set(Number(h.pose.x) || 0, Number(h.pose.y) || 0, Number(h.pose.z) || 0);
      a.object.rotation.set(0, Number(h.pose.yaw) || 0, 0);
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
        const mixer = new T.AnimationMixer(o), idle = clip(/idle/i), walk = clip(/walk/i), ride = clip(/ride|sit/i);
        this._avatarDrop(h);
        h.avatar = { object: body, mixer, idle: idle && mixer.clipAction(idle), walk: walk && mixer.clipAction(walk), ride: ride && mixer.clipAction(ride), playing: null, at: null,
          eyes: modelEyes(T, body) };
        h.modelProblem = null;
      } catch (e) {
        console.warn(`visit: ${h.visitor.name}'s avatar cannot be read`, e);
        h.modelProblem = "it could not be read here: " + String(e && e.message || e).slice(0, 160);
      }
      this._bodyTell(h);
    }
    // Visitor side: how the room we are in (or see) draws us (`body`): our eyes there, for our own world's view of us
    // (8.4), and whether as ourselves; "body" says it, and why not, to the page and its panel.
    _bodyIn(m) {
      const w = this._viewing(m.channel) || this._links.get(m.channel);
      const body = { look: m.look === "theirs" ? "theirs" : "mine", eyes: Number(m.eyes) > 0 ? Number(m.eyes) : null, problem: typeof m.problem === "string" ? m.problem.slice(0, 200) : null };
      this._bodies.set(m.channel, body);
      if (w && w.scene && body.eyes) w.scene.eye = body.eyes;
      const p = this._peerOf(m.channel) || {};
      this._emit("body", Object.assign({ channel: m.channel, key: p.key || null, name: p.name || "" }, body));
      this._changed();
    }
    // A visitor's visit-client said it has no avatar to send: its room never gave one (visit.avatar).
    _avatarNone(m) {
      const h = this._hosted.get(m.channel);
      if (!h || h.avatar) return;
      h.modelProblem = "their room gives no model of its own (visit.avatar)";
      this._bodyTell(h);
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
      const want = h.ride && a.ride ? a.ride : moved > 0.3 / this._unit() ? a.walk || a.idle : a.idle || null;   // riding (8.11): its ride clip
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
    // 0-3 quarter turns; unplaced, it goes in a ring round yours by itself. It is yours alone, nobody agrees to it:
    // each friend in it is told where their own room sits beside yours, and nothing else of it; and you, where
    // yours sits in theirs (`seen`; none of their other friends).
    place(key, { x, z, turn = 0 }) { this._send({ type: "place", key, x, z, turn }); }
    unplace(key) { this._send({ type: "unplace", key }); }
    // This room's plot ({ center, size } in its units: as host() said, or what its scene covers), and in metres.
    _plot() {
      const hk = this._hooks;
      if (!hk) { const hs = this._homeScene(); return hs ? hs.plot : (this.role === "user" ? { center: [0, 0], size: [10, 10] } : null); }
      if (this._plotFrom !== hk) { this._plotFrom = hk; this._plotIs = plotOf(hk.plot, hk.scene.root, hk.scene.three); }
      return this._plotIs;
    }
    _unit() { const hs = !this._hooks && this._homeScene(); return hs ? hs.unit || 1 : this._hooks && Number(this._hooks.unit) > 0 ? Number(this._hooks.unit) : 1; }
    // A user page's own room, as its host sends it (engine/SPEC.md 4), once it has arrived.
    _homeScene() { const w = this.home && this._watches.get(this.home.channel); return w && w.scene ? w.scene : null; }
    _plotMetres() { const p = this._plot(); return p ? p.size.map(x => x * this._unit()) : [10, 10]; }
    // Your friends' plots around your room, and walking onto them (../../WORLD.md): see World.
    world(opts = {}) { this._as("user", "world"); if (this._world) this._world.release(); return new World(this, opts); }
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
        // The owner's visit (engine/SPEC.md 4): the person in their own room, a watch of its plot by its owner, whom
        // the room spawns and walks as it does anyone (who.owner says who). To a user page, the room's visits are to
        // see (the panel's rows), never to serve: a mirror, with nothing sent for it.
        const owner = m.owner === true, mirror = this.role === "user";
        const h = { id: m.id, channel: m.channel, visitor: Object.assign({}, m.peer || {}, owner ? { owner: true } : {}), owner, mirror, guest: m.guest === true, watch: m.watch === true, link: m.link === true,
          inside: m.watch !== true || m.inside === true,
          pose: null, yaw0: 0, input: null, inputAt: 0, keyNext: true, fails: 0, sceneSent: false, posed: null, sharedAdds: m.shared_adds === true,
          landscapes: m.landscapes === true, since: performance.now(), possessions: possessionsFrom(m.possessions), models: new Map(), wanted: new Set(), ride: null };
        if (m.state && m.state.pose && h.inside) { h.pose = m.state.pose; h.yaw0 = m.state.yaw0 || 0; }   // back after this page reloaded
        this._hosted.set(m.channel, h);
        if (owner) this.owner = { id: m.id, channel: m.channel };
        if (h.inside && !mirror) this._spawn(h);
        this._avatarWants();
      } else if (m.watch) {
        // A plot watched (the world's), or a link (8.5): the corner's if it is free, else aside, waiting for it. Or home
        // (engine/SPEC.md 4): the person's own room, a watch they are in, drawn by their world as its own plot.
        const home = m.home === true;
        const w = { id: m.id, channel: m.channel, host: m.peer || {}, watch: true, link: m.link === true, plot: m.link !== true, home, where: m.link ? "aside" : null,
          inside: home && m.inside === true, paused: false, count: 0, scene: null, sceneQ: null, since: performance.now(), loading: false, failed: false };
        if (w.link) this._links.set(m.channel, w); else this._watches.set(m.channel, w);
        if (home) { this.home = { id: m.id, channel: m.channel, paused: false }; if (this._world) this._world.listAt = -1; }
        if (m.inside && !home) this._send({ type: "exit", channel: m.channel });   // this page lost where it was: it starts at home
        if (w.link && m.where === "world") { w.wantWorld = true; if (this._world) this.toWorld(w.id); }   // where it was put, before a reload
        else if (w.link && this._world && this.isGuest(w.host.key)) this.toWorld(w.id);   // a guest's: its plot (_guestLinksToWorld)
        else if (w.link && !this._viewer) this._toCorner(w);
      } else {
        if (this._viewer && this._viewer.link) this._aside(this._viewer);   // a visit: the corner's link waits aside
        this.visiting = { id: m.id, host: m.peer || {}, paused: false, link: false, inside: true };
        this._viewer = { id: m.id, channel: m.channel, count: 0, scene: null, sceneQ: null, since: performance.now(), loading: false, failed: false };
        this._placeholder();
      }
      if (m.phone) this._phoneOn.add(m.channel);
      this._visitorsList();
      this._emit("visit_started", { id: m.id, role: m.role, peer: m.peer, guest: m.guest === true, link: m.link === true });
    }

    _ended(m) {
      this._nearBy.delete(m.channel);
      if (this.home && this.home.id === m.id) this.home = null;
      if (this.owner && this.owner.id === m.id) this.owner = null;
      const h = this._hosted.get(m.channel);
      if (h && h.id === m.id) { this._avatarDrop(h); this._rideDrop(h); this._hosted.delete(m.channel); this._visitorsList(); }
      const w = this._watches.get(m.channel);
      if (w && w.id === m.id) { this._sceneDrop(w); this._landDrop(w); this._watches.delete(m.channel); }
      const l = this._links.get(m.channel);
      if (l && l.id === m.id) { this._links.delete(m.channel); this._sceneDrop(l); this._landDrop(l); }
      if (this.visiting && this.visiting.id === m.id) { if (this._viewer) this._landDrop(this._viewer); this._dropViewer(); this.visiting = null; this._cornerNext(); }
      this._phoneOn.delete(m.channel);
      for (const c of [...this._calls.values()]) if (c.channel === m.channel) this._callEnd(c.key, "their link went", false);
      this._visitorsList();
      this._emit("visit_ended", { id: m.id, reason: m.reason });
    }

    _dropAll() {
      // Visitors' bodies and mounts out of this room's scene with them: they come back, made again, with their visits
      // (were they left, a page that lost its visit-client a moment had two of each).
      for (const h of this._hosted.values()) { this._avatarDrop(h); this._rideDrop(h); }
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
      this.visitors = hs.filter(h => h.inside).map(h => ({ id: h.id, visitor: h.visitor, guest: h.guest, pose: h.pose, link: h.link, owner: !!h.owner,
        look: h.look || "mine", eyes: h.eyes || this._eyeRoom(), problem: h.modelProblem || null, avatar: null,
        riding: h.ride ? { id: h.ride.id, name: h.ride.name, fly: h.ride.fly } : null }));
      this.watchers = hs.filter(h => h.watch && !h.owner).map(h => ({ id: h.id, visitor: h.visitor, inside: h.inside, link: h.link }));
      this.links = [...this._links.values()].map(w => ({ id: w.id, host: w.host, where: w.where, inside: w.inside }));
    }

    // ---------- voice: by who is near, in the same room (8.7); and phones (8.8) ----------
    // Your microphone on or off (remembered, in this browser). On, those in the same room as your user hear them,
    // the nearer the louder, from where they are; nobody farther than voiceRange metres, and nobody in another room
    // (next door in your world included). Off, you still hear those near you. Nothing to join. Its echo is
    // cancelled; headphones are better still.
    async setMic(on) {
      try { localStorage.setItem("visit:mic", on ? "on" : "off"); } catch (e) { /* not kept */ }
      this.mic = !!on;
      if (on) await this._micStart(); else this._micMaybeStop();
      this._changed();
    }
    // Where your user stands and looks in your room, for a room that draws no world (a world says it itself, each
    // frame): in your room's terms, { x, y, z, yaw } (y their feet). Where your voice comes from, and you hear from.
    listener(pose) { this._home = isObj(pose) ? { x: Number(pose.x) || 0, y: Number(pose.y) || 0, z: Number(pose.z) || 0, yaw: Number(pose.yaw) || 0 } : null; }
    // The audio, once: a browser starts it only at a click or a key; until then it waits, and starts at the first.
    _audio() {
      if (this._ctx && this._ctx.state !== "closed") return this._ctx;
      const ctx = this._ctx = new AudioContext({ sampleRate: VOICE_RATE, latencyHint: "interactive" });
      if (ctx.state !== "running") {
        const go = () => { ctx.resume(); if (ctx.state === "running") for (const t of ["pointerdown", "keydown"]) removeEventListener(t, go, true); };
        for (const t of ["pointerdown", "keydown"]) addEventListener(t, go, true);
        ctx.resume().catch(() => {});
      }
      return ctx;
    }
    // The microphone runs while it is on, or a call is: what it hears goes where _voiceTo says (nobody: nothing).
    async _micStart() {
      if (this._mic || this._micStarting) return this._micStarting;
      if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") throw new Error("visit: this browser cannot encode voice (WebCodecs)");
      this._micStarting = (async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        const ctx = this._audio();
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
          if (!this._voiceTo || enc.state !== "configured") return;   // nobody to hear it: nothing encoded, nothing sent
          enc.encode(new AudioData({ format: "f32-planar", sampleRate: VOICE_RATE, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: mic.t, data: pcm }));
          mic.t += pcm.length * 1e6 / VOICE_RATE;
        };
      })().finally(() => { this._micStarting = null; });
      return this._micStarting;
    }
    _micMaybeStop() { if (!this.mic && ![...this._calls.values()].some(c => c.state === "on")) this._micStop(); }
    _micStop() {
      const m = this._mic;
      if (!m) return;
      this._mic = null;
      m.node.port.onmessage = null;
      for (const t of m.stream.getTracks()) t.stop();
      try { m.src.disconnect(); m.node.disconnect(); m.hush.disconnect(); } catch (e) { /* gone */ }
      if (m.enc.state !== "closed") m.enc.close();
    }
    // A packet of your voice, once, to your visit-client: it sends it to those who hear it (where _voiceTo allows).
    _voiceOut(chunk) {
      if (!this._ws || this._ws.readyState !== 1 || !this._voiceTo) return;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this._ws.send(frameOf(this._voiceTo, AUDIO, data));
    }

    // Which room your user is in: their own (at home), one they went to (a visit, a link gone there), or a plot they
    // walked onto in their world; with where they hear from there, in metres: { kind, w (its visit), s (its scene),
    // ears: { x, y, z, yaw } } (no ears: a room without a world that has not said listener()).
    _room() {
      const v = this._viewer;
      if (this._inRoom() && v && v.scene && v.scene.pose) {
        const s = v.scene, k = s.unit || 1;
        return { kind: "visit", w: v, s, k, ears: { x: s.pose.x * k, y: (s.pose.y + s.vis.y) * k, z: s.pose.z * k, yaw: s.yaw0 + (this._view ? this._view.yaw : 0) } };
      }
      const h = this._home, k = this._unit(), ears = h && { x: h.x * k, y: h.y * k + 1.6, z: h.z * k, yaw: h.yaw };
      const wd = this._world, w = wd && wd.inside && this._watches.get(wd.in);
      if (w && w.scene && w.home) {   // the person at home, their room a plot their world has them in (engine/SPEC.md 4): heard from where its host has them
        const s = w.scene, ks = s.unit || 1;
        return { kind: "home", w, s, k: ks, ears: { x: s.pose.x * ks, y: (s.pose.y + s.vis.y) * ks, z: s.pose.z * ks, yaw: wd.look.yaw } };
      }
      if (w && w.scene) return { kind: "plot", w, s: w.scene, k, ears };
      return { kind: "home", k, ears };
    }
    // Where something in a room's scene is, in metres in the frame the ears are in (a plot's: your world's).
    _where(s, o, k) { o.updateWorldMatrix(true, false); const p = o.getWorldPosition(s.v); return { x: p.x * k, y: p.y * k, z: p.z * k }; }
    // A visitor's body in a room's scene, by its visit there (as the room marks it: userData.visitor).
    _body(s, id) {
      const now = performance.now();
      if (!s.bodies || now - s.bodiesAt > 1000) { s.bodiesAt = now; s.bodies = new Map(); s.root.traverse(o => { if (o.userData && typeof o.userData.visitor === "string") s.bodies.set(o.userData.visitor, o); }); }
      const o = s.bodies.get(id);
      return o && o.parent ? o : null;
    }
    // Who your user could hear in the room they are in, and where each is (metres): at home, your visitors (where
    // you have them); in another's room, its owner (the mark its room keeps where they stand) and its other visitors
    // whose voices it passes on (their bodies there). Each by a key of its own: an office's, or "relay:" a visit's.
    _near(r) {
      const out = new Map();
      if (r.kind === "home") {
        if (r.s) {   // a user page: its visitors where their bodies are in the room's scene (as the room marks them)
          for (const h of this._hosted.values()) if (h.inside && h.visitor.key && !h.owner) { const b = this._body(r.s, h.id); if (b) out.set(h.visitor.key, Object.assign({ key: h.visitor.key, name: h.visitor.name || "", channel: h.channel }, this._where(r.s, b, r.k))); }
        } else for (const h of this._hosted.values()) if (h.inside && h.pose && h.visitor.key && !h.owner) out.set(h.visitor.key, { key: h.visitor.key, name: h.visitor.name || "", channel: h.channel,
          x: h.pose.x * r.k, y: (Number(h.pose.y) || 0) * r.k, z: h.pose.z * r.k });
        for (const x of this._worldNear()) if (!out.has(x.key)) out.set(x.key, x);
        return out;
      }
      const m = r.s.mark || (r.s.mark = r.s.root.getObjectByName("visit:me")), host = r.w.host || (this.visiting && this.visiting.host) || {};
      let shown = !!m;
      for (let o = m; o && shown; o = o.parent) if (!o.visible) shown = false;
      if (shown && host.key) out.set(host.key, Object.assign({ key: host.key, name: host.name || "", channel: r.w.channel }, this._where(r.s, m, r.k)));
      for (const [id, x] of r.s.relayed || []) {
        const b = id === "phone" || id.startsWith("phone:") ? r.s.root.getObjectByName("visit:phone") : this._body(r.s, id);   // a call on the room's speaker: from its phone
        if (b && performance.now() - x.at < 2000) out.set("relay:" + id, Object.assign({ key: "relay:" + id, name: x.name, channel: r.w.channel }, this._where(r.s, b, r.k)));
      }
      return out;
    }
    // Your friends at home in their own rooms, each a plot in your world, and where your world has them (8.7: across a
    // plot's side), in metres: by the mark each room keeps where its owner stands (none while they are away).
    _worldNear() {
      const wd = this._world, out = [];
      if (!wd) return out;
      const k = this._unit();
      for (const x of wd.list) {
        const w = x.w, s = w && w.scene;
        if (!s || w.inside || !w.host || !w.host.key) continue;
        let m = s.mark;
        if (!m || !m.parent) m = s.mark = s.root.getObjectByName("visit:me");
        let shown = !!m;
        for (let o = m; o && shown; o = o.parent) if (!o.visible) shown = false;
        if (shown) out.push(Object.assign({ key: w.host.key, name: w.host.name || "", channel: w.channel }, this._where(s, m, k)));
      }
      return out;
    }
    // 30 times a second: where everyone in your room is (to your visit-client, which decides who hears whom there);
    // who is near your user, as the room they are in says (an older one says nothing: then by where its scene has
    // them); whether your voice goes anywhere; and where each voice comes from.
    _voiceTick() {
      const r = this._room(), range = this.voiceRange, near = r.ears ? this._near(r) : new Map();
      for (const p of near.values()) p.distance = Math.hypot(p.x - r.ears.x, p.z - r.ears.z);
      this._voiceRoom = r;
      this._voiceWhere(r);
      const now = performance.now(), told = r.kind === "home" ? this._nearHome : this._nearBy.get(r.w.channel);
      const speaking = k => { const s = this._voices.get(k); return !!s && now - s.heardAt < 400; };
      this.voices = told
        ? told.map(n => { const key = r.kind === "home" ? n.key : n.phone ? "relay:phone" : n.id ? "relay:" + n.id : n.key;
            return { key, name: n.name, distance: n.distance, speaking: n.phone ? [...this._voices.keys()].some(k => k.startsWith("relay:phone") && speaking(k)) : speaking(key) }; })
        : [...near.values()].filter(p => p.distance <= range).map(p => ({ key: p.key, name: p.name, distance: Math.round(p.distance * 10) / 10, speaking: speaking(p.key) }));
      const room = this.mic && !!r.ears && (this.voices.length > 0 || (r.kind !== "home" && !told)), calls = [...this._calls.values()].some(c => c.state === "on");
      const rv = this.roomVoice, chan = this.mic && !!rv && !rv.joining && rv.members.some(x => x.key !== this.key);
      this._voiceTo = (room ? VOICE_ROOM : 0) | (calls ? VOICE_CALLS : 0) | (chan ? VOICE_CHANNEL : 0);
      for (const c of this._calls.values()) c.speaking = speaking("call:" + c.key);
      const heard = x => { const was = x.speaking; x.speaking = x.key !== this.key && (speaking("room:" + x.key) || speaking(x.key) || speaking("call:" + x.key)); return was !== x.speaking; };   // however you hear them
      let flip = false;
      for (const x of [...(rv ? rv.members : []), ...this.voiceMembers]) flip = heard(x) || flip;
      if (flip) this._emit("voice", rv);
      const ku = this._unit(), pa = this._phoneAt, phone = pa && r.ears && r.kind === "home" && { x: pa.x * ku, y: (pa.y || 0) * ku, z: pa.z * ku };   // your phone, in your room
      const ctx = this._ctx;
      if (ctx && r.ears) {
        const l = ctx.listener, t = ctx.currentTime, fx = -Math.sin(r.ears.yaw), fz = -Math.cos(r.ears.yaw);
        if (l.positionX) { l.positionX.setValueAtTime(r.ears.x, t); l.positionY.setValueAtTime(r.ears.y, t); l.positionZ.setValueAtTime(r.ears.z, t);
          l.forwardX.setValueAtTime(fx, t); l.forwardY.setValueAtTime(0, t); l.forwardZ.setValueAtTime(fz, t); l.upX.setValueAtTime(0, t); l.upY.setValueAtTime(1, t); l.upZ.setValueAtTime(0, t); }
        else { l.setPosition(r.ears.x, r.ears.y, r.ears.z); l.setOrientation(fx, 0, fz, 0, 1, 0); }
      }
      for (const s of this._voices.values()) {
        if (s.room) continue;   // a room voice: not from anywhere
        const c = s.callKey && this._calls.get(s.callKey);
        let p = near.get(s.key);
        if (c && c.speaker) {   // a call on speaker: from your phone, heard where you are in your room
          p = r.kind === "home" && phone ? Object.assign({ distance: Math.hypot(phone.x - r.ears.x, phone.z - r.ears.z) }, phone) : null;
        } else if (c) continue;   // on the handset: to your ear, not from anywhere
        s.near = !!p && p.distance <= range;
        if (!p || !ctx) continue;
        s.panner.maxDistance = range;
        if (s.panner.positionX) { s.panner.positionX.setValueAtTime(p.x, ctx.currentTime); s.panner.positionY.setValueAtTime(p.y, ctx.currentTime); s.panner.positionZ.setValueAtTime(p.z, ctx.currentTime); }
        else s.panner.setPosition(p.x, p.y, p.z);
      }
    }
    // Where everyone in your room is, in metres, for your visit-client (8.7): your user while they are at home (where
    // your world, or listener(), has them), your phone, and each visitor in it (where your room has them). Sent when
    // it changes, at most ten times a second.
    _voiceWhere(r) {
      const k = this._unit(), q = x => Math.round(x * 10) / 10, pa = this._phoneAt;
      // The room says where everyone in it is, its owner among them (engine/SPEC.md 3.3: the owner is a visitor of its
      // own; their ears, their eyes); the person says where their world has their friends; a page that is both, both.
      const o = this.owner && this._hosted.get(this.owner.channel), ownerAt = o && o.inside && o.pose ? [q(o.pose.x * k), q(((Number(o.pose.y) || 0) + (o.eyes || 0)) * k), q(o.pose.z * k)] : null;
      const where = this.role === "user" ? { world: r.kind === "home" ? this._worldNear().map(x => [x.key, q(x.x), q(x.y), q(x.z)]) : [] }
        : { me: this.role === "host" ? ownerAt : r.kind === "home" && r.ears ? [q(r.ears.x), q(r.ears.y), q(r.ears.z)] : null, phone: pa ? [q(pa.x * k), q((pa.y || 0) * k), q(pa.z * k)] : null,
          visitors: [...this._hosted.values()].filter(h => h.inside && h.pose).map(h => [h.channel, q(h.pose.x * k), q((Number(h.pose.y) || 0) * k), q(h.pose.z * k)]),
          world: this.role !== "host" && r.kind === "home" ? this._worldNear().map(x => [x.key, q(x.x), q(x.y), q(x.z)]) : [] };
      const sig = JSON.stringify(where), now = performance.now();
      if (sig === this._whereTold.sig || now - this._whereTold.at < 100 || !this._ws || this._ws.readyState !== 1) return;
      Object.assign(this._whereTold, { sig, at: now });
      this._send(Object.assign({ type: "voice_where" }, where));
    }
    // A packet of someone's voice, sent here because your visit-client has you hear it, one way only (8.7: in person
    // first, then a call, then a room voice; its route says which). A room voice's: who spoke (their key), heard as
    // they are, not from anywhere. A call's: theirs, or (passed on) someone near their phone on speaker, heard as a
    // call is (_callVoice). In person, passed on by the room your user is in: from where its scene has them. Another
    // office's own: from where it is (in your room, the one you are in, or across your plot's side).
    _voiceIn(ch, data, relayed, route) {
      let id = null, name = "";
      if (relayed) {
        if (data.length < 3) return;
        const n = data[0];
        id = new TextDecoder().decode(data.subarray(1, 1 + n));
        const m = data[1 + n];
        name = new TextDecoder().decode(data.subarray(2 + n, 2 + n + m)); data = data.subarray(2 + n + m);
      }
      const p = this._peerOf(ch), call = p && p.key && this._calls.get(p.key);
      if (route === ROUTE_VOICE) {
        if (!relayed || !id || !this.roomVoice) return;
        const s = this._voiceOf("room:" + id);
        s.room = true; s.name = name;
        return this._voiceDecode(s, data);
      }
      if (route === ROUTE_CALL) return call && call.state === "on" ? this._callVoice(call, "call:" + (relayed ? id : p.key), relayed ? name : p.name || "", data) : undefined;
      if (relayed) {
        const r = this._voiceRoom;
        if (!r || r.kind === "home" || r.w.channel !== ch) return;
        (r.s.relayed || (r.s.relayed = new Map())).set(id, { name, at: performance.now() });
        return this._voiceDecode(this._voiceOf("relay:" + id), data);   // where they are, and whether near: _voiceTick
      }
      if (p && p.key) this._voiceDecode(this._voiceOf(p.key), data);
    }
    // A call's voice: on the handset, to your ear; on speaker, from your phone (to you, by where you are in your
    // room; your visit-client passes it on to your visitors near the phone, as the phone's).
    _callVoice(c, key, name, data) {
      const s = this._voiceOf(key);
      s.callKey = c.key; s.name = name;
      this._voiceDecode(s, data);
    }
    // Someone's voice: a decoder of its own, played by distance (a panner), or as a telephone (a filter).
    _voiceOf(key) {
      let s = this._voices.get(key);
      if (s) return s;
      const ctx = this._audio(), gain = ctx.createGain(), panner = ctx.createPanner(), phone = ctx.createBiquadFilter(), flat = ctx.createGain();
      Object.assign(panner, { panningModel: "HRTF", distanceModel: "linear", refDistance: 1, maxDistance: VOICE_RANGE, rolloffFactor: 1 });
      phone.type = "bandpass"; phone.frequency.value = 1400; phone.Q.value = 0.7;   // a call to your ear sounds as a telephone does
      gain.connect(panner); panner.connect(ctx.destination); phone.connect(ctx.destination); flat.connect(ctx.destination);
      s = { key, gain, panner, phone, flat, next: 0, ts: 0, level: 0, heardAt: 0, frames: 0, near: false, callKey: null, room: false, dec: null };
      s.dec = new AudioDecoder({ output: d => this._voicePlay(s, d), error: e => { console.warn("visit: a voice could not be decoded", e); this._voiceDrop(key); } });
      s.dec.configure({ codec: "opus", sampleRate: VOICE_RATE, numberOfChannels: 1 });
      this._voices.set(key, s);
      return s;
    }
    _voiceDecode(s, data) { if (s.dec.state === "configured") s.dec.decode(new EncodedAudioChunk({ type: "key", timestamp: (s.ts += 20000), data })); }
    _voicePlay(s, d) {
      const ctx = this._ctx, n = d.numberOfFrames, buf = ctx.createBuffer(1, n, d.sampleRate), pcm = buf.getChannelData(0);
      try { d.copyTo(pcm, { planeIndex: 0, format: "f32-planar" }); } catch (e) { d.close(); return; }
      d.close();
      s.level = rms(pcm); s.frames++;
      if (s.level > 0.01) s.heardAt = performance.now();
      const c = s.callKey && this._calls.get(s.callKey), out = s.room ? s.flat : c && c.state === "on" ? (c.speaker ? (s.near ? s.gain : null) : s.phone) : s.near ? s.gain : null;
      if (!out) return;
      const src = ctx.createBufferSource(), now = ctx.currentTime;
      src.buffer = buf; src.connect(out);
      if (s.next < now || s.next > now + VOICE_LATE) s.next = now + VOICE_LEAD;
      src.start(s.next);
      s.next += buf.duration;
    }
    _voiceDrop(key) {
      const s = this._voices.get(key);
      if (!s) return;
      this._voices.delete(key);
      if (s.dec.state !== "closed") s.dec.close();
      for (const n of [s.gain, s.panner, s.phone, s.flat]) n.disconnect();
    }
    _peerOf(ch) {
      const h = this._hosted.get(ch);
      if (h) return h.visitor;
      const w = this._viewing(ch) || this._links.get(ch);
      return w ? (w.host || (this.visiting && this.visiting.host)) : null;
    }

    // ---------- telemetry: how this page is doing (v.perf) ----------
    // On (the panel's ⏱, or v.perf(true); remembered in this browser), a second at a time: this page's frames (how
    // many, the slowest), long tasks (the page stopped 50 ms or more: a stutter), and Visit's own work by part, in ms
    // (scan: this room's scene looked over for changes; send: its edits made ready; whole: rooms sent whole to visitors
    // starting; landscape: made again; world: your world walked and laid out; voice), apart from what is not Visit's
    // own work: draw (your room and its plots drawn, by world.render: your room's own drawing, in a world) and textures
    // (canvases encoded in the background: how many, and how long each took, off the page's main thread), with how much
    // it had to do. Shown in a corner of the page; nothing leaves
    // it. v.perfReport(): the last two minutes, a row a second, to copy.
    perf(on = true) {
      try { localStorage.setItem("visit:perf", on ? "on" : "off"); } catch (e) { /* not kept */ }
      if (!on) { if (this._perf) { this._perf.stop(); this._perf = null; } return this._changed(); }
      if (this._perf) return;
      const p = this._perf = { at: performance.now(), cur: {}, rows: [], frames: [], last: performance.now(), long: [], running: true, el: null, obs: null };
      const frame = t => { if (!p.running) return; p.frames.push(t - p.last); p.last = t; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      try { p.obs = new PerformanceObserver(l => { for (const e of l.getEntries()) p.long.push(e.duration); }); p.obs.observe({ type: "longtask" }); } catch (e) { p.obs = null; }
      const el = p.el = document.createElement("div");
      el.className = "visit-perf";
      el.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:30;max-width:min(560px,calc(100vw - 16px));padding:6px 8px;border-radius:8px;" +
        "font:11px/1.45 ui-monospace,Consolas,monospace;color:#e6edf3;background:rgba(13,17,23,.88);border:1px solid #2d333b;white-space:pre-wrap";
      el.addEventListener("click", e => {
        const b = e.target.closest("button[data-p]");
        if (b && b.dataset.p === "copy") navigator.clipboard.writeText(JSON.stringify(this.perfReport(), null, 1)).then(() => { b.textContent = "copied"; }, () => { b.textContent = "could not copy"; });
        else if (b) this.perf(false);
      });
      document.body.appendChild(el);
      p.stop = () => { p.running = false; if (p.obs) p.obs.disconnect(); el.remove(); };
      el.textContent = "⏱ measuring…";
      this._changed();
    }
    perfReport() { return this._perf ? this._perf.rows.slice() : []; }
    _pt(part, ms) {
      const p = this._perf;
      if (!p) return;
      const x = p.cur[part] || (p.cur[part] = { n: 0, ms: 0, max: 0 });
      x.n++; x.ms += ms; if (ms > x.max) x.max = ms;
    }
    _perfRoll(now) {
      const p = this._perf, secs = (now - p.at) / 1000, r1 = x => Math.round(x * 10) / 10, sync = this._sync, w = this._world;
      const gaps = p.frames.splice(0).sort((a, b) => a - b), long = p.long.splice(0);
      const parts = Object.fromEntries(Object.entries(p.cur).map(([k, x]) => [k, { n: x.n, ms: r1(x.ms / secs), max: r1(x.max) }]));
      const row = { t: Date.now(), fps: Math.round(gaps.length / secs), frame_p95_ms: gaps.length ? r1(gaps[Math.floor(gaps.length * 0.95)]) : null,
        frame_max_ms: gaps.length ? r1(gaps[gaps.length - 1]) : null, long_tasks: long.length, long_max_ms: long.length ? r1(Math.max(...long)) : 0, parts,
        counts: { visitors: [...this._hosted.values()].filter(h => h.inside).length, watchers: [...this._hosted.values()].filter(h => h.watch && !h.inside).length,
          plots: w ? w.plots.filter(x => !x.home).length : 0, offline: w ? w.plots.filter(x => x.offline).length : 0, objects: sync ? sync.objs.size : 0,
          landscape: sync ? sync.statics.length : 0, voices: this.voices.length, visiting: !!(this.visiting && this.visiting.inside) } };
      p.rows.push(row); if (p.rows.length > 120) p.rows.shift();
      p.cur = {}; p.at = now;
      const own = ["scan", "send", "whole", "landscape", "world", "voice"], all = own.reduce((n, k) => n + (parts[k] ? parts[k].ms : 0), 0), c = row.counts;
      const line = k => parts[k] ? `${k} ${parts[k].ms}${parts[k].max >= 8 ? ` (slowest ${parts[k].max})` : ""}` : null;
      p.el.innerHTML = `<b>⏱ ${row.fps} fps</b> · slowest frame ${row.frame_max_ms ?? "–"} ms · ${row.long_tasks ? `<span style="color:#f85149">${row.long_tasks} stall${row.long_tasks > 1 ? "s" : ""} (${row.long_max_ms} ms)</span>` : "no stalls"}\n`
        + `Visit ${r1(all)} ms a second: ${own.map(line).filter(Boolean).join(" · ") || "idle"}`
        + (parts.draw ? `\ndrawing your room${c.plots ? " and its plots" : ""}: ${parts.draw.ms} ms a second (${r1(parts.draw.ms / Math.max(1, parts.draw.n))} a frame)` : "")
        + (parts.textures ? `\npictures sent: ${parts.textures.n} (encoded in the background, off the page: ${parts.textures.max} ms at most)` : "")
        + `\n${c.visitors} visitor${c.visitors === 1 ? "" : "s"} · ${c.watchers} watching · ${c.plots} plot${c.plots === 1 ? "" : "s"}${c.offline ? ` (${c.offline} offline)` : ""} · ${c.objects} objects`
        + `${c.landscape ? ` + ${c.landscape} landscape` : ""}${c.voices ? ` · ${c.voices} near` : ""}\n`
        + `<button data-p="copy" style="font:inherit;color:inherit;background:#161b22;border:1px solid #2d333b;border-radius:5px;padding:1px 6px;cursor:pointer">copy report</button> <button data-p="off" style="font:inherit;color:inherit;background:#161b22;border:1px solid #2d333b;border-radius:5px;padding:1px 6px;cursor:pointer">off</button>`;
    }

    // ---------- chat (8.9) ----------
    // Say a line, where `to` says, as a game's chat does:
    //   nothing (or "here"): everyone who can see you: the room your user is in, over your head for a few seconds
    //     (you too, over yours), and those who have that room in their world or in a corner; nobody else.
    //   { whisper } (an office's id, or its key): its user alone, wherever they are, in their chat (v.whisperTargets:
    //     those in the lobby who take whispers). The lobby passes it on, and keeps nothing.
    //   "room": your room's chat: everyone in your room, and every office linked with yours, either way, has it in
    //     their chat, wherever they are (as you have what is said in theirs).
    //   { key } (or a key): a linked room's chat, the room of an office you are linked with, either way
    //     (v.chatTargets): everyone in it, and linked with it, has it in their chat, wherever you are.
    //   "lobby": everyone in the lobby has it in their chat (v.lobbyChat: a lobby that relays it, and you in it).
    // Plain text, at most 200 characters, 5 lines every 10 s wherever they go (false: not said). "chat" says each line
    // that comes: { scope ("say", "whisper", "sim" or "lobby"), key, name, text, mine, owner, id, channel, to } (`to`,
    // yours: whom you whispered, { id, key, name }; a "sim" line's: the room whose chat it was said in, { key, name },
    // yours with your key; `id`, a whisper's or lobby line's: the sayer's office; `old`, from before this page, kept by
    // the visit-client: a reload keeps the chat); v.chatLog, the last 100; v.chats, the lines
    // over heads still showing. Visit draws those in the views it draws (your world, and another's room); a room
    // without a world draws its own (Visit.bubble). Visit.chat, the chat window (the panel's), shows them all.
    say(text, to, { media = [], links = [] } = {}) {
      this._as("user", "say");
      const t = [...String(text == null ? "" : text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()].slice(0, CHAT_LEN).join("").trim(), now = Date.now();
      const scope = to == null || to === "here" ? "say" : to === "lobby" ? "lobby" : isObj(to) && to.whisper != null ? "whisper" : "sim";
      const target = to === "room" ? { key: this.key || "", name: this.office ? this.office.name : "" }
        : scope === "sim" ? this.chatTargets.find(o => o.key === String(isObj(to) ? to.key : to))
        : scope === "whisper" ? this.whisperTargets.find(o => o.id === String(to.whisper) || (o.key && o.key === String(to.whisper))) : null;
      // Someone away (not in the lobby), by their key: your visit-client keeps it for them (text only).
      const away = scope === "whisper" && !target && /^[0-9a-f]{64}$/.test(String(to.whisper)) ? { key: String(to.whisper), name: String(to.name || this._nameOf(String(to.whisper)) || "") } : null;
      const pics = picturesFrom(media), cards = linksFrom(links), shares = pics.length + cards.length > 0;
      if (away) {
        this._said = this._said.filter(at => now - at < CHAT_WINDOW);
        if (!t || shares || this._said.length >= CHATS || !this._ws || this._ws.readyState !== 1) return false;
        this._said.push(now);
        this._send({ type: "say", text: t, to: { whisper: away.key, name: away.name } });
        this._chatIn({ key: this.key || "", name: this._userName || (this.office ? this.office.name : ""), text: t, mine: true, owner: false, id: null, scope, held: true,
          to: { key: away.key, name: away.name }, conversation: "person:" + away.key });
        return true;
      }
      const att = { ...(pics.length ? { media: pics } : {}), ...(cards.length ? { links: cards } : {}) };
      this._said = this._said.filter(at => now - at < CHAT_WINDOW);
      if ((!t && !shares) || this._said.length >= CHATS || !this._ws || this._ws.readyState !== 1) return false;
      if (((scope === "sim" || scope === "whisper") && !target) || ((scope === "lobby" || (scope === "whisper" && !shares)) && !(this.lobbyChat && this.state === "online"))) return false;
      if (shares && (scope === "lobby" || (scope === "whisper" && !this.chatTargets.some(o => o.key === target.key)))) return false;   // pictures and links: not through the lobby
      this._said.push(now);
      this._send(scope === "say" ? { type: "say", text: t, ...att } : { type: "say", text: t, to: scope === "lobby" ? "lobby" : to === "room" ? "room" : scope === "whisper" ? { whisper: target.id } : { key: target.key }, ...att });
      const me = { key: this.key || "", name: this._userName || (this.office ? this.office.name : ""), text: t, mine: true, owner: false, id: null, ...att };
      if (scope === "say") { const r = this._room(); this._chatIn({ ...me, room: r.kind === "home" ? "home" : r.w.channel, conversation: this._conversationHere() }); }
      else if (scope === "sim") this._chatIn({ ...me, scope, to: { key: target.key, name: target.name }, conversation: "room:" + target.key });
      else if (scope === "whisper") this._chatIn({ ...me, scope, to: { id: target.id, key: target.key, name: target.name }, conversation: "person:" + (target.key || "id:" + target.id) });
      return true;   // (a lobby line comes back from the lobby, in its order)
    }
    // A line one of your room's own figures says (8.9: a receptionist, a guide; never a person): `id` names it, 1 to 40
    // letters, digits, _ . or -, and its object in your scene is named "visit:npc:<id>" (its bubble goes over it);
    // `name` is what it goes by in everyone's chat. Said in your room, to everyone who can see it, and kept in its
    // chat; never as your user, and on a limit of its own (each figure CHATS lines every CHAT_WINDOW). False if not sent.
    sayAs(id, name, text) {
      const t = [...String(text == null ? "" : text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()].slice(0, CHAT_LEN).join("").trim(), now = Date.now();
      const i = String(id == null ? "" : id), n = String(name == null ? "" : name).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(i) || !n || !t || !this._ws || this._ws.readyState !== 1) return false;
      const said = (this._saidAs.get(i) || []).filter(at => now - at < CHAT_WINDOW);
      if (said.length >= CHATS) return false;
      this._saidAs.set(i, said.concat(now));
      this._send({ type: "say_as", id: i, name: n, text: t });
      return true;   // (it comes back from the visit-client as your room's line, kept)
    }
    // The conversation of the room your user is in (8.12): "room:" its owner's key.
    _conversationHere() {
      const r = this._room();
      return "room:" + (r.kind === "home" ? this.key || "" : ((r.w && r.w.host) || (this.visiting && this.visiting.host) || {}).key || "");
    }

    // ---------- who you are (8.9) ----------
    // The name your user goes by (1 to 24 characters; null: your office's), shown to others with what they say, over
    // their voice, in a room's voice, and in their panel: told to everyone linked with you, now and as they link.
    setName(name) {
      this._as("user", "setName");
      const n = name == null ? null : [...String(name).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()].slice(0, 24).join("").trim() || null;
      if (n === this._userName) return;
      this._userName = n;
      this._send({ type: "user", name: n });
      this._changed();
    }
    get userName() { return this._userName; }
    // The name the user of the office with this key goes by, if they said one (else null: their office's name).
    userOf(key) { return this._users.get(key) || null; }

    // ---------- pictures and links in chat (8.12) ----------
    // Share a picture (a Blob or File, as pasted or dropped: PNG, JPEG, WebP or GIF; a bigger one, or another kind, is
    // made smaller as WebP first), or a voice message (0.22.0: a recording, WebM, Ogg or MP4, at most a minute and
    // 2 MB): kept by your visit-client, in its database. Resolves to { id, mime, size }, for say(text, to, { media: [it] })
    // (a voice message's with `secs`, how long it is: at most one a line).
    async share(blob) {
      if (!blob || typeof blob.arrayBuffer !== "function") throw new Error("visit.share: a picture or a recording (a Blob or a File)");
      const voice = /^audio\//.test(blob.type);
      if (voice && blob.size > VOICE_MAX) throw new Error("visit.share: a voice message is at most a minute (2 MB)");
      const b = voice || (blob.size <= MEDIA_MAX && MEDIA_KINDS.includes(blob.type)) ? blob : await smaller(blob);
      const bytes = new Uint8Array(await b.arrayBuffer());
      if (!this._ws || this._ws.readyState !== 1) throw new Error("visit.share: not connected to visit-client");
      const slot = this._slot = (this._slot % 65535) + 1;
      const kept = new Promise((resolve, reject) => {
        const t = setTimeout(() => { this._puts.delete(slot); reject(new Error("visit-client did not answer")); }, 30000);
        this._puts.set(slot, { resolve, reject, t });
      });
      const f = new Uint8Array(11 + bytes.length);
      new DataView(f.buffer).setUint16(0, slot); f[2] = MEDIA; f.set(bytes, 11);
      this._ws.send(f);
      const m = await kept;
      if (!this._media.has(m.id)) this._media.set(m.id, Promise.resolve(URL.createObjectURL(b)));
      return m;
    }
    // A picture by its id, as a URL this page can show: once your visit-client has it (it asks whoever sent it), or
    // null if it cannot be had.
    media(id) {
      let p = this._media.get(id);
      if (p) return p;
      p = new Promise(resolve => {
        this._mediaWait.set(id, resolve);
        this._send({ type: "media_get", id: String(id) });
        setTimeout(() => { if (this._mediaWait.get(id) === resolve) { this._mediaWait.delete(id); this._media.delete(id); resolve(null); } }, 90000);
      });
      this._media.set(id, p);
      return p;
    }
    _mediaIn(b) {
      if (b.length < 3) return;
      const n = b[0], m = b[1 + n], id = new TextDecoder().decode(b.subarray(1, 1 + n)), mime = new TextDecoder().decode(b.subarray(2 + n, 2 + n + m));
      const url = URL.createObjectURL(new Blob([b.slice(2 + n + m)], { type: mime }));
      this._media.set(id, Promise.resolve(url));
      const w = this._mediaWait.get(id);
      this._mediaWait.delete(id);
      if (w) w(url);
    }
    // A link's preview, made by your visit-client (it fetches the page once; those you send it to never do):
    // { url, title, description, site, image } (image: a picture's { id, mime, size }), or null.
    async preview(url) {
      if (!/^https?:\/\/\S+$/.test(String(url))) return null;
      const m = await this._ask("preview", { url: String(url) }, 12000);
      return m.none ? null : linksFrom([{ ...m, url: String(url) }])[0] || null;
    }
    // The chat before a moment (ms since 1970; none: now), from your visit-client's database, newest last: { lines,
    // more } (each line as the "chat" event has it, `old`).
    async history({ before, limit } = {}) {
      const m = await this._ask("history", { ...(Number(before) > 0 ? { before: Math.floor(Number(before)) } : {}), ...(limit ? { limit: Number(limit) } : {}) });
      const lines = [];
      for (const l of Array.isArray(m.lines) ? m.lines : []) { const c = isObj(l) && this._chatFrom(l, true); if (c && this._hasContent(c)) lines.push(this._lineOf(c, true)); }
      return { lines, more: !!m.more };
    }
    // The pictures (kind "media"), voice messages ("voice") or links ("links") shared in a conversation ("room:<key>",
    // "person:<key>", "lobby"; a line's `conversation`), newest first: { items, more }: a picture's or a voice
    // message's { id, mime, size, at, key, name, mine }, a link's { url, title, description, site, image, at, key, name, mine }.
    async shared(conversation, kind = "media", { before, limit } = {}) {
      const m = await this._ask("shared", { conversation: String(conversation), kind: ["links", "voice"].includes(kind) ? kind : "media", ...(Number(before) > 0 ? { before: Number(before) } : {}), ...(limit ? { limit: Number(limit) } : {}) });
      return { items: Array.isArray(m.items) ? m.items.filter(isObj) : [], more: !!m.more };
    }
    _ask(type, body, ms = 15000) {
      if (!this._ws || this._ws.readyState !== 1) return Promise.reject(new Error("not connected to visit-client"));
      const req = ++this._reqN;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { this._asks.delete(req); reject(new Error(`no answer to ${type}`)); }, ms);
        this._asks.set(req, { resolve: m => { clearTimeout(t); resolve(m); }, reject: e => { clearTimeout(t); reject(e); } });
        this._send(Object.assign({ type, req }, body));
      });
    }
    // Whom you may whisper to (say(text, { whisper })): those in the lobby whose Visit takes whispers.
    get whisperTargets() {
      if (this.state !== "online") return [];
      return this.offices.filter(o => o.whisper && !(this.office && o.id === this.office.id)).map(o => ({ id: o.id, key: o.key, name: o.name }));
    }
    // Whom you may leave a whisper for (say(text, { whisper: key, name })), not in the lobby now (0.22.0): those you
    // have whispered with, and your guests, by their keys. Your visit-client keeps it, text only, and passes it on once
    // they and you are both in the lobby (v.held until then; "held_sent" as it goes).
    get awayTargets() {
      const here = new Set(this.whisperTargets.map(o => o.key)), by = new Map();
      const put = (key, name) => { if (key && /^[0-9a-f]{64}$/.test(key) && key !== this.key && !here.has(key) && name) by.set(key, name); };
      for (const g of this.guests) put(g.key, g.name);
      for (const l of this.chatLog) if (l.scope === "whisper") { if (l.mine && l.to) put(l.to.key, l.to.name); else put(l.key, l.name); }
      return [...by].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
    }
    // The mailbox (8.9): you have read its lines of a conversation ("person:<key>", "room:<key>", "lobby"), or all of
    // them (none). v.unseen: { count, conversations: [{ conversation, count }], lines (the newest, as "chat" gives
    // them) }, and "unseen" as it changes. A line meant for you (whispered, said in your room's chat, or mentioning you)
    // that comes while nobody looks at your chat (attention) is in it, kept by your visit-client.
    read(conversation) { this._send({ type: "read", ...(conversation ? { conversation: String(conversation) } : {}) }); }
    // Whether someone is looking at this page's chat now (Visit.chat says, by itself): what comes meanwhile is seen.
    attention(on) {
      if (!!on === this._attention) return;
      this._attention = !!on;
      this._send({ type: "attention", on: this._attention });
    }
    // A whisper left for someone away, taken back before it went (its id, from v.held).
    unhold(id) { this._send({ type: "unhold", id: String(id) }); }
    // Whom you may say a line to (say(text, { key })): the offices linked with yours, either way, now.
    get chatTargets() {
      const by = new Map();
      for (const h of this._hosted.values()) if (h.visitor && h.visitor.key) by.set(h.visitor.key, h.visitor.name);
      for (const w of [...this._links.values(), ...this._watches.values()]) if (w.host && w.host.key) by.set(w.host.key, w.host.name);
      if (this.visiting && this.visiting.host && this.visiting.host.key) by.set(this.visiting.host.key, this.visiting.host.name);
      by.delete(this.key);
      return [...by].map(([key, name]) => ({ key, name: String(name || "") })).sort((a, b) => a.name.localeCompare(b.name));
    }
    get chats() {
      const now = performance.now();
      return [...this._chats.values()].filter(c => c.until > now).map(c => ({ key: c.key, name: c.name, text: c.text, mine: c.mine, owner: c.owner, id: c.id, npc: c.npc || null, channel: c.channel }));
    }
    // A line (8.9) as the visit-client gives it: said in your room by a visitor (their channel), or in a room you are
    // in or see; in a room's chat ("sim"): into yours (home), or in a linked one's (its channel); whispered to you
    // ("whisper"); in the lobby ("lobby"). `old`: kept by the visit-client from before this page (`at`, when), your own
    // lines too (`mine`).
    _chatMsg(m, old) { const c = this._chatFrom(m, old); if (c) this._chatIn(c, old); }
    _chatFrom(m, old) {
      const line = { key: String(m.key || ""), name: String(m.name || ""), text: String(m.text || "").slice(0, 4 * CHAT_LEN), at: Number(m.at) || 0,
        media: picturesFrom(m.media), links: linksFrom(m.links), conversation: typeof m.conversation === "string" ? m.conversation : null };
      if (m.mine === true) {
        if (!old) return null;
        const to = isObj(m.to) ? { key: String(m.to.key || ""), name: String(m.to.name || ""), ...(m.to.id ? { id: String(m.to.id) } : {}) } : null;
        return { ...line, scope: ["sim", "whisper"].includes(m.scope) ? m.scope : "say", mine: true, to, ...(m.held === true ? { held: true } : {}) };
      }
      if (m.scope === "lobby") return { ...line, scope: "lobby", mine: !!this.office && m.id === this.office.id };
      if (m.scope === "whisper") return { ...line, scope: "whisper", id: typeof m.id === "string" ? m.id : null };
      if (m.scope === "sim") {   // the room whose chat it is: yours (home), else its owner (by the conversation, or the link it came by)
        const rk = line.conversation && line.conversation.startsWith("room:") ? line.conversation.slice(5) : null;
        const p = m.home === true || rk === this.key ? { key: this.key || "", name: this.office ? this.office.name : "" }
          : rk ? { key: rk, name: this._nameOf(rk) || (this._peerOf(m.channel) || {}).name || "" } : this._peerOf(m.channel) || {};
        return { ...line, scope: "sim", channel: m.channel, to: { key: String(p.key || ""), name: String(p.name || "") } };
      }
      const npc = typeof m.npc === "string" ? m.npc : null;   // one of a room's own figures (sayAs): yours, said with no channel
      return { ...line, id: typeof m.id === "string" ? m.id : null, npc, owner: m.owner === true, channel: m.channel, room: this._hosted.has(m.channel) || (npc && m.channel == null) ? "home" : m.channel };
    }
    // An office's name, by its key, as this page knows it (the lobby, its links).
    _nameOf(key) {
      const o = this.offices.find(x => x.key === key) || this.chatTargets.find(x => x.key === key);
      return o ? o.name : "";
    }
    _hasContent(c) { return !!c.text || (c.media && c.media.length > 0) || (c.links && c.links.length > 0); }
    _lineOf(c, old) {
      return { scope: c.scope || "say", key: c.key, name: c.name, text: c.text, mine: !!c.mine, owner: !!c.owner, id: c.id || null, npc: c.npc || null, channel: c.channel, to: c.to || null,
        media: c.media || [], links: c.links || [], conversation: c.conversation || null, mention: !c.mine && this._mentions(c.text), ...(c.held ? { held: true } : {}),
        at: old ? c.at : Date.now(), ...(old ? { old: true } : {}) };
    }
    // Whether a line mentions your user (8.9): @ and the name they go by, or your office's, as a word of its own.
    _mentions(text) {
      const t = String(text || "");
      return t.includes("@") && [this._userName, this.office && this.office.name].filter(Boolean)
        .some(n => new RegExp("(^|[\\s([{\"'])@" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\p{L}\\p{N}_])", "iu").test(t));
    }
    _chatIn(c, old) {
      if (!this._hasContent(c)) return;
      const line = this._lineOf(c, old);
      if (line.scope === "say" && !old && c.text) {   // over the speaker's head, a while
        c.until = performance.now() + chatShows(c.text);
        this._chats.set(c.mine ? "mine" : c.key + "|" + (c.id || ""), c);
      }
      this.chatLog.push(line);
      if (this.chatLog.length > CHAT_LOG) this.chatLog.shift();
      this._emit("chat", line);
      if (line.scope === "say" && !old) this._changed();
    }
    // Who your user hears speaking (v.voices), each where `who(key)` says it is in the room they are in: a 🔊 over
    // each (8.7). In another's room, keys are its owner's, "relay:" a visitor's visit there, "relay:phone…" a call on
    // its speaker.
    _speakersIn(who) {
      const out = [];
      for (const x of this.voices) if (x.speaking) { const at = who(x.key); if (at) out.push({ key: "speak:" + x.key, icon: "speak", at }); }
      return out;
    }
    // Where a voice is in a room visited or watched (its scene `s`, its host's key), for a 🔊 over it.
    _speakerIn(s, hostKey, key, b, u) {
      if (key === hostKey) return b.over(s.root.getObjectByName("visit:me"), 2.0 / u, 0.15 / u);
      if (key.startsWith("relay:phone")) return b.over(s.root.getObjectByName("visit:phone"), 0.35 / u, 0.15 / u);
      return key.startsWith("relay:") ? b.over(this._body(s, key.slice(6)), 2.0 / u, 0.15 / u) : null;
    }

    // The lines showing in one room ("home", or the channel of the one visited), and where each is said from: its
    // speaker there (`at`, the spot over their head in that scene's world terms), or not drawn (not found, or you).
    // `own`: draw your own (a view of yours from outside); `who`: the speaker's object in that room, or a spot.
    _chatsIn(room, who) {
      const now = performance.now(), out = [];
      for (const [k, c] of this._chats) {
        if (c.until <= now) { this._chats.delete(k); continue; }
        if (c.room !== room) continue;
        const at = who(c);
        if (at) out.push({ key: k, text: c.text, at });
      }
      return out;
    }

    // ---------- phones (8.8) ----------
    // A phone in your room: phone(true) says your room takes calls (a room without one is never rung). Calls go to
    // those you are linked to whose rooms have phones (v.phones), wherever their users are: voice to voice, as a
    // telephone sounds, not by where anyone stands. Your room shows the phone, and its ringing; Visit carries the
    // call. call(key) rings theirs; pickUp(key) answers; hangUp(key) ends it (or declines it). v.calls: [{ key, name,
    // state: "calling" | "ringing" | "on", speaking }]; "call" says each change ({ key, name, state, why }).
    // `at`: where the phone stands in your room (your units): on speaker, its call comes from there, and those near it
    // are heard in it.
    // Visit puts a phone there too (a stand, its handset, a lamp): it shakes while it rings, its handset is off its
    // cradle while you have it to your ear, its lamp lit on speaker (`model: false`: your room draws its own).
    phone(on = true, { at, model = true } = {}) {
      this._phone = !!on;
      this._phoneModel = model !== false;
      if (isObj(at)) this._phoneAt = { x: Number(at.x) || 0, y: Number(at.y) || 0, z: Number(at.z) || 0 };
      this._send({ type: "phone", on: this._phone });
      if (!on) for (const k of [...this._calls.keys()]) this.hangUp(k);
      this._phoneSet();
    }
    // The ready-made phone, in your scene where `at` says (its handset there), or out of it.
    _phoneSet() {
      const hk = this._hooks, pa = this._phoneAt, want = !!(hk && this._phone && this._phoneModel && pa);
      let p = this._phoneObj;
      if (p && (!want || p.T !== hk.scene.three || p.g.parent !== hk.scene.root)) { if (p.g.parent) p.g.parent.remove(p.g); if (!want || p.T !== hk.scene.three) p = this._phoneObj = null; }
      if (!want) return;
      if (!p) p = this._phoneObj = phoneModel(hk.scene.three);
      if (p.g.parent !== hk.scene.root) hk.scene.root.add(p.g);
      const u = this._unit();
      p.g.scale.setScalar(1 / u);
      p.g.position.set(pa.x, pa.y - 1.06 / u, pa.z);
    }
    // 30 times a second: the ready-made phone shaking while it rings (RING RING over it), its handset off its cradle
    // on a call to your ear, its lamp lit on speaker. Your visitors see it as you do: it is in your scene.
    _phoneTick(now) {
      const p = this._phoneObj;
      if (!p || !p.g.parent) return;
      const calls = [...this._calls.values()], ringing = calls.some(c => c.state === "ringing"), on = calls.find(c => c.state === "on");
      p.handset.visible = !(on && !on.speaker);
      p.lamp.visible = !!(on && on.speaker);
      p.handset.rotation.z = ringing ? Math.sin(now / 25) * 0.12 : 0;
      p.ring.visible = ringing && Math.floor(now / 400) % 2 === 0;
    }
    // A call on speaker (your side): their voice from your phone, heard by everyone near it in your room (your
    // visitors too: your room passes it on), and everyone near it heard by them; you only while you are near it.
    // Off (the handset, as a call starts): only you, to your ear. The caller sees only their own links (phones).
    speaker(key, on) { const c = this._calls.get(key); if (!c) return; c.speaker = !!on; this._send({ type: "speaker", channel: c.channel, on: c.speaker }); this._callSaid(c); }
    get phones() {
      const seen = new Map();
      for (const ch of this._phoneOn) { const p = this._peerOf(ch); if (p && p.key && !seen.has(p.key)) seen.set(p.key, { key: p.key, name: p.name || "" }); }
      return [...seen.values()];
    }
    get calls() { return [...this._calls.values()].map(c => ({ key: c.key, name: c.name, state: c.state, speaker: !!c.speaker, speaking: !!c.speaking })); }

    // ---------- room voice (8.7) and keeping people out (8.9) ----------
    // Into a room's voice, as a game's voice chat is: everyone in it hears everyone else in it, wherever they are, not
    // by distance (they hear you while your microphone is on). One at a time: `key`, a linked office's (its room's;
    // v.chatTargets), yours ("room", or v.key), or null (out). False: not possible (no link with them, or their room
    // keeps you out of its voice). Whoever you also hear another way (in person, or on a call) you hear that way only.
    // The "room_voice" event: the one you are in now (null: none; `out`, why you are out: "kicked", "banned", "gone").
    joinVoice(key) {
      this._as("user", "joinVoice");
      const k = key === "room" || key === true ? this.key : key == null ? null : String(key);
      if (!this._ws || this._ws.readyState !== 1 || (k && !this.key)) return false;
      if (k && k !== this.key && (!this.chatTargets.some(o => o.key === k) || this.bannedBy.some(b => b.key === k && b.voice))) return false;
      this._send({ type: "voice_join", key: k });
      if (k && k !== this.key && (!this.roomVoice || this.roomVoice.key !== k)) {   // theirs: in once their room says who is in it
        const t = this.chatTargets.find(o => o.key === k);
        this.roomVoice = { key: k, name: t ? t.name : "", members: [], joining: true };
        this._emit("room_voice", this.roomVoice); this._changed();
      }
      return true;
    }
    // One out of your room's voice now (they may come back).
    voiceKick(key) { this._send({ type: "voice_kick", key: String(key) }); }
    // Keep someone out of your room's voice, its chat, both, or neither (8.9), until you lift it (ban(key, {})). Out of
    // its voice: not heard in your room (in person, across your plot's side, in its voice) and hearing none of it. Out
    // of its chat: what they say is not said in it, and they have none of its lines. Calls are apart: you answer or not.
    ban(key, { voice = false, chat = false } = {}) {
      const k = String(key), o = this.offices.find(x => x.key === k) || this.chatTargets.find(x => x.key === k) || this.bans.find(x => x.key === k);
      this._send({ type: "ban", key: k, name: o ? o.name : "", voice: !!voice, chat: !!chat });
    }
    banOf(key) { return this.bans.find(b => b.key === key) || null; }
    _roomVoiceFrom(m, out) {
      const was = this.roomVoice, same = isObj(m) && was && was.key === m.key;
      this.roomVoice = isObj(m) && typeof m.key === "string"
        ? { key: m.key, name: String(m.name || (same ? was.name : "")), members: Array.isArray(m.members) ? membersFrom(m.members) : same ? was.members : [], joining: !Array.isArray(m.members) && (!same || was.joining) }
        : null;
      if (!this.roomVoice) for (const k of [...this._voices.keys()]) if (k.startsWith("room:")) this._voiceDrop(k);
      this._emit("room_voice", out ? { key: null, out: { key: String(out.key || ""), name: String(out.name || ""), why: String(out.why || "") } } : this.roomVoice);
      this._changed();
    }
    call(key) {
      if (!this._phone) throw new Error("visit.call: your room has no phone (phone(true) first)");
      const ch = [...this._phoneOn].find(c => { const p = this._peerOf(c); return p && p.key === key; });
      if (ch == null) throw new Error("visit.call: their room has no phone, or you are not linked to them");
      if (this._calls.has(key)) return;
      const p = this._peerOf(ch), c = { key, name: p.name || "", channel: ch, state: "calling", timer: 0 };
      c.timer = setTimeout(() => { if (this._calls.get(key) === c && c.state === "calling") this._callEnd(key, "no answer", true); }, CALL_RING_MS);
      this._calls.set(key, c);
      this._send({ type: "call", channel: ch, act: "ring" });
      this._callSaid(c);
    }
    async pickUp(key) {
      const c = this._calls.get(key);
      if (!c || c.state !== "ringing") return;
      c.state = "on"; clearTimeout(c.timer);
      this._send({ type: "call", channel: c.channel, act: "answer" });
      this._callSaid(c);
      await this._micStart();
    }
    hangUp(key) { this._callEnd(key, "hung up", true); }
    _callEnd(key, why, tell) {
      const c = this._calls.get(key);
      if (!c) return;
      this._calls.delete(key); clearTimeout(c.timer);
      for (const [k, s] of [...this._voices]) if (s.callKey === key) this._voiceDrop(k);
      if (tell) this._send({ type: "call", channel: c.channel, act: "hangup" });
      this._micMaybeStop();
      this._emit("call", { key, name: c.name, state: "ended", why });
      this._changed();
    }
    _callSaid(c) { this._emit("call", { key: c.key, name: c.name, state: c.state, speaker: !!c.speaker }); this._changed(); }
    // From the other side: ringing (your room's phone rings, if it has one: else they hear it is not taken),
    // answered, or hung up.
    _callIn(m) {
      const p = this._peerOf(m.channel), key = p && p.key;
      if (!key) return;
      const c = this._calls.get(key);
      if (m.act === "ring") {
        if (!this._phone || (c && c.state === "on")) return this._send({ type: "call", channel: m.channel, act: "hangup" });
        const n = { key, name: p.name || "", channel: m.channel, state: "ringing", timer: 0 };
        n.timer = setTimeout(() => { if (this._calls.get(key) === n && n.state === "ringing") this._callEnd(key, "missed", true); }, CALL_RING_MS);
        this._calls.set(key, n);
        this._callSaid(n);
      } else if (m.act === "answer" && c && c.state === "calling") {
        c.state = "on"; clearTimeout(c.timer);
        this._callSaid(c);
        this._micStart().catch(e => this._emit("error", { code: "mic", message: String(e.message || e) }));
      } else if (m.act === "hangup" && c) this._callEnd(key, c.state === "calling" ? "not taken" : "hung up", false);
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
    // in the lobby to be visited, and cannot knock: every room takes part with its scene. `fly` (optional): true, or
    // { speed, max } in metres (a second; above the floor), when this room lets its visitors fly: their `up` (8.2)
    // lifts them above the floor its `move` gives. Without it, a visitor that came in high (from a world, in the air)
    // floats gently down to that floor. It is read at every move, so a room may change it.
    host(hooks) {
      this._as("host", "host");
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
      if (hooks.mounts != null && typeof hooks.mounts !== "boolean") throw new Error("visit.host: mounts is true or false (8.11)");
      if (hooks.eye != null && !(Number(hooks.eye) > 0)) throw new Error("visit.host: eye is how high above its floor a visitor's pose is, in metres (1.6)");
      // `preview` (optional): { x, y, z, yaw, pitch }, where a link sees this room from before going in (8.5); without
      // it, from above its plot, going round.
      const pv = hooks.preview;
      if (pv != null && !(isObj(pv) && ["x", "y", "z", "yaw", "pitch"].every(k => Number.isFinite(pv[k])))) throw new Error("visit.host: preview is { x, y, z, yaw, pitch }");
      this._hooks = hooks;
      this._sync = null;
      this._plotFrom = null;
      // Where this room's own user stands (8.7), for those who see it to hear them from there: an empty object in its
      // scene, kept where your world (or listener()) has them while they are at home, hidden while they are away.
      if (!this._mark || this._mark.parent !== sc.root) {
        if (this._mark && this._mark.parent) this._mark.parent.remove(this._mark);
        this._mark = new sc.three.Object3D();
        this._mark.name = "visit:me"; this._mark.visible = false;
        sc.root.add(this._mark);
        this._phoneMark = new sc.three.Object3D();   // and where its phone stands (8.8): a call on speaker comes from there
        this._phoneMark.name = "visit:phone"; this._phoneMark.visible = false;
        sc.root.add(this._phoneMark);
      }
      this._phoneSet();   // the ready-made phone, in this scene
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
      this._bodyTell(h);
    }

    _hostEnter(m) {
      const h = this._hosted.get(m.channel);
      if (!h || !h.watch) return;
      Object.assign(h, { inside: true, pose: null, input: null, keyNext: true, fails: 0 });
      const at = isObj(m.pose) ? { x: Number(m.pose.x) || 0, y: Number(m.pose.y) || 0, z: Number(m.pose.z) || 0, yaw: Number(m.pose.yaw) || 0, air: Math.max(0, Number(m.pose.air) || 0) } : null;
      this._spawn(h, at);
      this._visitorsList();
    }

    _hostExit(m) {
      const h = this._hosted.get(m.channel);
      if (!h || !h.watch) return;
      this._rideSet(h, null);
      Object.assign(h, { inside: false, pose: null, input: null });
      this._bodyPlace(h);
      this._visitorsList();
    }

    _hostMessage(m) {
      const h = this._hosted.get(m.channel);
      if (!h) return;
      if (m.type === "input") { h.input = m; h.inputAt = performance.now(); this._step(h, h.inputAt); }   // at once: the next delta has it
      else if (m.type === "keyframe") h.keyNext = true;   // a key delta: where everything that moves is
      else if (m.type === "scene_resync") h.sceneSent = false;
      else if (m.type === "shared_adds") h.sharedAdds = true;   // its page reads an add naming what it has by uuid (8.3)
      else if (m.type === "landscapes") h.landscapes = true;   // its visit-client reads landscapes (8.10): the room's goes apart
      else if (m.type === "point") this._point(h, m);
    }

    // A visitor pointed: clicked at the middle of its view (SPEC 8.3). The page hears "point" with where from
    // (where this page has the visitor: its eyes) and which way (where it looked as it clicked, in the room's own
    // terms: yaw 0 toward -z, positive turning left, pitch positive up), and decides what, if anything, that does.
    _point(h, m) {
      const p = h.pose;
      if (!p || !Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return;
      const yaw = h.yaw0 + m.yaw, pitch = Math.max(-1.4, Math.min(1.4, m.pitch)), c = Math.cos(pitch);
      const from = [Number(p.x) || 0, (Number(p.y) || 0) + (h.eyes || 0), Number(p.z) || 0], dir = [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];   // from its eyes
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
      // A camera at the visitor's eyes, looking where it clicked: three.js meets a sprite (a label, a burst) only with one.
      const cam = ray.camera = this._rayCam || (this._rayCam = new T.PerspectiveCamera(70, 1, 0.01, 1000));
      cam.position.set(...from); cam.lookAt(from[0] + dir[0], from[1] + dir[1], from[2] + dir[2]); cam.updateMatrixWorld();
      const body = o => { for (; o; o = o.parent) if (!o.visible || (o.userData && (o.userData.visitor || o.userData.visitRider))) return true; return false; };
      let hits;
      try { hits = ray.intersectObject(hk.scene.root, true); } catch (e) { return console.warn("visit: a visitor's click could not be followed into the scene", e); }
      const hit = hits.find(x => !body(x.object));
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
          this._sync.perf = (part, ms) => this._pt(part, ms);
          for (const h of hs) h.sceneSent = false;
        }
        const sync = this._sync, ready = hs.filter(h => h.sceneSent);
        sync.inter = this._interList();
        sync.shared = ready.every(h => h.sharedAdds);   // one visitor on an older Visit: every add whole, as it reads them
        const t0 = this._perf ? performance.now() : 0, { edit, moved } = sync.scan(now);
        if (this._perf) this._pt("scan", performance.now() - t0);
        if (edit && ready.length) this._sendScene(ready, edit);
        if (edit && edit.landscape) for (const h of ready) if (!h.landscapes) h.sceneSent = false;   // an older visitor: the whole room again, its landscape in it
        if (sync.landDirty && now - sync.landAt >= LAND_QUIET) this._landSend(sync);
        const key = now - sync.keyAt >= SCENE_KEY_MS;
        if (key) sync.keyAt = now;
        const body = sync.entries(moved), all = key || ready.some(h => h.keyNext) ? sync.entries(sync.dynamicRecs()) : null;
        for (const h of ready) {
          const k = key || h.keyNext, p = h.pose, posed = p ? [p.x, p.y, p.z, p.yaw, p.pitch, h.input && h.input.t].join() : "-";
          if (k || body.n || posed !== h.posed) { this._sendDelta(h, k ? all : body, k, now); h.posed = posed; h.keyNext = false; }
        }
        for (const h of hs) {   // the whole room to a visitor starting: once its visit-client said it reads landscapes (8.10), or a moment on (an older one never says)
          if (h.sceneSent || (!h.landscapes && sync.statics.length && now - h.since < LAND_WAIT)) continue;
          const t1 = this._perf ? performance.now() : 0, whole = sync.snapshot(h, this._hooks);
          this._sendScene([h], whole, "whole"); h.sceneSent = true; h.keyNext = true;
          if (this._perf) this._pt("whole", performance.now() - t1);
        }
      } catch (e) { console.error("visit: could not send the scene", e); }
    }

    // This room's landscape (8.10), gzipped, to its visit-client, which offers it to visitors by its hash and sends it
    // to those that do not have it: when what is static changed (or landscapeChanged()), if it is not the same JSON.
    _landSend(sync) {
      sync.landDirty = false;
      if (!sync.statics.length) return;
      let text;
      const t0 = this._perf ? performance.now() : 0;
      try { text = JSON.stringify(sync.landscape()); } catch (e) { return console.warn("visit: a landscape that does not turn into JSON", e); }
      if (this._perf) this._pt("landscape", performance.now() - t0);
      if (text === this._landText) return;
      this._landText = text;
      this._sceneOut = (this._sceneOut || Promise.resolve()).then(async () => {
        const gz = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
        if (gz.byteLength > 16 << 20) return console.warn(`visit: a landscape too big to send (${gz.byteLength} bytes gzipped)`);
        if (!this._ws || this._ws.readyState !== 1) { this._landText = null; return; }
        const buf = new Uint8Array(11 + gz.byteLength);
        buf[2] = LAND;
        buf.set(gz, 11);
        this._ws.send(buf);
      }).catch(e => console.warn("visit: could not send the landscape", e));
    }
    // What is static in your room changed in itself (a tree moved, a wall repainted): its landscape goes again. Which
    // objects are static (userData.visitStatic) Visit sees by itself.
    landscapeChanged() { this._landText = null; if (this._sync) Object.assign(this._sync, { landDirty: true, landAt: 0 }); }

    // A scene edit to these visitors, gzipped, after any before it (SPEC 5.4: flags EDIT).
    _sendScene(hs, edit, part = "send") {
      let text;
      const t0 = this._perf ? performance.now() : 0;
      try { text = JSON.stringify(edit); } catch (e) { return console.warn("visit: a scene edit that does not turn into JSON", e); }
      if (this._perf && part === "send") this._pt("send", performance.now() - t0);
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
      [p.x, (Number(p.y) || 0) + (h.pose ? h.eyes || 0 : 0), p.z, p.yaw, p.pitch].forEach((x, i) => dv.setFloat32(24 + 4 * i, Number(x) || 0));   // its eyes: where its camera is
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
        walk: isObj(e.walk) && num(e.walk.speed, 0) > 0 ? { speed: Math.min(50, num(e.walk.speed, 2.5)), mounts: e.walk.mounts === true } : null,
        eye: num(e.eye, 0) > 0 ? num(e.eye, 0) : null,   // our eyes over our feet there (its units; `body` says again): an older host's, unsaid
        hist: [], vis: { x: 0, y: 0, z: 0 }, waitKey: true, own: [], last: 0, gcAt: performance.now(), q: new T.Quaternion(), v: new T.Vector3(), relight: null,
        interactions: interMap(e.interactions), landParents: isObj(e.landscape) && Array.isArray(e.landscape.parents) ? e.landscape.parents : null };
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
      const hk = this._hooks, wd = this._world;
      if (!hk && !wd) throw new Error("a plot is drawn with this page's own three.js: v.host first (or, the person's page, v.world({ three, renderer }))");
      this._sceneDrop(w);
      const T = hk ? hk.scene.three : wd.T, renderer = hk ? hk.scene.renderer : wd.renderer, s = this._sceneRead(T, e, w.id);
      s.plot = plotOf(e.plot, s.root, T);
      s.unit = Number(e.unit) > 0 ? Math.min(1000, Number(e.unit)) : 1;
      s.pose = { x: 0, y: 0, z: 0 }; s.yaw0 = 0; s.hostPose = null;
      s.relight = [legacyLights(Number(e.three), isObj(e.renderer) ? e.renderer : null), legacyLights(Number(T.REVISION), renderer)];
      relight(s.root, ...s.relight);
      this._sceneOwn(s);
      w.scene = s;
      this._landAttach(w);
      if (w.home && wd) wd.listAt = -1;   // home has arrived: the world's own plot is known
      const key = w.host && w.host.key;
      if (key && this.isGuest(key) && !w.home) {   // a guest's plot: kept to draw while they are away (8.10), here and by visit-client
        const k = this._kept.get(key) || { key, json: null, asked: false, built: null };
        if (!k.plot || JSON.stringify(k.plot) !== JSON.stringify(s.plot) || k.unit !== s.unit) this._send({ type: "plot_keep", key, name: w.host.name || "", plot: s.plot, unit: s.unit });
        this._kept.set(key, Object.assign(k, { name: w.host.name || "", plot: s.plot, unit: s.unit }));
      }
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
      s.unit = Number(e.unit) > 0 ? Math.min(1000, Number(e.unit)) : 1;   // metres in one of its units: how far voices are
      if (w.link) {   // seen from outside until you go there: its plot from above, or where its host says to look from
        s.plot = plotOf(e.plot, s.root, T);
        const p = e.preview;
        s.preview = isObj(p) && ["x", "y", "z", "yaw", "pitch"].every(k => Number.isFinite(p[k])) ? p : null;
      }
      w.scene = s;
      this._sceneOwn(s);
      this._landAttach(w);
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
      s.own = []; s.ownMount = [];   // and its mount (8.11): unseen from its own eyes, seen under it in its world
      s.root.traverse(o => { if (id && o.userData && o.userData.visitor === id) s.own.push(o); if (id && o.userData && o.userData.visitRider === id) s.ownMount.push(o); });
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
      if (isObj(e.landscape) && Array.isArray(e.landscape.parents)) { s.landParents = e.landscape.parents; this._landAttach(w); }
      this._sceneOwn(s);
    }

    // A landscape (8.10), from visit-client: a room's (on its visit's channel), kept by visit-client or sent once;
    // or (channel 0) a guest's plot kept while they are away.
    _landIn(m) {
      if (!isObj(m.json)) return;
      const key = String(m.key || "");
      if (!m.channel) {
        const k = this._kept.get(key);
        if (k) { k.json = m.json; k.built = null; if (this._world) this._world.listAt = -1; }
        return;
      }
      const w = this._viewing(m.channel) || this._links.get(m.channel);
      if (!w) return;
      this._landDrop(w);
      w.land = { key, json: m.json, objs: null, T: null };
      const k = w.plot && this._kept.get(key);
      if (k) { k.json = m.json; k.built = null; }
      this._landAttach(w);
    }
    // A room's landscape in its scene: each static object under the one its host has it under (by number; 0, the
    // scene), read once (as data: cleanScene) with this scene's three.js; one past the host's list taken out.
    _landAttach(w) {
      const s = w.scene, l = w.land;
      if (!s || !l || !l.json || !Array.isArray(s.landParents)) return;
      if (!l.objs || l.T !== s.T) {
        if (l.objs) this._landDrop(w, true);
        let group;
        try { group = new s.T.ObjectLoader().parse(cleanScene(l.json, Object.assign({}, s.budget))); }
        catch (e) { console.warn("visit: a landscape that could not be read: the room without it", e); l.json = null; return; }
        if (s.relight) relight(group, ...s.relight);
        l.objs = [...group.children]; l.T = s.T;
      }
      l.objs.forEach((o, i) => {
        const at = i < s.landParents.length ? s.byIdx.get(s.landParents[i]) || s.root : null;
        if (!at) { if (o.parent) o.parent.remove(o); } else if (o.parent !== at) at.add(o);
      });
      s.bodiesAt = 0;
    }
    // Its landscape out of the scene and let go (`keep`: its JSON kept, to read again).
    _landDrop(w, keep = false) {
      const l = w.land;
      if (!l || !l.objs) { if (!keep) w.land = null; return; }
      for (const o of l.objs) {
        if (o.parent) o.parent.remove(o);
        o.traverse(c => { if (c.geometry) c.geometry.dispose(); for (const m of list(c.material)) { for (const k of MAPS) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); } });
      }
      l.objs = null;
      if (!keep) w.land = null;
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
          strafe: (key("KeyD") || key("ArrowRight") ? 1 : 0) - (key("KeyA") || key("ArrowLeft") ? 1 : 0), run: key("ShiftLeft") || key("ShiftRight") }, dt, this._rideWalk(s.walk));
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
      for (const o of s.ownMount || []) o.visible = false;
      if (!outside) this._aim(s, now);
      s.renderer.render(s.root, s.camera);
      if (this._chats.size || (this.voices.some(x => x.speaking) && !outside) || s.bubbles) {   // lines said in this room (seen from in it or outside), and who you hear speaking
        const b = s.bubbles || (s.bubbles = new Bubbles(s.T)), k = s.unit || 1, hostKey = (w.host || (this.visiting && this.visiting.host) || {}).key;
        b.draw(s.renderer, s.camera, this._chatsIn(w.channel, c => c.mine ? null : b.over(c.id ? this._body(s, c.id) : s.root.getObjectByName(c.npc ? "visit:npc:" + c.npc : "visit:me"), 2.4 / k, 0.6 / k))
          .concat(outside ? [] : this._speakersIn(key => this._speakerIn(s, hostKey, key, b, k))), k);
      }
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
      if (s.bubbles) s.bubbles.release();
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
      if (this._perf && now - this._perf.at >= 1000) this._perfRoll(now);
      if (this._view) this._sendInput(now, this._view.pending);
      const w = this._viewer;
      if (w && !w.scene && !w.loading && !w.failed && now - (w.askedAt || w.since) > 3000) { w.askedAt = now; this._sceneResync(w); }   // no scene yet: ask again
      if (this._viewer && now - (this._statsAt || 0) >= 1000) {
        this._statsAt = now;
        this.stats.fps = this._viewer.count; this._viewer.count = 0;
        this._emit("stats", this.stats);
      }
      for (const w of this._watches.values()) if (!w.scene && !w.loading && !w.failed && now - (w.askedAt || w.since) > 3000) { w.askedAt = now; this._sceneResync(w); }
      if (now - (this._voiceAt || 0) >= 33) {   // voice: who is near, where each is heard from; and this room's own user's mark
        this._voiceAt = now;
        const o = this.role === "host" && this.owner && this._hosted.get(this.owner.channel);   // a host page: its owner, a visitor of its own, is who stands here
        const m = this._mark, h = this.role === "host" ? (o && o.inside && o.pose ? { x: o.pose.x, y: Number(o.pose.y) || 0, z: o.pose.z } : null) : this._home;
        const away = this.role !== "host" && (this._inRoom() || (this._world && this._world.inside));
        if (m) { m.visible = !!h && !away; if (h && !away) m.position.set(h.x, h.y + 1.5 / this._unit(), h.z); }
        const pm = this._phoneMark, pa = this._phoneAt;
        if (pm) { pm.visible = !!(this._phone && pa); if (pa) pm.position.set(pa.x, pa.y, pa.z); }
        this._phoneTick(now);
        const t0 = this._perf ? performance.now() : 0;
        this._voiceTick();
        if (this._perf) this._pt("voice", performance.now() - t0);
      }
      if (!this._hooks || !this._hosted.size) return;
      for (const h of [...this._hosted.values()]) if (h.inside) this._step(h, now);
      if (now - (this._avatarAt || 0) >= 33) {   // visitors' own avatars, walking or idle, 30 times a second
        const dt = Math.min(0.25, (now - (this._avatarAt || now)) / 1000);
        this._avatarAt = now;
        for (const h of this._hosted.values()) if (h.inside && h.avatar && h.look === "theirs") this._avatarStep(h, dt);
        for (const h of this._hosted.values()) if (h.inside && h.ride) this._rideStep(h, dt);   // and their mounts
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
      const input = fresh ? h.input : { forward: 0, strafe: 0, up: 0, run: false, yaw: h.input ? h.input.yaw : 0, pitch: h.input ? h.input.pitch : 0, riding: h.input ? h.input.riding : null };
      // What it rides here (8.11), as this room lets in: its mount under it. How it goes (its pace, how high, whether
      // it flies) is the room's move's to say: Visit tells it (`who.riding`), and does nothing of its own.
      const ride = this._rideOf(h, input);
      if ((ride && ride.id) !== (h.ride && h.ride.id)) this._rideSet(h, ride);
      let p;
      try {
        const turned = Object.assign({}, h.pose, { yaw: h.yaw0 + (input.yaw || 0), pitch: input.pitch || 0 });
        const r = h.ride, who = { id: h.id, visitor: h.visitor, owner: !!h.owner, riding: r ? { id: r.id, name: r.name, fly: r.fly, speed: r.speed, lift: r.lift } : null };
        p = Object.assign({}, this._hooks.move(turned, input, dt, who) || turned);
        h.fails = 0;
      } catch (e) { return this._hookFailed(h, "move", e); }
      h.pose = p;
      this._bodyPlace(h);
      if (h.ride) this._ridePlace(h);
      if (now - (h.keptAt || 0) >= 200) {   // where the visitor stands, kept by visit-client for a reload of this page
        h.keptAt = now;
        this._send({ type: "pose", channel: h.channel, state: { pose: h.pose, yaw0: h.yaw0 } });
      }
    }

    // ---------- possessions here (8.11): visitors' mounts ----------
    // What a visitor rides here: one of its possessions that is a mount; none where the room keeps mounts out
    // (`mounts: false`).
    _rideOf(h, input) {
      const id = typeof input.riding === "string" ? input.riding : null;
      if (!id || this._hooks.mounts === false) return null;
      const p = (h.possessions || []).find(x => x.id === id && x.mount);
      return p ? { id, name: p.name, fly: p.fly, speed: p.speed, lift: p.lift } : null;
    }
    // A visitor gets on a mount here, or off: its model in this room's scene under it (marked as its mount,
    // userData.visitRider: it does not see it from its own eyes, nor click it), and gone again.
    _rideSet(h, ride) {
      const r = h.ride;
      if (r && r.object && r.object.parent) r.object.parent.remove(r.object);   // (its model kept, for the next ride)
      if (r && r.mixer) r.mixer.stopAllAction();
      h.ride = ride ? Object.assign({ object: null, mixer: null, clips: null, playing: null, at: null }, ride) : null;
      if (ride) this._rideModel(h);
      this._visitorsList();
      this._changed();
    }
    _rideModel(h) {
      const r = h.ride, hk = this._hooks;
      if (!r || r.object || !hk) return;
      const m = h.models.get(r.id);
      if (!m) {   // not here yet: asked for, once a visit; it rides as soon as it comes
        if (!h.wanted.has(r.id)) { h.wanted.add(r.id); this._send({ type: "possession_want", channel: h.channel, id: r.id }); }
        return;
      }
      Object.assign(r, { object: m.object, mixer: m.mixer, clips: m.clips });
      r.object.name = "mount:" + (h.visitor.name || ""); r.object.userData.visitRider = h.id;
      hk.scene.root.add(r.object);
      if (h.pose) this._ridePlace(h);
    }
    // Under its rider: their feet (their pose) its `lift` up from where it stands, facing their way.
    _ridePlace(h) {
      const o = h.ride && h.ride.object, p = h.pose;
      if (!o || !p) return;
      o.position.set(p.x, (Number(p.y) || 0) - h.ride.lift / this._unit(), p.z);
      o.rotation.set(0, Number(p.yaw) || 0, 0);
    }
    // Its moves as it goes, 30 times a second: in the air (a mount that flies), walking, or still.
    _rideStep(h, dt) {
      const r = h.ride, p = h.pose;
      if (!r || !r.object || !p) return;
      const u = this._unit(), mps = r.at ? Math.hypot(p.x - r.at.x, p.z - r.at.z) / Math.max(dt, 1e-3) * u : 0;
      r.at = { x: p.x, z: p.z };
      rideAnimate(r, r.fly && Number(p.air) > 0.05 / u ? "fly" : mps > 0.3 ? "walk" : "idle", mps, dt);   // in the air: as its room's move says (pose.air)
    }
    // One of a visitor's possessions' models, which this page asked for: read as an avatar is (as data, scaled to
    // this room's units), its clips ready; ridden at once if its visitor is on it.
    _possessionIn(m) {
      const h = this._hosted.get(m.channel), hk = this._hooks, id = String(m.id || "");
      if (!h || !hk || !h.wanted.has(id) || !isObj(m.possession) || !isObj(m.possession.json)) return;
      try {
        const T = hk.scene.three, budget = { vertices: 0, objects: 0 }, json = cleanScene(m.possession.json, budget);
        if (budget.vertices > AVATAR_VERTICES || budget.objects > AVATAR_OBJECTS) throw new Error(`more than ${AVATAR_VERTICES} vertices or ${AVATAR_OBJECTS} objects`);
        const o = new T.ObjectLoader().parse(json), k = Math.min(1000, Math.max(0.001, (Number(m.possession.unit) || 1) / this._unit()));
        o.scale.multiplyScalar(k);
        const g = new T.Group(), mixer = new T.AnimationMixer(o), clip = n => (o.animations || []).find(c => new RegExp(n, "i").test(c.name));
        g.add(o);
        const clips = Object.fromEntries(["idle", "walk", "run", "fly"].map(n => [n, (c => c ? mixer.clipAction(c) : null)(clip(n))]));
        const riding = h.ride && h.ride.id === id;
        if (riding && h.ride.object) { h.ride.object.parent && h.ride.object.parent.remove(h.ride.object); h.ride.object = null; }
        const old = h.models.get(id);
        if (old) { old.mixer.stopAllAction(); dispose(old.object); }
        h.models.set(id, { object: g, mixer, clips });
        if (riding) this._rideModel(h);
      } catch (e) { console.warn(`visit: ${h.visitor.name}'s ${id} cannot be read`, e); }
    }
    _rideDrop(h) {
      this._rideSet(h, null);
      for (const m of h.models.values()) { m.mixer.stopAllAction(); dispose(m.object); }
      h.models.clear();
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
      const KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", ...UP_KEYS, ...DOWN_KEYS];
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
      const shown = o => { for (; o; o = o.parent) if (!o.visible || s.own.includes(o) || (s.ownMount || []).includes(o)) return false; return true; };
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
        up: (UP_KEYS.some(k) ? 1 : 0) - (DOWN_KEYS.some(k) ? 1 : 0), run: k("ShiftLeft") || k("ShiftRight"), riding: this.riding, yaw: v.yaw, pitch: v.pitch, t: now });
    }

    // A delta of the scene of the room visited, or of a plot watched (SPEC 5.4).
    _frame(buf) {
      if (buf.byteLength < 11) return;
      const fl = new DataView(buf).getUint8(2);
      if (fl === MEDIA) return this._mediaIn(new Uint8Array(buf, 11));
      if (fl === AUDIO || fl === RELAY) return this._voiceIn(new DataView(buf).getUint16(0), new Uint8Array(buf, 11), fl === RELAY, new DataView(buf).getUint8(3));
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

  // ---------- possessions (8.11) ----------
  // A mount's moves, by its clips (fly, run when fast, walk, idle), eased from one to the next.
  function rideAnimate(r, how, mps, dt) {
    const c = r.clips;
    if (!c || !r.mixer) return;
    const want = how === "fly" ? c.fly || c.walk || c.idle : how === "walk" ? (mps > 4 && c.run) || c.walk || c.idle : c.idle;
    if (want !== r.playing) { if (r.playing) r.playing.fadeOut(0.2); if (want) want.reset().fadeIn(0.2).play(); r.playing = want; }
    r.mixer.update(dt);
  }
  // A model as other rooms will read it (MODELS.md): your avatar, or a possession. Its feet at its origin, centred, a
  // size that fits its unit, its own place and turn zero, what each clip moves there to move, its named points, what
  // three.js carries, and that it reads back. { ok, problems: [...], notes: [...], height (m), eyes (m), seat (m), clips }.
  // `three`: your THREE; `unit`: metres in one of its units; `kind`: "avatar" or "mount".
  function checkModel(object, { three, unit = 1, kind = "avatar" } = {}) {
    const T = three || (typeof THREE !== "undefined" ? THREE : null), problems = [], notes = [], out = { ok: false, problems, notes, height: 0, eyes: null, seat: null, clips: [] };
    if (!object || !object.isObject3D) { problems.push("it is not a three.js object (an Object3D)"); return out; }
    if (!T) { problems.push("checkModel needs your three.js: { three: THREE }"); return out; }
    const u = Number(unit) > 0 ? Number(unit) : 1, m = x => (x * u).toFixed(2) + " m";
    if (object.parent) notes.push("it is in a scene now: give a model of its own (a fresh one, or a clone), not one standing in your room");
    if (object.position.lengthSq() > 1e-6 || Math.abs(object.rotation.x) + Math.abs(object.rotation.y) + Math.abs(object.rotation.z) > 1e-6)
      problems.push(`its own place or turn is not zero (at ${object.position.toArray().map(x => x.toFixed(2)).join(", ")}): it goes with it to every room, and puts it off its feet`);
    const place = [object.position.clone(), object.quaternion.clone()], parent = object.parent;
    if (parent) parent.remove(object);   // measured on its own, at its origin
    object.position.set(0, 0, 0); object.rotation.set(0, 0, 0); object.updateMatrixWorld(true);
    try {
      const box = new T.Box3().setFromObject(object);
      if (box.isEmpty()) problems.push("it draws nothing (no meshes)");
      else {
        const h = box.max.y - box.min.y, w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z), cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
        out.height = Number((h * u).toFixed(3));
        if (Math.abs(box.min.y) * u > Math.max(0.05, 0.05 * h * u)) problems.push(`its feet are not at its origin: its lowest point is at y = ${m(box.min.y)} (the ground under its feet goes at y = 0)`);
        if (Math.hypot(cx, cz) > Math.max(0.1 / u, 0.25 * w)) problems.push(`it is not centred on its origin: its middle is at x ${m(cx)}, z ${m(cz)}`);
        if (kind === "avatar" && (h * u < 0.3 || h * u > 4)) problems.push(`it is ${m(h)} tall: is its unit right? (metres in one of its units: ${u})`);
        if (kind === "mount" && (h * u < 0.1 || h * u > 10)) problems.push(`it is ${m(h)} tall: is its unit right? (metres in one of its units: ${u})`);
      }
      const at = name => { const o = object.getObjectByName(name); return o ? new T.Vector3().setFromMatrixPosition(o.matrixWorld) : null; };
      const eyes = at("eyes"), seat = at("seat");
      if (kind === "avatar") {
        out.eyes = Number(((eyes ? eyes.y : 0.92 * (box.isEmpty() ? 0 : box.max.y)) * u).toFixed(3));
        if (!eyes) notes.push(`no "eyes" point: its eyes taken as 92% of its height (${out.eyes} m)`);
        else if (eyes.z > 0.05 / u) problems.push(`its "eyes" point is behind its middle (z ${m(eyes.z)}): does it face -z?`);
      }
      if (kind === "mount") {
        if (seat) out.seat = Number((seat.y * u).toFixed(3));
        else notes.push('no "seat" point: its rider sits `lift` metres up (0 unless you say)');
      }
      // Its clips: what each moves must be a part it has, by name (else it moves nothing, anywhere).
      const clips = object.animations || [], want = kind === "mount" ? ["idle", "walk"] : ["idle", "walk"];
      out.clips = clips.map(c => c.name);
      for (const n of want) if (!clips.some(c => new RegExp(n, "i").test(c.name))) notes.push(`no "${n}" clip: it ${n === "idle" ? "stands still" : "glides"} when ${n === "idle" ? "still" : "moving"}`);
      const parts = new Set(); object.traverse(o => { if (o.name) parts.add(o.name); parts.add(o.uuid); });
      for (const c of clips) for (const t of c.tracks || []) {
        let node = null;
        try { node = T.PropertyBinding.parseTrackName(t.name).nodeName; } catch (e) { problems.push(`clip "${c.name}" has a track three.js cannot read: "${t.name}"`); continue; }
        if (node && !parts.has(node) && node !== ".bones") problems.push(`clip "${c.name}" moves "${node}", which the model has no part named`);
      }
      // What carries, and how much.
      let vertices = 0, objects = 0;
      object.traverse(o => {
        objects++;
        if (o.geometry && o.geometry.attributes && o.geometry.attributes.position) vertices += o.geometry.attributes.position.count;
        for (const mt of list(o.material)) if (mt && (mt.isShaderMaterial || mt.isRawShaderMaterial)) problems.push(`"${o.name || o.type}" has a shader material: shaders do not carry (use three.js's own materials)`);
        if (o.isSkinnedMesh) notes.push(`"${o.name || "a mesh"}" is skinned (bones): it reads less surely in rooms on other three.js releases than parts moved by clips`);
      });
      if (vertices > AVATAR_VERTICES || objects > AVATAR_OBJECTS) problems.push(`it is too big: ${vertices} vertices and ${objects} objects (at most ${AVATAR_VERTICES} and ${AVATAR_OBJECTS})`);
      // It reads back, as a room reads it.
      try {
        const text = JSON.stringify({ unit: u, json: sharedJSON(object) });
        if (text.length > 4 * MAX_AVATAR) problems.push(`it is too big to send: ${(text.length / 1048576).toFixed(1)} MB of JSON`);
        const back = new T.ObjectLoader().parse(cleanScene(JSON.parse(text).json, { vertices: 0, objects: 0 }));
        if ((back.animations || []).length !== clips.length) problems.push(`its clips do not come back with it (${clips.length} given, ${(back.animations || []).length} read)`);
      } catch (e) { problems.push("it does not read back: " + String(e && e.message || e).slice(0, 160)); }
    } finally {
      object.position.copy(place[0]); object.quaternion.copy(place[1]); object.updateMatrixWorld(true);
      if (parent) parent.add(object);
    }
    out.ok = !problems.length;
    return out;
  }

  // Where a model's eyes are over its feet (as drawn, its scale applied; it at its origin): its `eyes` point (an object
  // so named), else 92% of its height (MODELS.md).
  function modelEyes(T, o) {
    o.updateMatrixWorld(true);
    const e = o.getObjectByName("eyes");
    if (e) return Math.max(0.05, new T.Vector3().setFromMatrixPosition(e.matrixWorld).y - o.getWorldPosition(new T.Vector3()).y);
    const box = new T.Box3().setFromObject(o);
    return box.isEmpty() ? null : Math.max(0.05, 0.92 * box.max.y - o.getWorldPosition(new T.Vector3()).y);
  }
  // A list of possessions as a visitor's visit-client gives it (8.11), read again: [{ id, name, mount, fly, speed, lift }].
  function possessionsFrom(l) {
    return (Array.isArray(l) ? l : []).filter(isObj).slice(0, POSSESSIONS).filter(p => typeof p.id === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(p.id)).map(p => ({
      id: p.id, name: String(p.name || p.id).slice(0, 24), mount: p.mount === true, fly: p.fly === true,
      speed: Math.min(5, Math.max(0.25, Number(p.speed) || 1)), lift: Math.min(5, Math.max(0, Number(p.lift) || 0)) }));
  }
  // An object's geometries, materials and their pictures, let go.
  function dispose(o) {
    o.traverse(c => { if (c.geometry) c.geometry.dispose(); for (const mt of list(c.material)) { for (const k of MAPS) if (mt[k] && mt[k].isTexture) mt[k].dispose(); mt.dispose(); } });
  }

  // ---------- the ready-made phone (8.8) ----------
  // A desk phone on a stand, in metres (its handset 1.06 m up): red, its lamp green on speaker, RING RING over it.
  function phoneModel(T) {
    const g = new T.Group(), red = new T.MeshLambertMaterial({ color: 0xb3261e }), wood = new T.MeshLambertMaterial({ color: 0x6e5a44 });
    const box = (w, h, d, m, x, y, z, to) => { const o = new T.Mesh(new T.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; to.add(o); return o; };
    box(0.36, 0.95, 0.36, wood, 0, 0.475, 0, g);   // the stand
    box(0.3, 0.08, 0.22, red, 0, 0.99, 0, g);      // the phone
    const handset = new T.Group(); handset.position.set(0, 1.06, 0); g.add(handset);
    box(0.32, 0.05, 0.07, red, 0, 0, 0, handset); box(0.08, 0.06, 0.09, red, -0.13, 0.02, 0, handset); box(0.08, 0.06, 0.09, red, 0.13, 0.02, 0, handset);
    const lamp = new T.Mesh(new T.SphereGeometry(0.025, 8, 6), new T.MeshBasicMaterial({ color: 0x3fb950 }));
    lamp.position.set(0.11, 1.04, 0.1); lamp.visible = false; g.add(lamp);
    const ring = bubble(T, "📞 RING RING", 1); ring.position.set(0, 1.35, 0); ring.visible = false; g.add(ring);
    g.name = "visit:phone-model";
    return { T, g, handset, lamp, ring };
  }

  // ---------- chat bubbles (8.9): a line said, over its speaker's head ----------
  // A line on a card (wrapped, at most four lines), as a three.js sprite whose bottom sits where it is put: `unit`, the
  // metres of a unit in the scene it goes in. For a room drawing its own: Visit.bubble(THREE, text, unit).
  function bubble(T, text, unit = 1) {
    const c = document.createElement("canvas"), g = c.getContext("2d"), font = "500 30px system-ui, -apple-system, sans-serif", W = 460, pad = 18, lh = 38, tail = 14;
    g.font = font;
    const lines = [];
    let line = "";
    for (const ch of text) {   // by character, breaking at the line's last space when it is full
      if (g.measureText(line + ch).width <= W - 2 * pad) { line += ch; continue; }
      const at = line.lastIndexOf(" ");
      if (at > 0 && ch !== " ") { lines.push(line.slice(0, at)); line = line.slice(at + 1) + ch; } else { lines.push(line); line = ch === " " ? "" : ch; }
    }
    if (line) lines.push(line);
    if (lines.length > 4) { lines.length = 4; lines[3] = lines[3].replace(/.?$/, "…"); }
    const w = Math.ceil(Math.min(W, Math.max(80, ...lines.map(l => g.measureText(l).width + 2 * pad)))), h = lines.length * lh + 2 * pad + tail;
    c.width = w; c.height = h;
    g.font = font;
    const r = 16, b = h - tail;
    g.beginPath(); g.moveTo(r, 0); g.arcTo(w, 0, w, b, r); g.arcTo(w, b, 0, b, r);
    g.lineTo(w / 2 + 10, b); g.lineTo(w / 2, h - 1); g.lineTo(w / 2 - 10, b);
    g.arcTo(0, b, 0, 0, r); g.arcTo(0, 0, w, 0, r); g.closePath();
    g.fillStyle = "rgba(255,255,255,0.95)"; g.fill(); g.lineWidth = 2; g.strokeStyle = "rgba(0,0,0,0.25)"; g.stroke();
    g.fillStyle = "#111"; g.textBaseline = "middle"; g.textAlign = "center";
    lines.forEach((l, i) => g.fillText(l, w / 2, pad + lh * (i + 0.5)));
    const tex = new T.CanvasTexture(c);
    if ("colorSpace" in tex && T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace; else if (T.sRGBEncoding) tex.encoding = T.sRGBEncoding;
    const sprite = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.center.set(0.5, 0);
    const m = 0.0045 / (Number(unit) > 0 ? Number(unit) : 1);   // a pixel, in the scene's units: the widest card some 2 m
    sprite.scale.set(w * m, h * m, 1);
    sprite.name = "visit:bubble"; sprite.renderOrder = 10;
    return sprite;
  }

  // Who is speaking (8.7), as Visit marks them: a 🔊 card (`unit`, the metres of a unit) whose bottom sits where it is
  // put. Made once a three.js, its picture shared.
  const speakPics = new WeakMap();
  function speakMark(T, unit = 1) {
    let pic = speakPics.get(T);
    if (!pic) {
      const c = document.createElement("canvas"), g = c.getContext("2d");
      c.width = c.height = 128;
      g.fillStyle = "#ffffff"; g.strokeStyle = "#1c2128"; g.lineWidth = 6;
      g.beginPath(); g.moveTo(36, 6); g.arcTo(122, 6, 122, 122, 30); g.arcTo(122, 122, 6, 122, 30); g.arcTo(6, 122, 6, 6, 30); g.arcTo(6, 6, 122, 6, 30); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = "#1c2128"; g.beginPath(); g.moveTo(24, 50); g.lineTo(42, 50); g.lineTo(64, 30); g.lineTo(64, 98); g.lineTo(42, 78); g.lineTo(24, 78); g.closePath(); g.fill();
      g.strokeStyle = "#2ea043"; g.lineWidth = 9; g.lineCap = "round";
      for (const r of [16, 31]) { g.beginPath(); g.arc(68, 64, r, -0.85, 0.85); g.stroke(); }
      pic = new T.CanvasTexture(c);
      if ("colorSpace" in pic && T.SRGBColorSpace) pic.colorSpace = T.SRGBColorSpace; else if (T.sRGBEncoding) pic.encoding = T.sRGBEncoding;
      speakPics.set(T, pic);
    }
    const sprite = new T.Sprite(new T.SpriteMaterial({ map: pic, transparent: true, depthWrite: false }));
    sprite.center.set(0.5, 0);
    sprite.userData.size = 0.45 / (Number(unit) > 0 ? Number(unit) : 1);
    sprite.scale.set(sprite.userData.size, sprite.userData.size, 1);
    sprite.name = "visit:speaking"; sprite.renderOrder = 10;
    return sprite;
  }

  // The bubbles of one view, and its 🔊 marks: drawn after its room, into the same depth (a wall in front hides one).
  class Bubbles {
    constructor(T) { this.T = T; this.scene = new T.Scene(); this.by = new Map(); this.box = new T.Box3(); }
    // Over an object: the top of what it draws (its bounding box) and `gap` more; or, drawing nothing (a mark), `up`
    // over it. In world terms; null for no object.
    over(o, up, gap) {
      if (!o) return null;
      for (let p = o; p; p = p.parent) if (!p.visible) return null;   // hidden (an owner away, say): not there to see
      this.box.setFromObject(o);
      const T = this.T, p = o.getWorldPosition(new T.Vector3());
      return this.box.isEmpty() ? { x: p.x, y: p.y + up, z: p.z } : { x: (this.box.min.x + this.box.max.x) / 2, y: this.box.max.y + gap, z: (this.box.min.z + this.box.max.z) / 2 };
    }
    // Each item: { key, at, text } a line's bubble, or { key, at, icon: "speak" } a 🔊, pulsing.
    draw(renderer, camera, items, unit) {
      const seen = new Set(), pulse = 1 + 0.12 * Math.sin(performance.now() / 100);
      for (const it of items) {
        let b = this.by.get(it.key);
        if (!b || b.text !== it.text || b.unit !== unit) {
          if (b) this._drop(it.key);
          b = { text: it.text, unit, sprite: it.icon === "speak" ? speakMark(this.T, unit) : bubble(this.T, it.text, unit) };
          this.by.set(it.key, b); this.scene.add(b.sprite);
        }
        b.sprite.position.set(it.at.x, it.at.y, it.at.z);
        if (it.icon === "speak") b.sprite.scale.set(b.sprite.userData.size * pulse, b.sprite.userData.size * pulse, 1);
        seen.add(it.key);
      }
      for (const k of [...this.by.keys()]) if (!seen.has(k)) this._drop(k);
      if (!this.by.size) return;
      const auto = renderer.autoClear, planes = renderer.clippingPlanes;
      renderer.autoClear = false; renderer.clippingPlanes = [];
      try { renderer.render(this.scene, camera); } finally { renderer.autoClear = auto; renderer.clippingPlanes = planes; }
    }
    _drop(k) {
      const b = this.by.get(k);
      this.by.delete(k); this.scene.remove(b.sprite);
      if (b.sprite.name !== "visit:speaking") b.sprite.material.map.dispose();   // (a 🔊's picture is shared)
      b.sprite.material.dispose();
    }
    release() { for (const k of [...this.by.keys()]) this._drop(k); }
  }

  // ---------- the world (../../WORLD.md): friends' plots around your room, and walking onto them ----------
  // A side of a plot, by where it faces in the plot's own terms; turning left a (radians) on the floor.
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
  // open to you, or a link you put there) where your layout puts it: where you placed it, else a ring round yours.
  // You walk in your own room with your own walking; step onto a plot and you are in its owner's room (it moves
  // you, by its walls), drawn there by your page as yourself; walk off it and you are home again.
  //
  //   const world = v.world({ scene, renderer });   // your whole scene, and its renderer (default: host()'s)
  //   every frame:  const me = world.frame(dt, { x, y, z, yaw, pitch, air }, { forward, strafe, up, run });   // air: how high above its floor (flying)
  //                 (where your page has its user, in its room's terms, and what they press; `me` is where they
  //                 are now: at home as you said, or in a plot as its host has them, `me.in` = { key, name })
  //                 world.render(camera);   (instead of renderer.render(scene, camera))
  // It draws the lines said (8.9) in the room your user is in over their speakers' heads, yours too (bubbles: false,
  // and your page draws them itself, from v.chats); and a 🔊 over each one your user hears speaking (8.7; speaking:
  // false, and your page draws its own, from v.voices).
  class World {
    // A host page's world: its scene (clipped to its plot) and its renderer, friends' plots round it. A user page's
    // (engine/SPEC.md 7): no scene of its own, its room comes from its host and is drawn as its own plot; `three` (any
    // release this visit.js knows) and `renderer` are the page's.
    // `self`: a user page's own body at home (engine/SPEC.md 4): "mine" (the default) hides the room's copy of it, as a
    // visitor's page does (8.1), for the page's own; "room" shows the room's copy, with all the room does to it (a
    // seat, a drink, a mount), for a page that draws none of its own there. Settable as the page goes (first person).
    constructor(v, { scene, renderer, three, ground = 0x30363d, gap = WORLD_GAP, clipOwn = true, bubbles = true, speaking = true, self = "mine" } = {}) {
      const hk = v._hooks;
      if (!hk && !(v.role === "user" && three && three.REVISION && renderer)) throw new Error(v.role === "user" ? "visit.world needs { three, renderer }: the three.js this page draws with, and its renderer (its room comes from its host)" : "visit.world: v.host first (the world is drawn with your three.js, round your plot)");
      this.v = v; this.T = hk ? hk.scene.three : three;
      this.scene = hk ? scene || (hk.scene.root.isScene ? hk.scene.root : null) : null;
      this.renderer = renderer || (hk && hk.scene.renderer);
      if ((hk && !this.scene) || !this.renderer) throw new Error("visit.world needs { scene, renderer }: your whole scene, and the renderer that draws it");
      Object.assign(this, { gap: Number(gap) >= 0 ? Number(gap) : WORLD_GAP, clipOwn: clipOwn !== false, self: self === "room" ? "room" : "mine", in: null, home: null, bounce: null, yHome: null, me: null,
        bubbles: bubbles === false && speaking === false ? null : new Bubbles(this.T), showLines: bubbles !== false, showSpeaking: speaking !== false,
        refused: new Map(), holders: new Map(), sent: { at: 0, sig: "" }, look: { yaw: 0, pitch: 0 }, list: [], listAt: -1, plots: [], told: new Map() });
      const T = this.T;
      this.commons = new T.Scene();   // the ground between plots
      if (ground !== null) {
        const g = new T.Mesh(new T.PlaneGeometry(4000, 4000), new T.MeshBasicMaterial({ color: ground }));
        g.rotation.x = -Math.PI / 2; g.position.y = -0.02; g.name = "visit:commons";
        this.commons.add(g);
      }
      v._world = this;
      v._send({ type: "world", on: true });
      for (const w of [...v._links.values()]) if (w.wantWorld) v.toWorld(w.id);   // links that were in it before this page reloaded
      v._guestLinksToWorld();   // a guest's link already in the corner: its plot now there is a world
    }

    get inside() { return this.in != null; }
    get atHome() { return this.in != null && !!this.v.home && this.in === this.v.home.channel; }   // a user page, in its own room (engine/SPEC.md 4)
    // A user page's own room, as its host sends it (engine/SPEC.md 7): its scene's root, to read (a camera following
    // something in it), never to change (its host owns it; the next delta puts it back). Null until it has arrived.
    get room() { const s = this.v._homeScene(); return s ? s.root : null; }

    // Every plot you watch (with its scene), placed.
    _layout() {
      const now = performance.now();
      if (now - this.listAt < 4) return this.list;   // once a frame
      const v = this.v, mine = v._plot(), unit = v._unit(), taken = [], out = [], wait = [];
      taken.push([mine.center[0] - mine.size[0] / 2, mine.center[1] - mine.size[1] / 2, mine.center[0] + mine.size[0] / 2, mine.center[1] + mine.size[1] / 2]);
      const xs = [];
      for (const w of v._watches.values()) {
        if (!(w.scene && w.host.key)) continue;
        if (w.home) {   // the person's own room (engine/SPEC.md 4): its own plot, where its scene has it, as it is
          const x = { key: w.host.key, name: w.host.name || "", w, plot: w.scene.plot, k: 1, home: true, at: { x: w.scene.plot.center[0], z: w.scene.plot.center[1], turn: 0 } };
          x.rect = this._rect(x); out.push(x);
          continue;
        }
        xs.push({ key: w.host.key, name: w.host.name || "", w, plot: w.scene.plot, k: w.scene.unit / unit });
      }
      for (const k of v._kept.values()) {   // a guest's plot while they are away (8.10): its last landscape, where it was
        if (xs.some(x => x.key === k.key) || !isObj(k.plot) || !v.isGuest(k.key)) continue;
        if (!k.json) { if (!k.asked) { k.asked = true; v._send({ type: "plot_load", key: k.key }); } continue; }
        xs.push({ key: k.key, name: k.name, w: null, kept: k, plot: k.plot, k: k.unit / unit });
      }
      for (const x of xs) {
        const placed = v.layout.find(p => p.key === x.key);
        x.at = placed ? { x: placed.x, z: placed.z, turn: placed.turn | 0 } : null;
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
      this.plots = out.map(x => ({ key: x.key, name: x.name, at: x.at, rect: x.rect, inside: !!(x.w && x.w.inside), offline: !!x.kept, home: !!x.home }));
      const psig = this.plots.map(p => p.key + (p.offline ? "~" : "")).join();
      if (psig !== this.plotSig) { this.plotSig = psig; queueMicrotask(() => v._changed()); }   // a plot came, went, or is kept while its office is away
      this._tell(out, mine, unit);
      return out;
    }

    // Each friend in your world told where their room sits in it (8.4), when that changes, and nothing else of it:
    // their plot's middle in metres from yours (north -z), its quarter turns, and your plot's size. One no longer in
    // it is told that. visit-client tells them again over each link that comes up with them.
    _tell(out, mine, unit) {
      const v = this.v, r = x => Math.round(x * 100) / 100, size = v._plotMetres().map(r), now = new Set();
      for (const x of out) {
        if (x.home) continue;   // (not a friend's)
        const at = { dx: r((x.at.x - mine.center[0]) * unit), dz: r((x.at.z - mine.center[1]) * unit), turn: x.at.turn, size }, sig = JSON.stringify(at);
        now.add(x.key);
        if (this.told.get(x.key) !== sig) { this.told.set(x.key, sig); v._send({ type: "seen", key: x.key, at }); }
      }
      for (const key of [...this.told.keys()]) if (!now.has(key)) { this.told.delete(key); v._send({ type: "seen", key, at: null }); }
    }

    _rect(x) {
      const odd = x.at.turn % 2 === 1, hw = (odd ? x.plot.size[1] : x.plot.size[0]) * x.k / 2, hd = (odd ? x.plot.size[0] : x.plot.size[1]) * x.k / 2;
      return [x.at.x - hw, x.at.z - hd, x.at.x + hw, x.at.z + hd];
    }

    // A plot's scene in this world: turned and scaled into place (its middle where the layout says), its fog too.
    _holder(x) {
      const T = this.T, s = x.w ? x.w.scene : this._keptScene(x), id = x.w ? x.w.channel : "kept:" + x.key;
      let h = this.holders.get(id);
      if (!h || h.s !== s) {
        if (h && h.s.root.parent === h.place) h.place.remove(h.s.root);
        const holder = new T.Scene(), place = new T.Group();
        place.matrixAutoUpdate = false; holder.add(place); place.add(s.root);
        h = { holder, place, s, sig: "", fog: undefined, inverse: new T.Matrix4(), planes: [] };
        this.holders.set(id, h);
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

    // A guest's plot kept while they are away (8.10), as a scene: its landscape read with this page's three.js (as
    // data: cleanScene), lit softly if it brought no lights of its own, and over it its name: offline.
    _keptScene(x) {
      const k = x.kept, T = this.T;
      if (k.built && k.built.T === T) return k.built;
      const root = new T.Group();
      let land;
      try { land = new T.ObjectLoader().parse(cleanScene(k.json, { vertices: 0, objects: 0 })); }
      catch (e) { console.warn("visit: a kept plot that could not be read: drawn empty", e); land = new T.Group(); }
      root.add(land);
      let lit = false;
      land.traverse(o => { if (o.isLight) lit = true; });
      if (!lit) { root.add(new T.HemisphereLight(0xffffff, 0x445566, 0.6)); const d = new T.DirectionalLight(0xffffff, 0.45); d.position.set(5, 10, 7); root.add(d); }
      const label = bubble(T, `${k.name || "?"} · offline`, k.unit);
      label.position.set(k.plot.center[0], 3 / k.unit, k.plot.center[1]);
      root.add(label);
      k.built = { T, root, land };
      return k.built;
    }
    _keptForget(key) {
      const h = this.holders.get("kept:" + key);
      if (h) {
        this.holders.delete("kept:" + key);
        h.s.root.traverse(c => { if (c.geometry) c.geometry.dispose(); for (const m of list(c.material)) { if (m.map) m.map.dispose(); m.dispose(); } });
      }
      this.listAt = -1;
    }
    // Walked in your world at home, from where you were to where your page has you: a kept plot's walls (its owner
    // away, nobody to walk you there) walked into, not through, sliding along them as Visit.walk does.
    _walls(list, to) {
      const from = this.home;
      if (!from) return to;
      for (const x of list) {
        if (!x.kept || !(within(x.rect, from.x, from.z) || within(x.rect, to.x, to.z))) continue;
        const h = this._holder(x), T = this.T, u = this.v._unit(), ray = this.wallRay || (this.wallRay = new T.Raycaster()), o = new T.Vector3(), d = new T.Vector3();
        h.holder.updateMatrixWorld();
        const blocked = (fx, fz, tx, tz) => {
          d.set(tx - fx, 0, tz - fz);
          const len = d.length();
          if (len < 1e-6) return false;
          d.normalize();
          ray.far = len + 0.3 / u;
          for (const y of [0.4, 1.2]) { ray.set(o.set(fx, (Number(from.y) || 0) + y / u, fz), d); if (ray.intersectObject(h.s.land, true).length) return true; }
          return false;
        };
        if (!blocked(from.x, from.z, to.x, to.z)) continue;
        if (!blocked(from.x, from.z, to.x, from.z)) to = Object.assign({}, to, { z: from.z });
        else if (!blocked(from.x, from.z, from.x, to.z)) to = Object.assign({}, to, { x: from.x });
        else to = Object.assign({}, to, { x: from.x, z: from.z });
      }
      return to;
    }

    _forget(w) {
      const h = this.holders.get(w.channel);
      if (h && h.s.root.parent === h.place) h.place.remove(h.s.root);
      this.holders.delete(w.channel);
      if (this.in === w.channel) this.in = null;
      this.listAt = -1;
    }

    // Where your user is now: at home, where your page says (stepping onto a plot takes them in); in a plot, where
    // its host has them (walked at once as it walks, put right by its answers), until it has them off it.
    frame(dt, me, input = {}) {
      const t0 = this.v._perf ? performance.now() : 0;
      this.me = this._frame(dt, me, input);
      if (this.v._perf) this.v._pt("world", performance.now() - t0);
      return this.me;
    }
    _frame(dt, me, input) {
      const v = this.v, T = this.T, now = performance.now();
      dt = Math.min(0.1, Math.max(0, Number(dt) || 0));
      me = { x: Number(me.x) || 0, y: Number(me.y) || 0, z: Number(me.z) || 0, yaw: Number(me.yaw) || 0, pitch: Number(me.pitch) || 0, air: Math.max(0, Number(me.air) || 0),
        facing: Number.isFinite(Number(me.facing)) ? Number(me.facing) : undefined };
      this.look = { yaw: me.yaw, pitch: me.pitch };
      if (this.bounce) { const b = this.bounce; this.bounce = null; this.home = b; return Object.assign({}, b, { yaw: me.yaw, pitch: me.pitch, in: null }); }
      const list = this._layout();
      v._home = null;   // said below, where they end up
      const user = v.role === "user", onto = (px, pz) => list.find(y => y.w && y.w.scene && !y.w.home && !y.w.inside && (this.refused.get(y.w.channel) || 0) <= now && within(y.rect, px, pz));
      let x = this.in != null ? list.find(y => y.w && y.w.channel === this.in) : null;
      if (x && !(x.w.inside && x.w.scene)) x = null;
      if (!x) {
        // Out of a plot by any way but walking off it (its door shut, its page gone, leave()): home at the height we
        // came with, not one its host had us at, which a page that keeps the y it is given would otherwise keep.
        if (this.yHome != null) { me.y = this.yHome; this.yHome = null; }
        this.in = null;
        x = onto(me.x, me.z);
        if (!x && user) {   // a user page (engine/SPEC.md 4): home is a plot too, its host walks them; into it where they are
          x = list.find(y => y.w && y.w.home && y.w.scene);
          if (!x) { this.home = me; return Object.assign({}, me, { in: null }); }   // their room not here yet: nowhere to be
        }
        if (!x) { me = this._walls(list, me); this.home = me; v._home = { x: me.x, y: me.y, z: me.z, yaw: me.yaw }; this._homeRide(me, dt); return Object.assign({}, me, { in: null }); }
        this._enter(x, me, now);
      }
      this._homeRide(null, dt);   // on a plot: its host draws your mount
      const w = x.w, s = w.scene, h = this._holder(x), yaw = me.yaw - x.at.turn * Math.PI / 2;
      const inp = { forward: Math.sign(Number(input.forward) || 0), strafe: Math.sign(Number(input.strafe) || 0), up: Math.sign(Number(input.up) || 0), run: !!input.run };
      if (s.walk && !w.paused) { const q = walk({ x: s.pose.x, z: s.pose.z, yaw }, inp, dt, v._rideWalk(s.walk)); s.pose.x = q.x; s.pose.z = q.z; }
      s.hist.push([now, s.pose.x, s.pose.z]);
      while (s.hist.length > 2 && now - s.hist[0][0] > 2000) s.hist.shift();
      const fade = Math.exp(-dt / 0.1); s.vis.x *= fade; s.vis.y *= fade; s.vis.z *= fade;
      this._input(w, inp, yaw, me.pitch, now);
      const hp = s.hostPose, pl = s.plot, margin = 0.3 / x.k;
      if (!hp && now - s.inAt > ENTER_WAIT) { this._refused(w, "no answer"); return this._frame(0, me, {}); }   // its host never had us: back out
      if (w.home) {   // at home, walked by its room: onto a friend's plot where the room has them on one; never off home by its edge
        const at = new T.Vector3(s.pose.x + s.vis.x, 0, s.pose.z + s.vis.z).applyMatrix4(h.place.matrix), y = hp ? this._feet(x, s, h) : me.y;
        const other = hp ? onto(at.x, at.z) : null;
        if (other) {
          const me2 = { x: at.x, y, z: at.z, yaw: me.yaw, pitch: me.pitch, air: me.air };
          this._enter(other, me2, now);
          return Object.assign({}, me2, { in: { key: other.key, name: other.name } });
        }
        this.home = { x: at.x, y, z: at.z, yaw: me.yaw, pitch: me.pitch };
        v._home = { x: at.x, y, z: at.z, yaw: me.yaw };
        return { x: at.x, y, z: at.z, yaw: me.yaw, pitch: me.pitch, in: null };
      }
      if (hp && (Math.abs(hp.x - pl.center[0]) > pl.size[0] / 2 + margin || Math.abs(hp.z - pl.center[1]) > pl.size[1] / 2 + margin)) {
        this._exit(w);   // its host has us off its plot: home again, walking on from there
        const out = new T.Vector3(hp.x, 0, hp.z).applyMatrix4(h.place.matrix);
        // home at the height we came with, or lower if its host had us lower (come down from flying in): never higher
        // (a room's upstairs is not ours)
        this.home = { x: out.x, y: Math.min(this.yHome, this._feet(x, s, h)), z: out.z, yaw: me.yaw, pitch: me.pitch };
        this.yHome = null;
        v._home = { x: out.x, y: this.home.y, z: out.z, yaw: me.yaw };
        return Object.assign({}, this.home, { in: null });
      }
      const at = new T.Vector3(s.pose.x + s.vis.x, 0, s.pose.z + s.vis.z).applyMatrix4(h.place.matrix);
      // As high as its host has us (a stair, a lift, flying, coming down), until it first says: where we stepped on.
      const y = hp ? this._feet(x, s, h) : this.yHome;
      v._home = { x: at.x, y, z: at.z, yaw: me.yaw };   // in a plot: heard from there, in this world
      return { x: at.x, y, z: at.z, yaw: me.yaw, pitch: me.pitch, in: { key: x.key, name: x.name } };
    }

    // Our feet in a plot, in this world's terms: where its host has our eyes, less how far above its floor it keeps
    // eyes (its `eye`; an older host's, 1.6 m), through where this world puts its plot.
    _feet(x, s, h) {
      const b = this.v._bodies.get(x.w.channel), eye = b && b.eyes ? b.eyes : s.eye != null ? s.eye : EYES / (s.unit || 1);
      return new this.T.Vector3(s.pose.x, s.pose.y + s.vis.y - eye, s.pose.z).applyMatrix4(h.place.matrix).y;
    }

    _enter(x, me, now) {
      const w = x.w, s = w.scene, h = this._holder(x), p = new this.T.Vector3(me.x, 0, me.z).applyMatrix4(h.inverse), yaw = me.yaw - x.at.turn * Math.PI / 2;
      if (this.in != null && this.in !== w.channel) { const was = this.v._watches.get(this.in); if (was) { was.inside = false; if (was.scene) was.scene.hostPose = null; } }   // out of the one before (its host told by visit-client)
      this.v._send({ type: "enter", channel: w.channel, pose: { x: p.x, y: me.y / x.k, z: p.z, yaw, air: me.air / x.k } });
      w.inside = true; this.in = w.channel;
      Object.assign(s, { pose: { x: p.x, y: 0, z: p.z }, yaw0: 0, hist: [], vis: { x: 0, y: 0, z: 0 }, hostPose: null, inAt: now });
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
      const sig = [inp.forward, inp.strafe, inp.up, inp.run, this.v.riding, yaw.toFixed(3), pitch.toFixed(3)].join();
      if (now - this.sent.at < (sig !== this.sent.sig ? INPUT_MIN_MS : INPUT_MS)) return;
      this.sent = { at: now, sig };
      this.v._send({ type: "input", forward: inp.forward, strafe: inp.strafe, up: inp.up, run: inp.run, riding: this.v.riding, yaw, pitch: Math.max(-1.4, Math.min(1.4, pitch)), t: now });
    }

    // While in a plot: point where you look (SPEC 8.3). Home: out of the plot you are in.
    // A click, as a visitor's point (SPEC 8.3): where this page looks, or, given `target` (a point in this page's world,
    // what its own ray from its camera met in the plot), the way to it from where the host has this page's eyes: a
    // camera behind you looks along another line than your eyes do (a user page's, engine/SPEC.md 7).
    point(target) {
      const x = this.in != null && this.list.find(y => y.w && y.w.channel === this.in);
      if (!x) return false;
      let yaw = this.look.yaw - x.at.turn * Math.PI / 2, pitch = this.look.pitch;
      if (target && this.me) {
        const T = this.T, h = this._holder(x), eyes = ((this.v._bodies.get(x.w.channel) || {}).eyes) || EYES;
        const from = new T.Vector3(this.me.x, 0, this.me.z).applyMatrix4(h.inverse), to = new T.Vector3(Number(target.x) || 0, 0, Number(target.z) || 0).applyMatrix4(h.inverse);
        from.y = this.me.y / x.k + eyes; to.y = (Number(target.y) || 0) / x.k;
        to.sub(from);
        if (to.lengthSq() > 1e-6) { yaw = Math.atan2(-to.x, -to.z); pitch = Math.max(-1.4, Math.min(1.4, Math.asin(to.y / to.length()))); }
      }
      this.v._send({ type: "point", yaw, pitch });
      return true;
    }
    leave() { const w = this.in != null && this.v._watches.get(this.in); if (w) this._exit(w); }

    // Your room (clipped to your plot), the ground between plots, then each plot (clipped to its own), into one
    // depth buffer: what is nearer hides what is behind, across plots. Each plot lit by its own lights.
    render(camera) {
      const t0 = this.v._perf ? performance.now() : 0;
      try { this._render(camera); } finally { if (this.v._perf) this.v._pt("draw", performance.now() - t0); }
    }
    _render(camera) {
      const r = this.renderer, auto = r.autoClear, planes = r.clippingPlanes, now = performance.now(), v = this.v;
      const list = this._layout(), mine = v._plot();
      try {
        r.clippingPlanes = !this.clipOwn ? [] : (() => {
          const T = this.T, x0 = mine.center[0] - mine.size[0] / 2, x1 = mine.center[0] + mine.size[0] / 2, z0 = mine.center[1] - mine.size[1] / 2, z1 = mine.center[1] + mine.size[1] / 2;
          const sig = [x0, z0, x1, z1].join();
          if (this.mineSig !== sig) { this.mineSig = sig; this.minePlanes = [new T.Plane(new T.Vector3(1, 0, 0), -x0), new T.Plane(new T.Vector3(-1, 0, 0), x1), new T.Plane(new T.Vector3(0, 0, 1), -z0), new T.Plane(new T.Vector3(0, 0, -1), z1)]; }
          return this.minePlanes;
        })();
        const own = r.clippingPlanes;
        // Your scene's sky alone first (its background: nothing of it drawn, nor its shadows worked out again), then the
        // ground between plots; then the rooms farthest first, the nearest last, so that each one's see-through things
        // (a name over a head, a window) land on what is behind them, not under a farther room drawn after it.
        const mask = camera.layers.mask, su = r.shadowMap.autoUpdate;
        const hx = !this.scene && list.find(x => x.home), sky = this.scene || (hx ? hx.w.scene.root : this.commons);   // a user page: its room's sky
        r.clippingPlanes = []; r.shadowMap.autoUpdate = false; camera.layers.set(31);
        try { r.render(sky, camera); } finally { camera.layers.mask = mask; r.shadowMap.autoUpdate = su; }
        r.autoClear = false;
        this.commons.fog = sky.fog || null;
        r.render(this.commons, camera);
        const eye = camera.getWorldPosition(this._eye || (this._eye = new this.T.Vector3()));
        const far = q => Math.hypot(Math.max(q[0] - eye.x, 0, eye.x - q[2]), Math.max(q[1] - eye.z, 0, eye.z - q[3]));
        const home = [mine.center[0] - mine.size[0] / 2, mine.center[1] - mine.size[1] / 2, mine.center[0] + mine.size[0] / 2, mine.center[1] + mine.size[1] / 2];
        const passes = [...(this.scene ? [{ x: null, d: far(home) }] : []), ...list.filter(x => x.kept || (x.w && x.w.scene)).map(x => ({ x, d: far(x.rect) }))].sort((a, b) => b.d - a.d);
        for (const { x } of passes) {
          if (!x) {   // your own room (its sky already drawn)
            const bg = this.scene.background;
            this.scene.background = null;
            r.clippingPlanes = own;
            try { r.render(this.scene, camera); } finally { this.scene.background = bg; }
            continue;
          }
          if (x.kept) { const h = this._holder(x); r.clippingPlanes = h.planes; r.render(h.holder, camera); continue; }   // a guest away: its kept plot
          const h = this._holder(x), s = x.w.scene;
          if (s.offset !== null) v._sceneInterp(s, now - s.offset - INTERP_MS);
          const shown = x.w.home && this.self === "room";   // at home, the room's copy of you is you (self)
          for (const o of s.own) o.visible = shown;
          r.clippingPlanes = h.planes;
          r.render(h.holder, camera);
          if (now - s.gcAt > 30000) { s.gcAt = now; v._sceneGc(s); }   // what its room no longer uses, freed
        }
        if (this.bubbles && ((this.showLines && v._chats.size) || (this.showSpeaking && v.voices.some(x => x.speaking)) || this.bubbles.by.size)) this._bubbles(camera, list);
      } finally { r.autoClear = auto; r.clippingPlanes = planes; }
    }

    // The lines said (8.9) over their speakers, everywhere this world shows: at home, you and your visitors (their
    // bodies in your scene, as your room marks them, or where you have them); on each plot, its owner (its mark), its
    // visitors (their bodies there) and you. The 🔊 marks, in the room your user is in.
    _bubbles(camera, list) {
      const v = this.v, b = this.bubbles, u = v._unit(), hk = v._hooks, me = this.me, x = this.in != null && list.find(p => p.w && p.w.channel === this.in);
      const mine = () => me ? { x: me.x, y: (Number(me.y) || 0) + 2.4 / u, z: me.z } : null;
      const homeRoot = hk ? hk.scene.root : (v._homeScene() || {}).root;   // your scene's bodies (a user page's: its room's, from its host), looked for once a second
      if (!homeRoot) return;
      if (!this.homeBodies || this.homeBodies.root !== homeRoot) this.homeBodies = { root: homeRoot, bodiesAt: 0 };
      const over = (h, up, gap) => b.over(v._body(this.homeBodies, h.id), up, gap) || (h.pose ? { x: h.pose.x, y: (Number(h.pose.y) || 0) + (h.eyes || 0) + gap * 2, z: h.pose.z } : null);
      let items = v._chatsIn("home", c => {
        if (c.mine) return mine();
        if (c.npc) return b.over(homeRoot.getObjectByName("visit:npc:" + c.npc), 2.4 / u, 0.6 / u);   // one of your room's figures
        const h = v._hosted.get(c.channel);
        return h ? over(h, 2.4 / u, 0.6 / u) : null;
      }), speakers = [];
      for (const p of list) {
        if (!p.w || !p.w.scene) continue;
        const s = p.w.scene;
        items = items.concat(v._chatsIn(p.w.channel, c => c.mine ? mine() : b.over(c.id ? v._body(s, c.id) : s.root.getObjectByName(c.npc ? "visit:npc:" + c.npc : "visit:me"), 2.4 / u, 0.6 / u)));
      }
      if (this.showSpeaking && x && x.w.scene) { const s = x.w.scene, hostKey = (x.w.host || {}).key; speakers = v._speakersIn(key => v._speakerIn(s, hostKey, key, b, u)); }
      else if (this.showSpeaking) speakers = v._speakersIn(key => {
        const h = [...v._hosted.values()].find(y => y.inside && y.visitor.key === key);
        if (h) return over(h, 2.0 / u, 0.15 / u);
        const p = list.find(p => p.w && p.w.scene && !p.w.inside && p.w.host.key === key);   // a friend across your plot's side, at home in theirs
        return p ? b.over(p.w.scene.mark, 2.0 / u, 0.15 / u) : null;
      });
      b.draw(this.renderer, camera, (this.showLines ? items : []).concat(speakers), u);
    }

    // Your own mount at home (8.11): under your user's feet (`me.y`, and `me.facing`, the way they face: else where
    // they look), in your scene, so your visitors see it too. Your page lifts your user onto it (v.rideLift) and
    // walks them at its pace (v.rideSpeed); on a plot, its host draws it.
    _homeRide(me, dt) {
      const v = this.v, id = me ? v.riding : null, r = this.ride;
      if (r && r.id !== id) { if (r.object.parent) r.object.parent.remove(r.object); if (r.mixer) r.mixer.stopAllAction(); this.ride = null; }
      if (!id || !this.scene) return;
      if (!this.ride) {
        const p = v._own.find(x => x.id === id);
        if (!p) return;
        const mixer = new this.T.AnimationMixer(p.object), clip = n => (p.object.animations || []).find(c => new RegExp(n, "i").test(c.name));
        const clips = Object.fromEntries(["idle", "walk", "run", "fly"].map(n => [n, (c => c ? mixer.clipAction(c) : null)(clip(n))]));
        this.ride = { id, fly: p.fly, object: p.object, mixer, clips, playing: null, at: null };
        this.ride.object.name = "visit:my-mount";
        this.scene.add(this.ride.object);
      }
      const o = this.ride.object, u = v._unit(), facing = Number.isFinite(Number(me.facing)) ? Number(me.facing) : me.yaw;
      o.position.set(me.x, me.y, me.z); o.rotation.set(0, facing, 0);
      const mps = this.ride.at ? Math.hypot(me.x - this.ride.at.x, me.z - this.ride.at.z) / Math.max(dt, 1e-3) * u : 0;
      this.ride.at = { x: me.x, z: me.z };
      rideAnimate(this.ride, this.ride.fly && me.air > 0.05 ? "fly" : mps > 0.3 ? "walk" : "idle", mps, dt);
    }

    release() {
      this.leave();
      this._homeRide(null, 0);
      if (this.bubbles) this.bubbles.release();
      for (const w of this.v._watches.values()) this._forget(w);
      for (const key of this.told.keys()) this.v._send({ type: "seen", key, at: null });   // no world now: in none of it
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
.visit-panel input { flex: 1; min-width: 0; }
.visit-panel .note { color: #e3b341; }
.visit-panel button.who { border: 0; background: none; padding: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.visit-panel button.caret { border: 0; background: none; padding: 0 4px; color: #8b949e; }
.visit-panel .sub { display: block; padding-left: 30px; border-top: 0; }
.visit-panel .sub .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.visit-panel .seg { display: inline-flex; } .visit-panel .seg button { border-radius: 0; } .visit-panel .seg button + button { border-left: 0; }
.visit-panel .seg button:first-child { border-radius: 6px 0 0 6px; } .visit-panel .seg button:last-child { border-radius: 0 6px 6px 0; }
.visit-panel .seg button.on2 { background: #1f6feb; border-color: #1f6feb; color: #fff; }`;

  // Where a friend's world has put your room (8.4, `seen`), said plainly: which way from theirs (north is -z), and how
  // far apart the two plots' edges are.
  function seenText(v, name, at) {
    if (!at) return `${name} took your room out of their world`;
    const dx = Number(at.dx) || 0, dz = Number(at.dz) || 0, [W, D] = v._plotMetres(), [mw, md] = (at.turn | 0) % 2 ? [D, W] : [W, D];
    const [tw, td] = Array.isArray(at.size) ? at.size.map(Number) : [NaN, NaN];
    const gap = Math.max(Math.abs(dx) - (tw + mw) / 2, Math.abs(dz) - (td + md) / 2);
    const dir = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][(Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) + 8) % 8];
    if (gap <= 0.5) return `${name} put your room right next to theirs, to the ${dir}`;
    return `${name} put your room ${dir} of theirs` + (Number.isFinite(gap) ? `, ${Math.round(gap)} m off` : "");
  }

  function panel(element, v, { chat: withChat = true } = {}) {
    v._as("user", "panel");
    if (!document.getElementById("visit-panel-css")) {
      const st = document.createElement("style"); st.id = "visit-panel-css"; st.textContent = PANEL_CSS; document.head.appendChild(st);
    }
    const root = document.createElement("div");
    root.className = "visit-panel";
    element.appendChild(root);
    let composing = null, timer = null, drawn = "";
    const opened = new Set();   // the people (key, else office id) shown opened
    const cw = withChat ? chat(v) : null;   // the chat window (8.9), bottom left (chat: false, none: your page has its own)
    // M, anywhere but a box of the page's own: on your mount, or off (8.11).
    const mountChosen = () => v._mountOf(v.mount) ? v.mount : v.mounts[0].id;
    const mountKey = e => {
      if (e.code !== MOUNT_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || !v.mounts.length) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      v.ride(v.riding ? null : mountChosen());
    };
    addEventListener("keydown", mountKey);
    const always = new Set();   // links on your door to let in for good (a guest, ★), as you answer them
    // Notes, a while each: where a friend's world put your room (once it settles: a friend dragging it about on their
    // Map tells you at every step; never again for the same place), and a call that ended other than hung up.
    let notes = [];
    const note = text => { notes = notes.filter(n => n.until > Date.now()).concat([{ text, until: Date.now() + 10000 }]).slice(-3); drawn = ""; draw(); setTimeout(draw, 10100); };
    const seenSaid = new Map((v.seen || []).map(x => [x.key, JSON.stringify(x.at)])), seenWait = new Map();
    const onSeen = ({ key, name, at }) => {
      clearTimeout(seenWait.get(key));
      seenWait.set(key, setTimeout(() => {
        seenWait.delete(key);
        const sig = JSON.stringify(at || null);
        if (seenSaid.get(key) === sig || (!at && !seenSaid.has(key))) return;
        seenSaid.set(key, sig);
        note(seenText(v, name || "A friend", at));
      }, 1500));
    };
    const onCall = e => { if (e.state === "ended" && e.why && e.why !== "hung up") note(`📞 ${e.name}: ${e.why}`); };
    // Models (8.6): yours, as other rooms will read it, and how you look in the room you are in, once each.
    const modelSaid = new Set();
    const onModel = e => { if (e.problems.length && !modelSaid.has(e.what + e.problems[0])) { modelSaid.add(e.what + e.problems[0]); note(`${e.what}: ${e.problems[0]}${e.problems.length > 1 ? ` (and ${e.problems.length - 1} more: see the console)` : ""}`); } };
    const onBody = e => { if (e.problem && !modelSaid.has(e.channel + e.problem)) { modelSaid.add(e.channel + e.problem); note(`In ${e.name || "their"} room you look like their model: yours can't be shown (${e.problem})`); } };
    v.on("seen", onSeen); v.on("call", onCall); v.on("model", onModel); v.on("body", onBody);
    function draw() {
      if (root.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // never under a typing hand
      const me = v.office, rows = [];
      rows.push(`<div class="row hd"><span class="dot ${v.state === "online" ? esc(v.status) : ""}"></span><span class="grow">Visit${me ? " · " + esc(me.name) : ""}</span><span class="muted">${esc(v.state)}</span><button data-v="perf" class="${v._perf ? "go" : ""}" title="how this page is doing: frames, stalls, and what Visit does (on or off)">⏱</button>${v.state === "online" ? `<button data-v="away" title="leave the lobby: nobody sees you or can link until you come back">Go offline</button>` : ""}</div>`);
      if (v.state === "away") rows.push(`<div class="row"><span class="grow muted">out of the lobby: nobody sees you or can link</span><button class="go" data-v="back">Go online</button></div>`);
      for (const n of notes) if (n.until > Date.now()) rows.push(`<div class="row note">${esc(n.text)}</div>`);
      if (v.state === "online") {
        rows.push(`<div class="row"><span class="grow">you are</span><select data-v="status">${["available", "busy"].map(s => `<option${s === v.status ? " selected" : ""}>${s}</option>`).join("")}</select>
          <select data-v="max" title="how many visitors at once">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}"${n === v.maxVisitors ? " selected" : ""}>${n} visitors</option>`).join("")}</select></div>`);
        rows.push(`<div class="row"><span class="grow">your door</span><select data-v="door" title="open: your guests (★) link and walk in without asking">
          <option value="open"${v.door === "open" ? " selected" : ""}>open to guests</option><option value="closed"${v.door === "closed" ? " selected" : ""}>closed: everyone asks</option></select>
          <span class="muted">${v.guests.length} ★</span></div>`);
        rows.push(`<div class="row"><span class="grow">visitors look like</span><select data-v="looks" title="in your room: the look each one brings (their model), or your own (our model); one can be set apart (click them below)">
          <option value="theirs"${v.avatars.default === "theirs" ? " selected" : ""}>their model</option><option value="mine"${v.avatars.default === "mine" ? " selected" : ""}>our model</option></select></div>`);
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
      // Your phone (8.8): a call to make, to those linked to you whose rooms have phones.
      if (v._phone && !v.calls.length && v.phones.length) rows.push(`<div class="row lnk"><div>📞 call</div><div class="btns">${v.phones.map(p => `<button data-v="call" data-key="${esc(p.key)}" title="ring their phone">${esc(p.name)}</button>`).join("")}</div></div>`);
      // Calls (8.8): ringing, calling, on.
      for (const c of v.calls) rows.push(`<div class="row lnk"><div>📞 ${c.state === "ringing" ? `<b>${esc(c.name)}</b> is calling` : c.state === "calling" ? `calling <b>${esc(c.name)}</b>…`
        : `on a call with <b class="${c.speaking ? "speaking" : ""}">${esc(c.name)}</b>`}</div><div class="btns">${c.state === "ringing" ? `<button class="go" data-v="pick_up" data-key="${esc(c.key)}">Pick up</button>` : ""}${c.state === "on"
          ? `<button data-v="speaker" data-key="${esc(c.key)}" class="${c.speaker ? "go" : ""}" title="${c.speaker ? "on speaker: everyone near your phone hears and is heard (click: to your ear)" : "to your ear: only you (click: on speaker, for everyone near your phone)"}">${c.speaker ? "🔊 speaker" : "📞 handset"}</button>` : ""}<button data-v="hang_up" data-key="${esc(c.key)}">${c.state === "ringing" ? "Not now" : "Hang up"}</button></div></div>`);
      // Voice (8.7): those near you in the room you are in; your microphone on or off.
      if (v.state === "online") rows.push(`<div class="row"><span class="grow">${v.voices.length ? "near you: " + v.voices.map(x => `<b class="${x.speaking ? "speaking" : ""}">${x.speaking ? "🔊 " : ""}${esc(x.name)}</b>`).join(", ") : `voice <span class="muted">· nobody near you</span>`}</span>
        <button data-v="mic" class="${v.mic ? "go" : ""}" title="${v.mic ? "those near you hear you (click: microphone off)" : "your microphone: those near you hear you, the nearer the louder (headphones are best)"}">${v.mic ? "🎙 on" : "🎙 off"}</button></div>`);
      // The room voice you are in (8.7): whose, who is in it; Leave.
      if (v.roomVoice) { const rv = v.roomVoice; rows.push(`<div class="row"><span class="grow">🎧 ${esc(rv.key === v.key ? "your room's" : `${rv.name}'s room's`)} voice${rv.joining ? " <span class=\"muted\">· joining…</span>"
        : `: ${rv.members.map(x => `<b class="${x.speaking ? "speaking" : ""}">${x.speaking ? "🔊 " : ""}${esc(x.key === v.key ? "you" : x.name)}</b>`).join(", ")}`}</span><button data-v="voice_leave" title="out of this voice">Leave</button></div>`); }
      // Your mount (8.11), once your room gives one: which one M gets you on, and on or off.
      if (v.mounts.length) rows.push(`<div class="row"><span class="grow">${v.riding ? "riding" : "your mount"}</span><select data-v="mount" title="the one M gets you on" style="max-width: 9em">${v.mounts.map(m =>
        `<option value="${esc(m.id)}"${m.id === v.mount ? " selected" : ""}>${esc(m.name)}${m.fly ? " (flies)" : ""}</option>`).join("")}</select><button data-v="ride" class="${v.riding ? "go" : ""}" title="M: on your mount, or off">${v.riding ? "Get off" : "Ride"}</button></div>`);
      const roundYours = v._world ? v._world.plots.filter(p => !p.home) : [];   // (a user page's own room is a plot too)
      if (v._world && v.state === "online") rows.push(`<div class="row"><span class="grow">your world: ${roundYours.length} ${roundYours.length === 1 ? "room" : "rooms"} round yours${(n => n ? ` (${n} offline)` : "")(roundYours.filter(p => p.offline).length)}</span><button data-v="map" title="where your friends' rooms sit round yours, from above">Map</button></div>`);
      // People: one row each, whoever is in the lobby and whoever you are linked with, either way, linked first. A
      // linked one says where you two stand (in your room, in theirs, linked); click it for the rest: where each sees
      // the other, Go there or Put in my world, how they look in your room, Kick, Unlink. One not linked: Link.
      const people = [];
      const person = (who, add) => {
        if (!who) return;
        let p = people.find(x => (who.key && x.key === who.key) || (who.id && x.id === who.id));
        if (!p) people.push(p = { key: null, id: null, name: "", office: null, links: [], visit: null, watches: [], plot: null, there: false });
        p.key = p.key || who.key || null; p.id = p.id || who.id || null; p.name = p.name || String(who.name || "");
        add(p);
      };
      for (const o of v.offices) if (!me || o.id !== me.id) person(o, p => { p.office = o; });
      for (const l of v.links) person(l.host, p => p.links.push(l));
      for (const x of v.visitors) person(x.visitor, p => { p.visit = x; });
      for (const x of v.watchers) if (!x.inside) person(x.visitor, p => p.watches.push(x));
      for (const w of v._watches.values()) if (!w.link && !w.home) person(w.host, p => { p.plot = w; });   // (home is your own room)
      if (v.visiting && !v.visiting.link) person(v.visiting.host, p => { p.there = true; });
      const linked = p => !!(p.links.length || p.visit || p.watches.length || p.plot || p.there);
      const more = p => {   // a linked one, opened: where each sees the other (beyond its row's own word), what you can do
        const seen = [], btns = [];
        for (const l of p.links) {
          const id = esc(l.id);
          if (!l.inside) seen.push(l.where === "world" ? "their room is in your world" : l.where === "aside" ? "their room waits for your corner" : "their room is in your corner");
          if (l.where === "aside") btns.push(`<button data-v="show" data-x="${id}">Show</button>`);
          else if (l.where === "corner" && !l.inside) btns.push(`<button class="go" data-v="step_in" data-x="${id}" title="walk into their room">Go there</button>${v._world ? `<button data-v="to_world" data-x="${id}" title="their room as a plot beside yours, walked onto">Put in my world</button>` : ""}`);
        }
        if (p.plot) seen.push("their room is in your world");
        for (const x of p.watches) seen.push(x.link ? "they see your room" : "your room is in their world");
        // How each of you is drawn where the other is (8.6): their model here, and yours there.
        const here = p.visit && v.visitors.find(x => x.id === p.visit.id);
        if (here && here.problem) seen.push(`their model can't be shown here: ${here.problem}`);
        const inThere = [...v._links.values(), ...v._watches.values()].find(w => w.inside && (w.host.key === p.key || w.host.id === p.id));
        const there = (inThere && v._bodies.get(inThere.channel)) || (p.there && v._viewer && v._bodies.get(v._viewer.channel));
        if (there) seen.push(there.look === "theirs" ? "there, you look like your own model" : `there, you look like their model${there.problem ? ` (yours can't be shown: ${there.problem})` : ""}`);
        if (p.key) {
          const u = v.avatarUse(p.key);
          btns.push(`<span class="seg" title="how ${esc(p.name)} looks in your room">${[["theirs", "their model"], ["mine", "our model"]].map(([w, t]) =>
            `<button data-v="look" data-key="${esc(p.key)}" data-use="${w}" class="${u === w ? "on2" : ""}">${t}</button>`).join("")}</span>`);
        }
        // Your room's voice and chat (8.9): kept out of either, until you lift it; out of its voice now.
        if (v.voiceMembers.some(x => x.key === p.key)) seen.push("in your room's voice");
        const by = p.key && v.bannedBy.find(b => b.key === p.key);
        if (by) seen.push(`their room keeps you out of its ${by.voice && by.chat ? "voice and chat" : by.voice ? "voice" : "chat"}`);
        if (p.key) {
          const ban = v.banOf(p.key) || { voice: false, chat: false };
          btns.push(`<span class="seg" title="keep ${esc(p.name)} out of your room's voice, or its chat (until you lift it)">${["voice", "chat"].map(w =>
            `<button data-v="ban" data-key="${esc(p.key)}" data-what="${w}" class="${ban[w] ? "on2" : ""}">${ban[w] ? `${w} banned` : `ban ${w}`}</button>`).join("")}</span>`);
          if (v.voiceMembers.some(x => x.key === p.key)) btns.push(`<button data-v="voice_kick" data-key="${esc(p.key)}" title="out of your room's voice now (they may come back)">Kick from voice</button>`);
        }
        if (p.visit) btns.push(`<button data-v="kick" data-x="${esc(p.visit.id)}" title="out of your room">Kick</button>`);
        btns.push(`<button data-v="cut" data-p="${esc(p.key || p.id)}" title="every link between you two ends${p.key && v.isGuest(p.key) ? ", and they are no longer a guest (★)" : ""}">Unlink</button>`);
        return `<div class="row sub">${seen.length ? `<div class="muted">${[...new Set(seen)].join(" · ")}</div>` : ""}<div class="btns">${btns.join("")}</div></div>`;
      };
      for (const p of [...people.filter(linked), ...people.filter(p => !linked(p))]) {
        const o = p.office, dot = `<span class="dot ${o ? esc(o.status) : ""}"></span>`;
        if (linked(p)) {
          const k = p.key || p.id, open = opened.has(k), inside = p.links.find(l => l.inside && l.where === "corner");
          const state = p.visit ? "in your room" : p.there || inside ? "you are in their room" : "linked";
          const back = p.there ? `<button data-v="leave">Leave</button>` : inside ? `<button data-v="step_out" data-x="${esc(inside.id)}" title="your own room; theirs back in the corner">Back to my room</button>` : "";
          const who = (p.key && v.userOf(p.key)) || p.name, room = who !== p.name ? ` <span class="muted">(${esc(p.name)})</span>` : "";   // the name they go by, their office's after it
          rows.push(`<div class="row">${dot}${star(p.key, p.name)}<button class="who grow" data-v="more" data-p="${esc(k)}" title="${open ? "less" : "more: where you see each other, their look, Unlink"}"><b>${esc(who)}</b>${room} <span class="muted">· ${state}</span></button>${back}<button class="caret" data-v="more" data-p="${esc(k)}">${open ? "▾" : "▸"}</button></div>`);
          if (open) rows.push(more(p));
          continue;
        }
        if (!o) continue;
        const word = o.links ? "Link" : "Knock", asking = v.knocking.some(k => k.to === o.id);
        const why = !o.ready ? "not ready" : o.status !== "available" ? o.status : !o.links && o.visitors >= o.maxVisitors ? "full" : asking ? "asking…" : "";
        const ou = o.key && v.userOf(o.key);
        rows.push(`<div class="row">${dot}${star(o.key, o.name)}<span class="grow" title="${esc(o.name)}">${ou ? `<b>${esc(ou)}</b> <span class="muted">(${esc(o.name)})</span>` : esc(o.name)} <span class="muted">${esc(o.sim.name || "")} ${o.visitors}/${o.maxVisitors}</span></span>
          <button data-v="knock" data-o="${esc(o.id)}" ${why ? `disabled title="${esc(why)}"` : `title="${o.links ? "see their room in a corner, once they say yes: then go there, or put it in your world" : "an older Visit: you walk into their room once they say yes"}"`}>${asking ? `${word}ing…` : word}</button></div>`);
        if (composing === o.id) rows.push(`<form class="row" data-o="${esc(o.id)}"><input maxlength="280" placeholder="a message for ${esc(o.name)}"><button class="go">${word}</button></form>`);
      }
      if (v.state === "online" && v.offices.length < 2) rows.push(`<div class="row muted">nobody else is here yet</div>`);
      if (cw && v.state === "online") rows.push(`<div class="row muted" title="Enter, or /: type a line. /s say (everyone who can see you), /w name (into a linked room), /1 the lobby, /r reply">Enter to chat</div>`);
      const html = rows.join("");
      if (html === drawn) return;   // nothing new: an open menu stays open, a click lands
      drawn = html;
      root.innerHTML = html;
      const input = root.querySelector("form[data-o] input");   // a knock's message, being written
      if (input) input.focus();
    }
    root.addEventListener("click", e => {
      const b = e.target.closest("button[data-v]");
      if (!b) return;
      const act = b.dataset.v;
      if (act === "knock") { composing = composing === b.dataset.o ? null : b.dataset.o; draw(); }
      else if (act === "more") { if (!opened.delete(b.dataset.p)) opened.add(b.dataset.p); draw(); }
      else if (act === "cut") {   // every link between you two, ended both ways; no longer a guest (their world would come back)
        const k = b.dataset.p, is = who => !!who && (who.key === k || who.id === k), ends = new Set();
        if (v.isGuest(k)) v.removeGuest(k);
        for (const l of v.links) if (is(l.host)) v.unlink(l.id);
        for (const x of [...v.watchers, ...v.visitors]) if (is(x.visitor)) ends.add(x.id);
        for (const w of v._watches.values()) if (!w.link && is(w.host)) ends.add(w.id);
        for (const id of ends) v.kick(id);
        if (v.visiting && !v.visiting.link && is(v.visiting.host)) v.leave();
        opened.delete(k);
      }
      else if (act === "in" || act === "out") {
        const k = v.knocks.find(x => x.id === b.dataset.k);
        if (act === "in" && k && always.has(k.id) && k.from.key) v.addGuest(k.from.key, k.from.name);
        always.delete(b.dataset.k);
        v.answer(b.dataset.k, act === "in");
      }
      else if (act === "leave") v.leave();
      else if (act === "map") (v._mapView || (v._mapView = map(v))).open();
      else if (act === "perf") v.perf(!v._perf);
      else if (act === "ride") v.ride(v.riding ? null : mountChosen());
      else if (act === "mic") v.setMic(!v.mic).catch(x => v._emit("error", { code: "mic", message: String(x.message || x) }));
      else if (act === "call") { try { v.call(b.dataset.key); } catch (x) { note(String(x.message || x)); } }
      else if (act === "pick_up") v.pickUp(b.dataset.key).catch(x => v._emit("error", { code: "mic", message: String(x.message || x) }));
      else if (act === "hang_up") v.hangUp(b.dataset.key);
      else if (act === "speaker") v.speaker(b.dataset.key, !(v.calls.find(c => c.key === b.dataset.key) || {}).speaker);
      else if (act === "look") v.useAvatar(b.dataset.key, b.dataset.use === v.avatars.default ? null : b.dataset.use);
      else if (act === "unlink") v.unlink(b.dataset.x);
      else if (act === "step_in") v.stepIn(b.dataset.x);
      else if (act === "step_out") v.stepOut(b.dataset.x);
      else if (act === "to_world") v.toWorld(b.dataset.x);
      else if (act === "show") v._toCorner(v._link(b.dataset.x)), v._changed();
      else if (act === "kick") v.kick(b.dataset.x);
      else if (act === "ban") { const k = b.dataset.key, now = v.banOf(k) || { voice: false, chat: false }; v.ban(k, { ...now, [b.dataset.what]: !now[b.dataset.what] }); }
      else if (act === "voice_kick") v.voiceKick(b.dataset.key);
      else if (act === "voice_leave") v.joinVoice(null);
      else if (act === "away") v.leaveLobby();
      else if (act === "back") v.joinLobby();
      else if (act === "guest") v.isGuest(b.dataset.key) ? v.removeGuest(b.dataset.key) : v.addGuest(b.dataset.key, b.dataset.name);
    });
    root.addEventListener("change", e => {
      if (e.target.dataset.v === "always") { if (e.target.checked) always.add(e.target.dataset.k); else always.delete(e.target.dataset.k); }
      if (e.target.dataset.v === "status") v.setStatus(e.target.value);
      if (e.target.dataset.v === "max") v.setMaxVisitors(Number(e.target.value));
      if (e.target.dataset.v === "door") v.setDoor(e.target.value === "open");
      if (e.target.dataset.v === "looks") v.useAvatars(e.target.value);
      if (e.target.dataset.v === "mount") { if (v.riding) v.ride(e.target.value); else { v.mount = e.target.value; try { localStorage.setItem("visit:mount", v.mount); } catch (x) { /* not kept */ } } }
    });
    root.addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target.closest("form");
      const o = v.offices.find(x => x.id === f.dataset.o);
      (o && o.links ? v.link : v.knock).call(v, f.dataset.o, f.querySelector("input").value.trim());
      composing = null;
      f.querySelector("input").blur();
      draw();
    });
    root.addEventListener("focusout", () => setTimeout(draw, 0));
    v.on("change", draw);
    timer = setInterval(() => { if (v.knocks.length) draw(); }, 1000);   // the knocks' countdown
    const speaking = setInterval(() => { if (v.mic || v.voices.length || v._calls.size) draw(); }, 250);   // who is near, and speaking
    draw();
    return { element: root, chat: cw,
      release() { clearInterval(timer); clearInterval(speaking); v.off("change", draw); v.off("seen", onSeen); v.off("call", onCall); v.off("model", onModel); v.off("body", onBody); for (const t of seenWait.values()) clearTimeout(t); if (cw) cw.release(); removeEventListener("keydown", mountKey); root.remove(); },
      say() { if (cw) cw.open(); } };   // the chat window, open to type a line (as Enter does)
  }

  // ---------- the chat window (8.9): bottom left, as in a game ----------
  // Enter to type a line, Enter to say it, Esc to stop; / opens it with the / typed, for a command. Where a line goes
  // is before the box: Say (everyone who can see you), Tell <name> (a whisper: them alone, wherever they are), To
  // your room / To <name>'s room (a room's chat: everyone in it, and linked with it), Lobby (everyone in it). Pick it
  // there, or start the line with /s, /w <name> (/t, /tell), /r (back to whoever last whispered to you, else whom
  // you last whispered), /room (yours) or /room <name>, /1 (/l) and a space; it stays for the next line. Tab
  // finishes a name, from those it could be, shown over the box; else it moves the box on to the next place (Shift:
  // back), in the choices' order: only where a line can go now, and one Tell, to whoever you last whispered with
  // (0.22.0); not while a command is in the box (that says where). 🎧 by the box (or /voice)
  // joins the voice of the room the box talks to (else your own room's), or leaves it: while you are in one, a line
  // over the box says whose and who is in it (🔊: speaking), and stays. The rest fades `fade` ms after the last line,
  // and comes back with the next one, or Enter.
  // `element`: where it goes (the page). Its place: --visit-chat-left, --visit-chat-bottom.
  // The colour of someone's name in chat, as WoW colours a name by its class: one of these, by their key (else
  // their name), so the same on every page. None is a scope's (a whisper's pink, a room's blue).
  const NAME_COLORS = ["#ff6b6b", "#ff9f43", "#d4a373", "#ffd93d", "#a3e048", "#2ee6a6", "#3dd5f3"];
  const nameColor = key => {
    let h = 2166136261;
    for (const c of String(key)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
    return NAME_COLORS[(h >>> 0) % NAME_COLORS.length];
  };
  const CHAT_CSS = `
.visit-chat { position: fixed; left: var(--visit-chat-left, 16px); bottom: var(--visit-chat-bottom, 16px); z-index: 19; width: min(660px, calc(100vw - 32px)); font: 19.5px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; transition: opacity .8s; }
.visit-chat.idle { pointer-events: none; }
.visit-chat > * { transition: opacity .8s; }
.visit-chat.idle > :not(.voice):not(.mail) { opacity: 0; }
.visit-chat .voice { margin-top: 4px; padding: 2px 8px; width: fit-content; max-width: 100%; font-size: 85%; color: #7ee787; background: rgba(0,0,0,.45); border-radius: 6px; pointer-events: auto; }
.visit-chat .voice:empty { display: none; }
.visit-chat .voice .muted { color: #c9d1d9; opacity: .8; }
.visit-chat .voice button { font: inherit; color: #c9d1d9; background: none; border: 1px solid #6e7681; border-radius: 4px; padding: 0 5px; margin-left: 4px; cursor: pointer; }
.visit-chat .line img.pic { display: block; max-width: min(240px, 60vw); max-height: 180px; min-width: 40px; min-height: 30px; margin: 4px 0 2px; border-radius: 6px; cursor: zoom-in; background: rgba(255,255,255,.08); }
.visit-chat .card { display: flex; gap: 8px; align-items: flex-start; max-width: 440px; margin: 4px 0 2px; padding: 6px 8px; color: inherit; text-decoration: none; text-shadow: none; background: rgba(22,27,34,.88); border-left: 3px solid #aaaaff; border-radius: 6px; }
.visit-chat .card img { width: 64px; height: 64px; flex: none; object-fit: cover; border-radius: 4px; }
.visit-chat .card .site { font-size: 70%; opacity: .7; }
.visit-chat .card .title { font-size: 85%; font-weight: 600; }
.visit-chat .card .desc { font-size: 75%; opacity: .85; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.visit-chat .attach { display: none; flex-wrap: wrap; gap: 8px; align-items: flex-start; margin-top: 6px; }
.visit-chat.typing .attach:not(:empty) { display: flex; }
.visit-chat .chip { position: relative; }
.visit-chat .chip > img { display: block; width: 56px; height: 56px; object-fit: cover; border-radius: 4px; }
.visit-chat .chip.busy > img { opacity: .45; }
.visit-chat .chip .card { margin: 0; max-width: 360px; }
.visit-chat .chip button.drop { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; padding: 0; font: 11px/16px system-ui; color: #fff; background: #30363d; border: 1px solid #6e7681; border-radius: 50%; cursor: pointer; }
.visit-chat .shared { display: none; max-height: 16em; overflow-y: auto; margin-bottom: 4px; padding: 6px 8px; font-size: 80%; background: rgba(13,17,23,.94); border: 1px solid #30363d; border-radius: 6px; }
.visit-chat .shared.on { display: block; }
.visit-chat .shared .tabs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px; }
.visit-chat .shared .tabs b { flex: 1; font-weight: 600; }
.visit-chat .shared button { font: inherit; color: #c9d1d9; background: none; border: 1px solid #30363d; border-radius: 4px; padding: 0 6px; cursor: pointer; }
.visit-chat .shared .tabs button.on { color: #fff; border-color: #aaaaff; }
.visit-chat .shared .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 4px; margin-bottom: 4px; }
.visit-chat .shared .grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; cursor: zoom-in; }
.visit-chat button.gallery { font: inherit; background: none; border: 0; padding: 0 2px; cursor: pointer; opacity: .8; }
.visit-lightbox { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.85); cursor: zoom-out; }
.visit-lightbox img { max-width: 95vw; max-height: 95vh; border-radius: 4px; }
.visit-chat button.headset { font: inherit; background: none; border: 0; padding: 0 2px; cursor: pointer; opacity: .55; }
.visit-chat button.headset.on { opacity: 1; text-shadow: 0 0 6px #7ee787; }
.visit-chat .log { max-height: 11em; overflow-y: auto; padding: 4px 8px; border-radius: 6px; text-shadow: 0 1px 2px #000, 0 0 4px #000; scrollbar-width: none; overflow-wrap: anywhere; }
.visit-chat .log:empty { display: none; }
.visit-chat:hover .log, .visit-chat.typing .log { background: rgba(0,0,0,.4); }
.visit-chat .line { padding-left: 1.25em; text-indent: -1.25em; }
.visit-chat .line + .line { margin-top: 3px; }
.visit-chat .line > img, .visit-chat .line > .card { text-indent: 0; }
.visit-chat .line.whisper, .visit-chat[data-scope=whisper] form { color: #ff80ff; }
.visit-chat .line.sim, .visit-chat[data-scope=sim] form { color: #aaaaff; }
.visit-chat .line.lobby, .visit-chat[data-scope=lobby] form { color: #ffc864; }
.visit-chat .line.note { color: #ffff00; }
.visit-chat .line[data-time]::before { content: attr(data-time); margin-right: .45em; font-size: 78%; opacity: .6; font-variant-numeric: tabular-nums; }
.visit-chat .day { display: flex; align-items: center; gap: 8px; margin: 6px 0 3px; font-size: 72%; opacity: .7; }
.visit-chat .day::before, .visit-chat .day::after { content: ""; flex: 1; border-top: 1px solid rgba(255,255,255,.35); }
.visit-chat .names { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; padding: 0 8px; font-size: 85%; }
.visit-chat .names:empty { display: none; }
.visit-chat .names button { font: inherit; color: #c9d1d9; background: rgba(22,27,34,.92); border: 1px solid #30363d; border-radius: 4px; padding: 0 6px; cursor: pointer; }
.visit-chat .names button.on { color: #fff; background: #1f2a44; border-color: #aaaaff; }
.visit-chat .line.mention { background: rgba(255,200,100,.16); border-left: 3px solid #ffc864; padding-left: calc(1.25em + 5px); border-radius: 3px; }
.visit-chat form { display: none; align-items: center; gap: 4px; margin-top: 4px; padding: 3px 6px; background: rgba(0,0,0,.7); border: 1px solid #6e7681; border-radius: 6px; }
.visit-chat.typing form { display: flex; }
.visit-chat select { font: inherit; color: inherit; background: none; border: 0; padding: 0; max-width: 45%; cursor: pointer; }
.visit-chat option { color: #e6edf3; background: #161b22; }
.visit-chat input { flex: 1; min-width: 0; font: inherit; color: inherit; background: none; border: 0; outline: none; }
.visit-chat button.sound { font: inherit; color: inherit; background: none; border: 0; padding: 0 2px; cursor: pointer; opacity: .8; }
.visit-chat button.mail { display: none; margin-top: 4px; padding: 1px 8px; font: inherit; font-size: 85%; color: #ffc864; background: rgba(0,0,0,.55); border: 1px solid #ffc864; border-radius: 6px; cursor: pointer; pointer-events: auto; }
.visit-chat button.mail.on { display: inline-block; }
.visit-chat .mailbox { display: none; max-height: 16em; overflow-y: auto; margin-bottom: 4px; padding: 6px 8px; font-size: 80%; background: rgba(13,17,23,.94); border: 1px solid #30363d; border-radius: 6px; }
.visit-chat .mailbox.on { display: block; }
.visit-chat .mailbox .tabs { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.visit-chat .mailbox .tabs b { flex: 1; font-weight: 600; }
.visit-chat .mailbox button { font: inherit; color: #c9d1d9; background: none; border: 1px solid #30363d; border-radius: 4px; padding: 0 6px; cursor: pointer; }
.visit-chat .mailbox .line { cursor: pointer; border-radius: 3px; }
.visit-chat .mailbox .line:hover { background: rgba(255,255,255,.08); }
.visit-chat .mailbox .when { opacity: .6; font-size: 85%; }
.visit-chat .mailbox .held { display: flex; gap: 6px; align-items: baseline; color: #ff80ff; }
.visit-chat .mailbox .held span { flex: 1; }
.visit-chat .line.held { opacity: .75; font-style: italic; }
.visit-chat button.play { font: inherit; font-size: 90%; color: inherit; background: rgba(255,255,255,.08); border: 1px solid currentColor; border-radius: 12px; padding: 0 8px; margin: 2px 0 0 4px; text-indent: 0; cursor: pointer; }
.visit-chat button.rec { font: inherit; color: inherit; background: none; border: 0; padding: 0 2px; cursor: pointer; opacity: .8; }
.visit-chat button.rec.on { opacity: 1; color: #ff6b6b; }
.visit-chat .chip .clip { display: block; padding: 4px 8px; border: 1px solid #6e7681; border-radius: 12px; }
.visit-chat .chip.busy > .clip { opacity: .45; }`;

  // A picture full size, over everything, until a click or Esc.
  function lightbox(url) {
    const d = document.createElement("div"), img = document.createElement("img");
    d.className = "visit-lightbox"; img.src = url; d.appendChild(img);
    const shut = () => { d.remove(); removeEventListener("keydown", esc, true); };
    const esc = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); shut(); } };
    d.addEventListener("click", shut);
    addEventListener("keydown", esc, true);
    document.body.appendChild(d);
  }

  // A soft sound for a line that comes (not your own): a whisper rises, a lobby line is lower, the rest one note. Made
  // with Web Audio (a page's sound waits for a key or a click: browsers allow none before).
  let chatAudio = null;
  function chatSound(scope) {
    try {
      const ctx = chatAudio || (chatAudio = new (window.AudioContext || window.webkitAudioContext)());
      if (ctx.state === "suspended") ctx.resume();
      const notes = scope === "whisper" ? [660, 880] : scope === "lobby" ? [392] : [523];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), at = ctx.currentTime + i * 0.09;
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.08, at + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
        o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + 0.25);
      });
    } catch (e) { /* no sound here */ }
  }

  function chat(v, { element = document.body, fade = CHAT_FADE, sound = true } = {}) {
    v._as("user", "chat");
    if (!document.getElementById("visit-chat-css")) {
      const st = document.createElement("style"); st.id = "visit-chat-css"; st.textContent = CHAT_CSS; document.head.appendChild(st);
    }
    const root = document.createElement("div");
    root.className = "visit-chat";
    root.dataset.scope = "say";
    root.innerHTML = `<div class="shared"></div><div class="mailbox"></div><div class="log" aria-live="polite"></div><div class="names"></div><div class="voice"></div><button type="button" class="mail"></button><div class="attach"></div><form><select title="where your line goes"></select><input maxlength="${CHAT_LEN}" autocomplete="off" spellcheck="false"><button type="button" class="rec" title="a voice message (click again: done; at most a minute)">🎙</button><button type="button" class="gallery" title="pictures, voice messages and links shared here">🖼</button><button type="button" class="headset">🎧</button><button type="button" class="sound"></button></form>`;
    element.appendChild(root);
    const shared = root.querySelector(".shared"), attach = root.querySelector(".attach"), gallery = root.querySelector("button.gallery");
    const mailbox = root.querySelector(".mailbox"), mail = root.querySelector("button.mail");
    const log = root.querySelector(".log"), names = root.querySelector(".names"), voice = root.querySelector(".voice"), headset = root.querySelector("button.headset"), form = root.querySelector("form"), pick = form.querySelector("select"), input = form.querySelector("input"), bell = form.querySelector("button.sound"), recBtn = form.querySelector("button.rec");
    // A sound with each line that comes, unless this browser was told not to (the 🔔 by the box).
    let quiet = !sound;
    try { if (localStorage.getItem("visit:chat-quiet") === "1") quiet = true; } catch (e) { /* not kept */ }
    const bellSay = () => { bell.textContent = quiet ? "🔕" : "🔔"; bell.title = quiet ? "no sound with a line (click: a sound)" : "a sound with each line (click: none)"; };
    bellSay();
    bell.addEventListener("click", () => { quiet = !quiet; try { localStorage.setItem("visit:chat-quiet", quiet ? "1" : "0"); } catch (e) { /* not kept */ } bellSay(); input.focus(); });
    let to = { scope: "say" }, choices = [], typing = false, last = null, told = null, tell = null, fadeTimer = null, intro = null;
    try {   // where lines went before a reload (this tab)
      const t = JSON.parse(sessionStorage.getItem("visit:chat-to") || "null");
      if (isObj(t) && ["say", "whisper", "sim", "lobby"].includes(t.scope)) to = { scope: t.scope, ...["key", "id", "name"].reduce((o, k) => (typeof t[k] === "string" ? { ...o, [k]: t[k] } : o), {}) };
    } catch (e) { /* not kept */ }
    const yours = () => ({ scope: "sim", key: v.key || "", name: v.office ? v.office.name : "" });   // your room's chat
    const room = t => t.key === v.key ? "your room" : `${t.name || "a"}'s room`;
    const whom = t => v.whisperTargets.find(o => (t.key && o.key === t.key) || o.id === t.id);   // a whisper's person, now
    const label = t => t.scope === "lobby" ? "Lobby" : t.scope === "whisper" ? `Tell ${t.name}${whom(t) ? "" : " (away)"}` : t.scope === "sim" ? `To ${room(t)}` : "Say";
    const same = (a, b) => a.scope === b.scope && (a.key || a.id || null) === (b.key || b.id || null);
    // A line's text, in parts: a name ({ name, key }), in its own colour, among the rest.
    const parts = l => {
      const who = { name: `[${l.name || "someone"}]`, key: l.key || l.name };
      if (l.scope === "note") return [l.text];
      if (l.scope === "lobby") return ["[Lobby] ", who, `: ${l.text}`];
      if (l.scope === "whisper") { const t = l.to || {}; return l.mine ? ["To ", { name: `[${t.name || ""}]`, key: t.key || t.name }, `: ${l.text}`] : [who, ` whispers: ${l.text}`]; }
      if (l.scope === "sim") { const r = room(l.to || {}); return [`[${r[0].toUpperCase() + r.slice(1)}] `, who, `: ${l.text}`]; }
      return [who, ` says: ${l.text}`];
    };
    const wake = () => {
      root.classList.remove("idle");
      clearTimeout(fadeTimer);
      if (fade > 0) fadeTimer = setTimeout(function sleep() { if (typing || root.matches(":hover") || shared.classList.contains("on") || mailbox.classList.contains("on")) fadeTimer = setTimeout(sleep, 1000); else root.classList.add("idle"); }, fade);
    };
    // A picture by its id, shown once the visit-client has it (a click: full size); a link, as its sender's
    // preview has it (a click: the link, in a new tab).
    const picture = (id, cls, big = true) => {
      const img = document.createElement("img");
      if (cls) img.className = cls;
      img.alt = "a picture";
      v.media(id).then(url => {
        if (!url) { img.alt = "(a picture that cannot be had)"; return; }
        const end = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
        img.addEventListener("load", () => { if (end && log.contains(img)) log.scrollTop = log.scrollHeight; }, { once: true });
        img.src = url;
      });
      if (big) img.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (img.src) lightbox(img.src); });
      return img;
    };
    const card = l => {
      const a = document.createElement("a");
      a.className = "card";
      if (/^https?:\/\//.test(l.url)) { a.href = l.url; a.target = "_blank"; a.rel = "noopener noreferrer"; }
      if (l.image && l.image.id) a.appendChild(picture(l.image.id, "", false));
      const t = document.createElement("div");
      for (const [cls, text] of [["site", l.site], ["title", l.title || l.url], ["desc", l.description]]) if (text) { const x = document.createElement("div"); x.className = cls; x.textContent = text; t.appendChild(x); }
      a.appendChild(t);
      return a;
    };
    // A voice message: ▶ and how long it is; a click plays it (again: stops it).
    const clock = secs => { const n = Math.round(secs || 0); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; };
    const voiceEl = p => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "play"; b.title = "a voice message";
      const idle = () => { b.textContent = p.secs ? `▶ ${clock(p.secs)}` : "▶"; };
      idle();
      let audio = null;
      b.addEventListener("click", async e => {
        e.preventDefault(); e.stopPropagation();
        if (audio && !audio.paused) { audio.pause(); audio.currentTime = 0; return idle(); }
        if (!audio) {
          const url = await v.media(p.id);
          if (!url) { b.textContent = "(a voice message that cannot be had)"; b.disabled = true; return; }
          audio = new Audio(url);
          audio.addEventListener("ended", idle);
          audio.addEventListener("timeupdate", () => { if (!audio.paused) b.textContent = `■ ${clock(audio.currentTime)}${p.secs ? " / " + clock(p.secs) : ""}`; });
        }
        audio.play().catch(() => idle());
        b.textContent = "■";
      });
      return b;
    };
    // When a line came, as WoW's chat timestamps have it: its time (this browser's clock and way of writing one), dim,
    // before it; and over a day's first line, its day, when the log holds more than today.
    const hhmm = at => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const dayOf = at => new Date(at).toDateString();
    const dayName = at => { const d = new Date(at); return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }); };
    const days = () => {   // the log's days: one over each line whose day is not the one before it's (today, for the first)
      let prev = dayOf(Date.now());
      for (const d of log.querySelectorAll(".line[data-at]")) {
        const at = Number(d.dataset.at), k = dayOf(at), was = d.previousElementSibling, has = was && was.classList.contains("day") ? was : null;
        if (k === prev) { if (has) has.remove(); continue; }
        prev = k;
        if (has) { if (has.textContent !== dayName(at)) has.textContent = dayName(at); continue; }
        const x = document.createElement("div");
        x.className = "day"; x.textContent = dayName(at);
        d.before(x);
      }
    };
    const lineEl = l => {   // a line: its text, then its pictures (or voice message) and its links' previews
      const d = document.createElement("div");
      d.className = "line " + l.scope + (l.mention ? " mention" : "") + (l.held ? " held" : "");
      if (l.held) d.title = "kept by your visit-client: it goes once they and you are both in the lobby";
      for (const p of parts(l)) {
        if (typeof p === "string") { d.appendChild(document.createTextNode(p)); continue; }
        const n = document.createElement("span");
        n.className = "who"; n.textContent = p.name; n.style.color = nameColor(p.key || "");
        d.appendChild(n);
      }
      if (l.at) { d.dataset.at = String(l.at); d.dataset.time = hhmm(l.at); }
      for (const p of l.media || []) d.appendChild(isVoice(p) ? voiceEl(p) : picture(p.id, "pic"));
      for (const c of l.links || []) d.appendChild(card(c));
      return d;
    };
    // A line from before this page, among the others from before it (above the window's first note), where its time
    // puts it: one can come after newer ones (a line kept for you, one from another day), and the days over the log
    // follow the lines' order. Over the day of the line it goes before, if that one has its day over it.
    const placeOld = d => {
      const at = Number(d.dataset.at), stop = intro && intro.parentNode === log ? intro : null;
      if (Number.isFinite(at)) for (let x = log.firstElementChild; x && x !== stop; x = x.nextElementSibling) {
        if (!x.classList.contains("line") || !(Number(x.dataset.at) > at)) continue;
        const m = x.previousElementSibling;
        return log.insertBefore(d, m && m.classList.contains("day") ? m : x);
      }
      return stop ? log.insertBefore(d, stop) : log.appendChild(d);
    };
    const add = l => {   // a line at the end; one from before this page (`old`), where its time puts it among those (placeOld)
      const end = log.scrollTop + log.clientHeight >= log.scrollHeight - 4, d = lineEl(l);
      if (l.old) placeOld(d); else log.appendChild(d);
      while (log.childElementCount > CHAT_LOG * 4) { log.firstChild.remove(); older = true; }
      days();
      if (end) log.scrollTop = log.scrollHeight;
      wake();
      return d;
    };
    // The chat's history (8.12), up the log: older lines, from the visit-client's database, as the log scrolls to
    // its top.
    let older = true, loadingOlder = false;
    log.addEventListener("scroll", () => {
      if (log.scrollTop > 24 || loadingOlder || !older) return;
      const first = log.querySelector(".line[data-at]"), before = first ? Number(first.dataset.at) : Date.now(), h = log.scrollHeight;
      loadingOlder = true;
      v.history({ before, limit: 40 }).then(r => {
        older = r.more;
        const top = log.firstChild;
        for (const l of r.lines) log.insertBefore(lineEl(l), top);
        days();
        log.scrollTop += log.scrollHeight - h;
      }, () => { older = false; }).finally(() => { loadingOlder = false; });
    });
    const note = text => add({ scope: "note", text });
    const fill = () => {   // the choices before the box: Say, a whisper to each, your room (anyone linked), each linked room, the lobby
      const linked = v.chatTargets;
      choices = [{ scope: "say" }, ...v.whisperTargets.map(o => ({ scope: "whisper", id: o.id, key: o.key, name: o.name })),
        ...(linked.length ? [yours()] : []), ...linked.map(o => ({ scope: "sim", key: o.key, name: o.name })), ...(v.lobbyChat ? [{ scope: "lobby" }] : [])];
      if (!choices.some(c => same(c, to))) choices.splice(1, 0, to);   // (gone, or no lobby chat: said so if used)
      pick.innerHTML = choices.map((c, i) => `<option value="${i}">${esc(label(c))}:</option>`).join("");
      pick.value = String(choices.findIndex(c => same(c, to)));
      root.dataset.scope = to.scope;
      if (to.scope === "whisper") tell = to;
      headsetSay();
      try { sessionStorage.setItem("visit:chat-to", JSON.stringify(to)); } catch (e) { /* not kept */ }
    };
    // Tab: the box on to the next place a line can go now (back: the one before), in the choices' order, with one Tell:
    // whoever you last whispered with (the box's, else either way), else none. From a place gone: on from its kind's.
    const KINDS = ["say", "whisper", "sim", "lobby"];
    const step = back => {
      const p = [to.scope === "whisper" && to, tell, last, told].map(t => t && whom(t)).find(Boolean), linked = v.chatTargets;
      const stops = [{ scope: "say" }, ...(p && v.lobbyChat ? [{ scope: "whisper", id: p.id, key: p.key, name: p.name }] : []),
        ...(linked.length ? [yours()] : []), ...linked.map(o => ({ scope: "sim", key: o.key, name: o.name })), ...(v.lobbyChat ? [{ scope: "lobby" }] : [])];
      const n = stops.length, i = stops.findIndex(c => same(c, to)), k = KINDS.indexOf(to.scope);
      let j = i >= 0 ? (i + (back ? n - 1 : 1)) % n : -1;
      if (i < 0) for (let x = 0; x < n; x++) if (back ? KINDS.indexOf(stops[x].scope) < k : KINDS.indexOf(stops[x].scope) > k) { j = x; if (!back) break; }
      to = stops[j >= 0 ? j : back ? n - 1 : 0];
      fill();
    };
    const open = (start = "") => {
      if (document.pointerLockElement) document.exitPointerLock();
      typing = true; root.classList.add("typing"); fill(); wake();
      input.value = start; input.focus();
    };
    const close = () => { recStop(false); typing = false; root.classList.remove("typing"); input.value = ""; picker = null; picked = null; drawPicker(); pending = []; linkCard = null; linkSkip.clear(); drawAttach(); if (root.contains(document.activeElement)) document.activeElement.blur(); wake(); };
    // The one of `list` whose name starts `rest`, then a space (the longest), or, on Enter (`done`), is all of it or
    // the one name it starts.
    const named = (list, rest, done) => {
      const low = rest.toLowerCase(), all = done && low.trim();
      const o = list.filter(o => o.name && ((all && all === o.name.toLowerCase()) || low.startsWith(o.name.toLowerCase() + " "))).sort((a, b) => b.name.length - a.name.length)[0];
      if (o || !all) return o;
      const start = list.filter(o => o.name && o.name.toLowerCase().startsWith(all));
      return start.length === 1 ? start[0] : undefined;
    };
    // A name being typed after /w (/t, /tell, /whisper) or /room (/sim): the command, and the names it could be.
    const naming = () => {
      const m = /^\/(w|t|whisper|tell|room|sim)\s([\s\S]*)$/i.exec(input.value);
      if (!m) return null;
      const stem = m[2].toLowerCase(), rooms = /^(room|sim)$/i.test(m[1]);
      return { cmd: m[1], stem, names: (rooms ? v.chatTargets : [...v.whisperTargets, ...v.awayTargets]).map(o => o.name).filter(n => n && n.toLowerCase().startsWith(stem)) };
    };
    // Whom a line may mention (@): those linked with you, your visitors, those in the lobby; by the names they go by.
    const people = () => {
      const by = new Map(), put = (key, name) => { if (key && key !== v.key && name && !by.has(key)) by.set(key, v.userOf(key) || name); };
      for (const o of v.chatTargets) put(o.key, o.name);
      for (const x of v.visitors) put(x.visitor.key, x.visitor.name);
      for (const o of v.offices) if (!v.office || o.id !== v.office.id) put(o.key, o.name);
      return [...new Set(by.values())].sort((a, b) => a.localeCompare(b));
    };
    // The names the box could take where it is typed (over it, to pick: up and down, Tab or Enter, or a click): after
    // /w or /room, the name it is to; after @, someone the line mentions. Picked, it stays shut until the box changes.
    let picker = null, picked = null;
    const pickerFor = () => {
      if (input.value === picked) return null;
      const n = naming();
      if (n) return n.names.length ? { items: n.names.slice(0, 8), take: name => { input.value = `/${n.cmd} ${name}`; } } : null;
      const caret = input.selectionStart == null ? input.value.length : input.selectionStart, m = /(^|\s)@([^@\n]{0,24})$/.exec(input.value.slice(0, caret));
      if (!m) return null;
      const items = people().filter(p => p.toLowerCase().startsWith(m[2].toLowerCase())).slice(0, 8);
      return items.length ? { items, take: name => {
        const from = caret - m[2].length, at = from + name.length + 1;
        input.value = input.value.slice(0, from) + name + " " + input.value.slice(caret);
        input.setSelectionRange(at, at);
      } } : null;
    };
    const drawPicker = () => { names.innerHTML = picker ? picker.items.map((n, i) => `<button type="button" data-i="${i}" class="${i === picker.at ? "on" : ""}">${esc(n)}</button>`).join("") : ""; };
    const hint = () => {
      const p = pickerFor(), same = p && picker && p.items.join("\n") === picker.items.join("\n");
      picker = p ? Object.assign(p, { at: same ? picker.at : 0 }) : null;
      drawPicker();
    };
    const take = i => {
      if (!picker || !picker.items[i]) return;
      picker.take(picker.items[i]);
      picked = input.value; picker = null;
      drawPicker();
    };
    names.addEventListener("mousedown", e => { const b = e.target.closest("button[data-i]"); if (b) { e.preventDefault(); take(Number(b.dataset.i)); input.focus(); } });
    const help = "/s say (everyone who can see you) · /w name (a whisper) · /r reply · /room (your room's chat) · /room name (a linked room's) · /1 the lobby · /voice (🎧) · @ a name: mention them";
    // Pictures for the next line (pasted, or dropped on the window: each kept by the visit-client at once, `media`
    // once kept), and a link's preview (made as the link is typed; ✕: none for it).
    let pending = [], linkCard = null, linkTimer = null;
    const linkSkip = new Set();
    const chip = (inside, drop) => {
      const c = document.createElement("div");
      c.className = "chip";
      c.appendChild(inside);
      const x = document.createElement("button");
      x.type = "button"; x.className = "drop"; x.textContent = "✕"; x.title = "not this";
      x.addEventListener("click", () => { drop(); drawAttach(); input.focus(); });
      c.appendChild(x);
      return c;
    };
    const drawAttach = () => {
      attach.textContent = "";
      for (const p of pending) {
        const el = document.createElement(p.voice ? "span" : "img");
        if (p.voice) { el.className = "clip"; el.textContent = `🎙 ${clock(p.secs)}`; } else el.src = p.url;
        const c = chip(el, () => { pending = pending.filter(q => q !== p); });
        if (!p.media) c.classList.add("busy");
        attach.appendChild(c);
      }
      if (linkCard && !linkCard.loading) attach.appendChild(chip(card(linkCard), () => { linkSkip.add(linkCard.url); linkCard = null; }));
    };
    const addPictures = files => {
      if (!typing) open();
      for (const f of files) {
        if (pending.length >= 4) { note("At most 4 pictures in a line"); break; }
        const p = { url: URL.createObjectURL(f), media: null };
        p.ready = v.share(f).then(m => { p.media = m; drawAttach(); return m; },
          e => { pending = pending.filter(q => q !== p); drawAttach(); note(`That picture cannot be shared: ${e.message || e}`); return null; });
        pending.push(p);
      }
      drawAttach();
    };
    input.addEventListener("paste", e => {
      const files = [...((e.clipboardData && e.clipboardData.items) || [])].filter(i => i.kind === "file" && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
      if (!files.length) return;
      if (!(e.clipboardData.getData("text/plain") || "").trim()) e.preventDefault();
      addPictures(files);
    });
    root.addEventListener("dragover", e => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
    root.addEventListener("drop", e => {
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter(f => /^image\//.test(f.type));
      if (files.length) { e.preventDefault(); addPictures(files); }
    });
    const linkLook = () => {   // the first link in the box: its preview, made by the visit-client
      const m = /https?:\/\/[^\s<>"']+/.exec(input.value), url = m ? m[0].replace(/[.,;:!?)\]]+$/, "") : null;
      if (!url || linkSkip.has(url)) { if (linkCard) { linkCard = null; drawAttach(); } return; }
      if (linkCard && linkCard.url === url) return;
      linkCard = { url, loading: true };
      drawAttach();
      v.preview(url).then(p => {
        if (!linkCard || linkCard.url !== url) return;
        linkCard = p ? { ...p, url } : null;
        if (!p) linkSkip.add(url);
        drawAttach();
      }, () => { if (linkCard && linkCard.url === url) { linkCard = null; drawAttach(); } });
    };
    // What was shared (🖼): the pictures, or the links, in the conversation the box talks to, newest first.
    let sharedKind = "media";
    const conversation = () => to.scope === "sim" ? "room:" + to.key : to.scope === "whisper" ? "person:" + (to.key || "id:" + to.id) : to.scope === "lobby" ? "lobby" : v._conversationHere();
    const sharedDraw = async more => {
      const c = conversation(), title = c === "lobby" ? "the lobby" : c.startsWith("person:") ? `you and ${to.name || "them"}`
        : c === "room:" + v.key ? "your room" : `${v._nameOf(c.slice(5)) || "their"}'s room`;
      if (!more) shared.innerHTML = `<div class="tabs"><b>Shared in ${esc(title)}</b><button data-k="media" class="${sharedKind === "media" ? "on" : ""}">Pictures</button><button data-k="voice" class="${sharedKind === "voice" ? "on" : ""}">Voice</button><button data-k="links" class="${sharedKind === "links" ? "on" : ""}">Links</button><button data-k="close" title="close">✕</button></div><div class="items"></div>`;
      const items = shared.querySelector(".items");
      const moreButton = items.querySelector("button.more");
      if (moreButton) moreButton.remove();
      try {
        const r = await v.shared(c, sharedKind, { before: more ? Number(items.dataset.before) : undefined });
        let box = items.querySelector(".grid");
        if (sharedKind === "media" && !box && r.items.length) { box = document.createElement("div"); box.className = "grid"; items.appendChild(box); }
        const voiceRow = i => { const d = document.createElement("div"); d.textContent = `${i.mine ? "you" : i.name || "someone"}: `; d.appendChild(voiceEl({ id: i.id, secs: 0 })); return d; };
        for (const i of r.items) (sharedKind === "media" ? box : items).appendChild(sharedKind === "media" ? picture(i.id, "") : sharedKind === "voice" ? voiceRow(i) : card(linksFrom([i])[0] || { url: i.url }));
        if (!r.items.length && !more) items.textContent = sharedKind === "media" ? "No pictures shared here yet" : sharedKind === "voice" ? "No voice messages here yet" : "No links shared here yet";
        if (r.items.length) items.dataset.before = String(r.items[r.items.length - 1].at);
        if (r.more) { const b = document.createElement("button"); b.className = "more"; b.textContent = "More"; b.dataset.k = "more"; items.appendChild(b); }
      } catch (e) { items.textContent = `Not available: ${e.message || e}`; }
    };
    gallery.addEventListener("click", () => { shared.classList.toggle("on"); if (shared.classList.contains("on")) sharedDraw(false); wake(); input.focus(); });
    shared.addEventListener("click", e => {
      const b = e.target.closest("button[data-k]");
      if (!b) return;
      if (b.dataset.k === "close") shared.classList.remove("on");
      else if (b.dataset.k === "more") sharedDraw(true);
      else { sharedKind = b.dataset.k; sharedDraw(false); }
    });
    // The room voice 🎧 joins: of the room the box talks to, else your own room's.
    const voiceRoom = () => to.scope === "sim" && to.key ? { key: to.key, name: room(to) } : { key: v.key, name: "your room" };
    const headsetSay = () => {
      const r = voiceRoom(), on = !!v.roomVoice && v.roomVoice.key === r.key;
      headset.classList.toggle("on", on);
      headset.title = on ? `in ${r.name}'s voice (click: leave it)` : `join ${r.name}'s voice: everyone in it hears everyone else, wherever they are`;
    };
    const voiceToggle = () => {
      const r = voiceRoom();
      if (v.roomVoice && v.roomVoice.key === r.key) return void v.joinVoice(null);
      if (!v.joinVoice(r.key)) note(v.bannedBy.some(b => b.key === r.key && b.voice) ? `${r.name[0].toUpperCase() + r.name.slice(1)} keeps you out of its voice` : `${r.name}: you are not linked with them now`);
    };
    let voiceDrawn = "", voiceIn = null;
    const voiceLine = () => {   // the room voice you are in: whose, who is in it (🔊: speaking), Leave
      const rv = v.roomVoice;
      const html = !rv ? "" : `🎧 ${esc(rv.key === v.key ? "Your room" : `${rv.name}'s room`)}: ${rv.joining ? `<span class="muted">joining…</span>`
        : rv.members.map(x => `${x.speaking ? "🔊 " : ""}${esc(x.key === v.key ? "you" : x.name)}`).join(" · ")}${v.mic ? "" : ` <span class="muted">(your microphone is off)</span>`}<button type="button" data-v="leave" title="out of this voice">Leave</button>`;
      if (html !== voiceDrawn) { voiceDrawn = html; voice.innerHTML = html; }
      headsetSay();
    };
    voice.addEventListener("click", e => { if (e.target.closest("button[data-v=leave]")) v.joinVoice(null); });
    headset.addEventListener("click", () => { voiceToggle(); input.focus(); });
    // A command at the start of the box, once a space follows it (or on Enter): where lines go from now. True: it was
    // one, and what follows it is the line.
    const command = done => {
      const m = /^\/(\S+)(?:\s([\s\S]*))?$/.exec(input.value);
      if (!m) { if (done) input.value = ""; return false; }
      if (m[2] === undefined && !done) return false;
      const cmd = m[1].toLowerCase();
      let rest = m[2] || "", next = null;
      if (cmd === "voice") { if (!done && m[2] === undefined) return false; voiceToggle(); input.value = rest; return !!rest.trim(); }
      if (cmd === "s" || cmd === "say") next = { scope: "say" };
      else if (cmd === "1" || cmd === "l" || cmd === "lobby") next = v.lobbyChat ? { scope: "lobby" } : (done && note("No lobby chat: this lobby does not carry it, or you are not in it"), null);
      else if (cmd === "r" || cmd === "reply") next = last || told || (done && note("Nobody has whispered to you yet"), null);
      else if (["w", "t", "whisper", "tell", "room", "sim"].includes(cmd)) {
        const rooms = cmd === "room" || cmd === "sim", o = named(rooms ? v.chatTargets : v.whisperTargets, rest, done) || (!rooms && named(v.awayTargets, rest, done));
        if (o) { next = rooms ? { scope: "sim", key: o.key, name: o.name } : { scope: "whisper", id: o.id, key: o.key, name: o.name }; rest = rest.slice(o.name.length + 1); }
        else if (!done) return false;   // a name still being typed
        else if (rooms && !rest.trim()) next = yours();
        else note(!rest.trim() ? `/${cmd} and a name` : rooms ? `You are not linked with anyone called ${rest.trim()}` : `Nobody called ${rest.trim()} is in the lobby (or their Visit takes no whispers)`);
      } else if (done) note(`Unknown: /${cmd}. ${help}`);
      if (next) { to = next; fill(); input.value = rest; return true; }
      if (done) input.value = "";
      return false;
    };
    input.addEventListener("input", () => { command(false); hint(); clearTimeout(linkTimer); linkTimer = setTimeout(linkLook, 500); });
    input.addEventListener("click", hint);
    input.addEventListener("keyup", e => { if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) hint(); });
    input.addEventListener("keydown", e => {
      e.stopPropagation();   // the page's own keys (walking) are not for this box
      if (e.key === "Escape" && recording) { e.preventDefault(); recStop(false); }
      else if (e.key === "Escape") { e.preventDefault(); if (picker) { picked = input.value; picker = null; drawPicker(); } else close(); }
      else if (picker && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        picker.at = (picker.at + (e.key === "ArrowDown" ? 1 : picker.items.length - 1)) % picker.items.length;
        drawPicker();
      } else if (picker && (e.key === "Tab" || e.key === "Enter") && !e.shiftKey) { e.preventDefault(); take(picker.at); }
      else if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) { e.preventDefault(); if (!input.value.startsWith("/")) step(e.shiftKey); }
    });
    pick.addEventListener("change", () => { to = choices[Number(pick.value)] || { scope: "say" }; fill(); input.focus(); });
    // A line said where the box talks to: false (and why, said) if it could not be.
    const send = (t, media, links) => {
      const p = to.scope === "whisper" && whom(to), away = to.scope === "whisper" && !p && /^[0-9a-f]{64}$/.test(to.key || "");   // (away: kept for them)
      if (v.say(t, to.scope === "say" ? undefined : to.scope === "lobby" ? "lobby" : to.scope === "whisper" ? (away ? { whisper: to.key, name: to.name } : { whisper: p ? p.id : "" })
        : to.key === v.key ? "room" : { key: to.key }, { media, links })) {
        if (away) note(`${to.name || "They"}: not in the lobby now. Your visit-client keeps it, and passes it on once you are both in it`);
        if (v.unseen.conversations.some(c => c.conversation === conversation())) v.read(conversation());   // answered: what came there, read
        return true;
      }
      if (away) note(media.length || links.length ? `${to.name} is away: a whisper kept for them is text only (pictures and voice messages go to those you are linked with)`
        : `Too fast: at most ${CHATS} lines every ${CHAT_WINDOW / 1000} s`);
      else if ((media.length || links.length) && (to.scope === "lobby" || (to.scope === "whisper" && p && !v.chatTargets.some(o => o.key === p.key)))) note("Pictures, voice messages and links go to rooms, and to those you are linked with: not through the lobby");
      else if (to.scope === "whisper" && !p) { note(`${to.name} is not in the lobby now`); to = { scope: "say" }; fill(); }
      else if (to.scope === "sim" && to.key !== v.key && !v.chatTargets.some(o => o.key === to.key)) { note(`${to.name}'s room: you are not linked with them now`); to = { scope: "say" }; fill(); }
      else if ((to.scope === "lobby" || to.scope === "whisper") && !v.lobbyChat) { note("No lobby chat: this lobby does not carry it, or you are not in it"); to = { scope: "say" }; fill(); }
      else note(`Too fast: at most ${CHATS} lines every ${CHAT_WINDOW / 1000} s`);
      return false;
    };
    form.addEventListener("submit", e => {
      e.preventDefault();
      if (recording) { recording.send = true; return recStop(true); }   // the voice message first: then the line, with it
      const cmd = input.value.startsWith("/");
      if (cmd && !command(true)) return;   // not a line (said why)
      const t = input.value.trim(), pics = pending.slice(), links = linkCard && !linkCard.loading && t.includes(linkCard.url) ? [linkCard] : [];
      if (!t && !pics.length) { if (!cmd) close(); return; }   // (a command alone: where the next line goes, the box still open)
      if (!pics.length) { if (send(t, [], links)) close(); return; }
      close();   // its pictures: said once each is kept
      Promise.all(pics.map(p => p.ready)).then(ms => { const media = ms.filter(Boolean); if (media.length || t) send(t, media, links); });
    });
    root.addEventListener("focusout", () => setTimeout(() => { if (typing && !root.contains(document.activeElement)) { typing = false; root.classList.remove("typing"); wake(); } }, 0));
    // The mailbox (8.9): 📬 and how many lines meant for you came while nobody looked (whispered, said in your room's
    // chat, mentioning you), shown even when the window has faded; ⏳, whispers you left for someone away, still kept.
    // A click: those lines (they are read then; a click on one: the box talks there) and those whispers (✕: taken
    // back).
    let mailLines = [], mailMore = 0;
    const when = at => dayOf(at) === dayOf(Date.now()) ? hhmm(at) : new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const replyTo = l => l.scope === "whisper" ? { scope: "whisper", id: l.id, key: l.key, name: l.name }
      : l.scope === "sim" ? (l.to && l.to.key && l.to.key !== v.key ? { scope: "sim", key: l.to.key, name: l.to.name } : yours()) : l.scope === "lobby" ? { scope: "lobby" } : { scope: "say" };
    const mailDraw = () => {
      mailbox.innerHTML = `<div class="tabs"><b>📬 For you</b><button type="button" data-m="close" title="close">✕</button></div>`;
      if (!mailLines.length && !v.held.length) mailbox.insertAdjacentHTML("beforeend", `<div class="when">Nothing new</div>`);
      mailLines.forEach((l, i) => {
        const d = lineEl(l);
        d.dataset.i = String(i); d.title = "click: answer there";
        if (l.at) d.dataset.time = when(l.at);   // (its day too, when not today)
        mailbox.appendChild(d);
      });
      if (mailMore > 0) mailbox.insertAdjacentHTML("beforeend", `<div class="when">and ${mailMore} more, older: up the chat</div>`);
      if (v.held.length) mailbox.insertAdjacentHTML("beforeend", `<div class="tabs" style="margin-top:6px"><b>⏳ Kept for someone away: it goes once you are both in the lobby</b></div>`
        + v.held.map(h => `<div class="held"><span>To [${esc(h.name || "them")}]: ${esc(h.text)}</span><button type="button" data-h="${esc(h.id)}" title="take it back">✕</button></div>`).join(""));
    };
    const mailSay = () => {
      const n = v.unseen.count, h = v.held.length;
      mail.classList.toggle("on", n > 0 || h > 0);
      mail.textContent = [n ? `📬 ${n}` : "", h ? `⏳ ${h}` : ""].filter(Boolean).join(" · ");
      mail.title = [n ? `${n} line${n === 1 ? "" : "s"} for you, not read yet` : "", h ? `${h} whisper${h === 1 ? "" : "s"} kept for someone away` : ""].filter(Boolean).join("; ") + " (click: see)";
      if (mailbox.classList.contains("on")) mailDraw();
    };
    mail.addEventListener("click", () => {
      if (mailbox.classList.toggle("on")) {
        mailLines = v.unseen.lines.slice(); mailMore = Math.max(0, v.unseen.count - mailLines.length);
        shared.classList.remove("on");
        mailDraw();
        if (v.unseen.count) v.read();
      }
      wake();
    });
    mailbox.addEventListener("click", e => {
      const b = e.target.closest("button[data-m], button[data-h]");
      if (b) { if (b.dataset.h) v.unhold(b.dataset.h); else mailbox.classList.remove("on"); return; }
      const d = e.target.closest(".line[data-i]");
      if (!d || e.target.closest("button.play, img, a")) return;   // (its voice message, a picture, a link: as in the chat)
      mailbox.classList.remove("on");
      to = replyTo(mailLines[Number(d.dataset.i)]);
      open();
    });
    const onHeldSent = h => note(`Passed on to ${h.name || "them"}, now in the lobby: ${h.text}`);
    // Whether someone is looking at this chat: the page shown and focused, and a key, a click or the pointer within
    // LOOKING. Your visit-client is told: a line meant for you that comes meanwhile is seen, else it is in the mailbox.
    let stirred = Date.now();
    const look = () => v.attention(document.visibilityState === "visible" && document.hasFocus() && Date.now() - stirred < LOOKING);
    const stir = () => { const was = Date.now() - stirred >= LOOKING; stirred = Date.now(); if (was) look(); };
    const lookTimer = setInterval(look, 10000);
    addEventListener("focus", look); addEventListener("blur", look); document.addEventListener("visibilitychange", look);
    for (const t of STIRS) addEventListener(t, stir, { capture: true, passive: true });
    // A voice message (🎙): recorded here, at most VOICE_SECS (🎙 again, or Enter: done; Esc: none), then by the box as a
    // picture is, and said with the line.
    let recording = null;
    const recSay = () => { recBtn.classList.toggle("on", !!recording); recBtn.textContent = recording ? `⏺ ${clock((Date.now() - recording.at) / 1000)}` : "🎙"; };
    const recStop = keep => {
      const r = recording;
      if (!r) return;
      recording = null; clearInterval(r.timer);
      Object.assign(r, { keep, secs: Math.min(VOICE_SECS, (Date.now() - r.at) / 1000) });
      if (r.rec.state !== "inactive") r.rec.stop(); else r.done();
      recSay();
    };
    const addVoice = (blob, secs) => {
      if (!typing) open();
      pending = pending.filter(p => !p.voice);   // one a line
      if (pending.length >= 4) return note("At most 4 pictures in a line");
      const p = { voice: true, secs, url: null, media: null };
      p.ready = v.share(blob).then(m => { p.media = { ...m, secs }; drawAttach(); return p.media; },
        e => { pending = pending.filter(q => q !== p); drawAttach(); note(`That voice message cannot be shared: ${e.message || e}`); return null; });
      pending.push(p);
      drawAttach();
    };
    const recStart = async () => {
      if (!window.MediaRecorder || !navigator.mediaDevices) return note("This browser cannot record a voice message");
      const kind = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(k => MediaRecorder.isTypeSupported(k));
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { return note(`No microphone for a voice message: ${e.message || e}`); }
      if (recording) { for (const t of stream.getTracks()) t.stop(); return; }
      const rec = new MediaRecorder(stream, { ...(kind ? { mimeType: kind } : {}), audioBitsPerSecond: 32000 }), chunks = [];
      const r = recording = { rec, at: Date.now(), keep: false, secs: 0, send: false, over: false };
      r.timer = setInterval(() => { recSay(); if (Date.now() - r.at >= VOICE_SECS * 1000) recStop(true); }, 250);
      r.done = () => {
        if (r.over) return;
        r.over = true;
        for (const t of stream.getTracks()) t.stop();
        if (!r.keep || !chunks.length) return;
        addVoice(new Blob(chunks, { type: (rec.mimeType || kind || "audio/webm").split(";")[0] }), r.secs);
        if (r.send) form.requestSubmit();
      };
      rec.addEventListener("dataavailable", e => { if (e.data && e.data.size) chunks.push(e.data); });
      rec.addEventListener("stop", () => r.done());
      rec.start(1000);
      recSay();
    };
    recBtn.addEventListener("click", () => { if (recording) recStop(true); else recStart(); input.focus(); });
    const key = e => {   // Enter (or /), anywhere but a box of the page's own: type a line
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || typing) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
      if (e.key === "Enter") { e.preventDefault(); open(); }
      else if (e.key === "/") { e.preventDefault(); open("/"); }
    };
    const onChat = l => {
      add(l);
      if (!quiet && !l.mine && !l.old && l.scope !== "note") chatSound(l.mention ? "whisper" : l.scope);   // a mention chimes as a whisper does
      heard(l);
    };
    const heard = l => {   // whom /r answers: who last whispered to you, else whom you last whispered; Tab's Tell: either
      if (l.scope !== "whisper") return;
      if (!l.mine && l.id) tell = last = { scope: "whisper", id: l.id, key: l.key || null, name: l.name };
      else if (l.mine && l.to && l.to.id) tell = told = { scope: "whisper", id: l.to.id, key: l.to.key || null, name: l.to.name };
    };
    const onError = e => { if (e && ["say", "whisper", "chat", "voice_join"].includes(e.ref)) note(String(e.message || e.code)); };
    const onVoice = rv => {   // into a room voice (said once), or out of one (and why)
      const o = rv && rv.out;
      if (o) note(o.why === "kicked" ? `${o.name} took you out of their room's voice` : o.why === "banned" ? `${o.name}'s room keeps you out of its voice` : `Out of ${o.name}'s room's voice: you are no longer linked`);
      else if (rv && !rv.joining && voiceIn !== rv.key) note(`In ${rv.key === v.key ? "your room's" : `${rv.name}'s room's`} voice: everyone in it hears everyone else${v.mic ? "" : ", and you once your microphone is on (🎙)"}`);
      voiceIn = rv && !rv.joining ? rv.key : rv ? voiceIn : null;
      voiceLine();
    };
    const onBanned = b => note(b.voice || b.chat ? `${b.name}'s room keeps you out of its ${b.voice && b.chat ? "voice and chat" : b.voice ? "voice" : "chat"}` : `${b.name}'s room lets you back into its voice and chat`);
    addEventListener("keydown", key);
    v.on("chat", onChat); v.on("error", onError); v.on("room_voice", onVoice); v.on("banned", onBanned); v.on("change", voiceLine); v.on("voice", voiceLine);
    v.on("unseen", mailSay); v.on("held", mailSay); v.on("held_sent", onHeldSent);
    mailSay(); look();
    voiceIn = v.roomVoice && !v.roomVoice.joining ? v.roomVoice.key : null;
    voiceLine();
    for (const l of v.chatLog) { add(l); heard(l); }
    intro = note("Enter to chat · Tab where it goes · @ mention · paste a picture · 🎙 voice message · 🖼 shared · 🎧 voice · /s say · /w whisper · /r reply · /room yours, /room name · /1 lobby");
    return {
      element: root, open, close,
      release() {
        removeEventListener("keydown", key);
        v.off("chat", onChat); v.off("error", onError); v.off("room_voice", onVoice); v.off("banned", onBanned); v.off("change", voiceLine); v.off("voice", voiceLine);
        v.off("unseen", mailSay); v.off("held", mailSay); v.off("held_sent", onHeldSent);
        recStop(false); clearInterval(lookTimer); v.attention(false);
        removeEventListener("focus", look); removeEventListener("blur", look); document.removeEventListener("visibilitychange", look);
        for (const t of STIRS) removeEventListener(t, stir, { capture: true });
        clearTimeout(fadeTimer); root.remove();
      },
    };
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
.visit-map .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.visit-map svg { display: block; width: 100%; height: 150px; background: #161b22; border-radius: 6px; }`;

  // A friend's view of the two of you (8.4, `v.seen`): their plot, and yours where they have put it in their
  // world; in metres, north (-z) up. Nothing of their other friends: they never say. HTML, for the map's side.
  const COMPASS = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
  function theirView(s, mine) {
    const a = s.at, odd = a.turn % 2 === 1, [tw, td] = a.size, mw = odd ? mine[1] : mine[0], md = odd ? mine[0] : mine[1], r = x => Math.round(x * 100) / 100;
    const x0 = Math.min(-tw / 2, a.dx - mw / 2), z0 = Math.min(-td / 2, a.dz - md / 2), x1 = Math.max(tw / 2, a.dx + mw / 2), z1 = Math.max(td / 2, a.dz + md / 2);
    const span = Math.max(x1 - x0, z1 - z0), pad = span * 0.08, fs = span / 14;
    const box = (cx, cz, w, d, fill, stroke, text) => `<rect x="${r(cx - w / 2)}" y="${r(cz - d / 2)}" width="${r(w)}" height="${r(d)}" fill="${fill}" stroke="${stroke}" stroke-width="${r(fs / 6)}"/>`
      + `<text x="${r(cx)}" y="${r(cz + fs / 3)}" font-size="${r(fs)}" text-anchor="middle" fill="#e6edf3">${text}</text>`;
    // your room's own north, as they have it turned: an arrow against that side, pointing out of it
    const [nx, nz] = turnXZ(0, -1, a.turn * Math.PI / 2), k = fs * 0.45, cx = a.dx + nx * (mw / 2 - k), cz = a.dz + nz * (md / 2 - k);
    const arrow = [[cx + nx * k, cz + nz * k], [cx - nx * k / 2 - nz * k * 0.8, cz - nz * k / 2 + nx * k * 0.8], [cx - nx * k / 2 + nz * k * 0.8, cz - nz * k / 2 - nx * k * 0.8]];
    const dist = Math.hypot(a.dx, a.dz), dir = COMPASS[(Math.round(Math.atan2(-a.dz, a.dx) / (Math.PI / 4)) % 8 + 8) % 8];
    return `<div class="muted">in their world:</div><svg viewBox="${r(x0 - pad)} ${r(z0 - pad)} ${r(x1 - x0 + 2 * pad)} ${r(z1 - z0 + 2 * pad)}">`
      + box(0, 0, tw, td, "rgba(88,166,255,.16)", "#58a6ff", esc(s.name || "theirs")) + box(a.dx, a.dz, mw, md, "rgba(63,185,80,.18)", "#3fb950", "you")
      + `<polygon points="${arrow.map(p => p.map(r).join(",")).join(" ")}" fill="#8b949e"/></svg>`
      + `<div class="muted">${dist < 0.5 ? "your room on theirs" : `your room ${dir} of theirs, ${Math.round(dist)} m middle to middle`}${a.turn ? ", " + ["", "turned a quarter left", "turned half round", "turned a quarter right"][a.turn] : ""}</div>`;
  }

  // Your world from above (v.world first): your room's plot, and each friend's where your layout puts it. Drag one
  // to put it there (it snaps to half units, and flush against what is near), turn it, or type where its middle
  // goes. Your layout is yours alone: nobody agrees to it, and each friend in it sees only where their own room
  // sits. Pick a friend to see their view of the two of you (`v.seen`). What you place is kept by visit-client
  // (with VISIT_STATE_FILE, across reloads and restarts). { element, open(), close(), release() }
  function map(v, { parent = document.body } = {}) {
    v._as("user", "map");
    if (!document.getElementById("visit-map-css")) {
      const st = document.createElement("style"); st.id = "visit-map-css"; st.textContent = MAP_CSS; document.head.appendChild(st);
    }
    const root = document.createElement("div");
    root.className = "visit-map"; root.hidden = true;
    root.innerHTML = `<div class="box"><div class="hd"><b>Your world</b><span class="grow muted">where your friends' rooms sit round yours: your layout, yours alone</span>`
      + `<button type="button" data-m="fit">Fit</button><button type="button" data-m="close">Close</button></div>`
      + `<div class="main"><canvas tabindex="0"></canvas><div class="side"></div></div>`
      + `<div class="ft">drag a room to move it · R turns it right (Shift+R left) · Delete: back to the ring · drag the ground to look about, the wheel to zoom</div></div>`;
    parent.appendChild(root);
    const canvas = root.querySelector("canvas"), side = root.querySelector(".side"), ctx = canvas.getContext("2d");
    const pending = new Map();   // key -> where you just put it, until the layout says so
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
      const list = w.list.filter(x => !x.home).map(x => {   // (a user page's own room is in the world's list as a plot too: "my room" here)
        const at = drag && drag.key === x.key ? drag.at : pending.get(x.key) || x.at;
        return { key: x.key, name: x.name, at, rect: w._rect({ at, plot: x.plot, k: x.k }), plot: x.plot, k: x.k, offline: !!x.kept,
          placed: pending.has(x.key) || v.layout.some(p => p.key === x.key) };
      });
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
        const on = sel === p.key;
        rect(p.rect, on ? "rgba(88,166,255,.32)" : "rgba(88,166,255,.16)", on ? "#e6edf3" : "#58a6ff", null, on ? 2.5 : 1.5);
        // its own north: an arrow near that side, pointing out of it (how it is turned)
        const [nx, nz] = turnXZ(0, -1, p.at.turn * Math.PI / 2), hw = (p.rect[2] - p.rect[0]) / 2, hd = (p.rect[3] - p.rect[1]) / 2;
        const [ax, az] = toPx(p.at.x + nx * hw * 0.75, p.at.z + nz * hd * 0.75);
        ctx.fillStyle = "#8b949e"; ctx.beginPath(); ctx.moveTo(ax + nx * 6, az + nz * 6); ctx.lineTo(ax - nx * 3 - nz * 5, az - nz * 3 + nx * 5);
        ctx.lineTo(ax - nx * 3 + nz * 5, az - nz * 3 - nx * 5); ctx.closePath(); ctx.fill();
        label(p.rect, p.name || "?", (p.offline ? "offline · " : "") + (p.placed ? "placed" : "in the ring"));
      }
      drawSide(d);
    }

    function drawSide(d) {
      const p = d.list.find(q => q.key === sel), theirs = v.seen.find(q => q.key === sel), others = v.seen.filter(q => !d.list.some(p => p.key === q.key));
      const sig = JSON.stringify(p ? [p.key, p.at, p.placed, theirs] : theirs ? ["only", theirs] : ["list", d.list.map(q => [q.key, q.name]), others]);
      if (sig === sideSig || (side.contains(document.activeElement) && document.activeElement.tagName === "INPUT")) return;
      sideSig = sig;
      const pick = (q, sub) => `<button type="button" class="pick" data-m="pick" data-k="${esc(q.key)}">${esc(q.name || "?")}${sub}</button>`;
      if (!p && !theirs) {
        side.innerHTML = `<div class="muted">your room: ${d.mp.size.map(x => Math.round(x * 100) / 100).join(" × ")} units</div>`
          + (d.list.length ? d.list.map(q => pick(q, "")).join("")
            : `<div class="muted">no friends' rooms in your world yet: star a friend (a guest, with their door open to you), or put a link here</div>`)
          + (others.length ? `<div class="muted">in their worlds, not in yours:</div>` + others.map(q => pick(q, "")).join("") : "");
        return;
      }
      const r2 = x => Math.round(x * 100) / 100, name = (p || theirs).name;
      side.innerHTML = `<div><b>${esc(name || "?")}</b></div>`
        + (p ? `<div class="row">x <input data-f="x" value="${r2(p.at.x)}"> z <input data-f="z" value="${r2(p.at.z)}"></div>`
          + `<div class="row">${["not turned", "turned a quarter left", "turned half round", "turned a quarter right"][p.at.turn]} <button type="button" data-m="ccw" title="a quarter turn left">⟲</button><button type="button" data-m="cw" title="a quarter turn right">⟳</button></div>`
          + `<div class="row"><button type="button" data-m="auto" title="where the world puts it by itself">Back to the ring</button></div>`
          : `<div class="muted">not in your world</div>`)
        + (theirs ? theirView(theirs, v._plotMetres()) : `<div class="muted">you are not in their world (or they have not said)</div>`)
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
        const [x, z] = toWorld(px, py);
        drag = { key: p.key, dx: x - p.at.x, dz: z - p.at.z, at: { ...p.at }, moved: false };
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
    const turnSel = by => { const d = plots(), p = d && d.list.find(q => q.key === sel); if (p) put(p, { x: p.at.x, z: p.at.z, turn: (p.at.turn + by + 4) % 4 }); draw(); };
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
  // The person's own room, first person (engine/SPEC.md 7): a user page that draws no world of its own gets one here,
  // read with the newest three.js this visit.js knows, its camera at the person's eyes, WASD, Shift and the mouse as in
  // a visit, a click pointing (8.3). Behind the stage: a visit fills the window over it, and this comes back after.
  function homeView(v, parent) {
    const root = document.createElement("div");
    root.className = "visit-home"; root.hidden = true;
    root.style.cssText = "position:fixed;inset:0;z-index:4;background:#000";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%;cursor:pointer;outline:none"; canvas.tabIndex = 0;
    const cross = document.createElement("div");
    cross.style.cssText = "position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-6px 0 0 -6px;border:2px solid rgba(255,255,255,.9);border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.55);pointer-events:none;display:none";
    const cap = document.createElement("div");
    cap.style.cssText = "position:absolute;left:0;right:0;bottom:0;padding:6px 10px;font:13px/1.4 system-ui,sans-serif;color:#c9d1d9;background:rgba(13,17,23,.6);pointer-events:none";
    root.append(canvas, cross, cap);
    parent.appendChild(root);
    const h = { world: null, T: null, renderer: null, camera: null, keys: new Set(), yaw: 0, pitch: 0, raf: 0, last: 0, me: { x: 0, y: 0, z: 0, air: 0 }, gone: false };
    const KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", ...UP_KEYS, ...DOWN_KEYS];
    const ignore = e => e.ctrlKey || e.metaKey || e.altKey || (e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)));
    const active = () => !root.hidden && h.world && v._world === h.world, locked = () => document.pointerLockElement === canvas;
    const down = e => { if (!active() || ignore(e) || !KEYS.includes(e.code)) return; e.preventDefault(); h.keys.add(e.code); };
    const up = e => h.keys.delete(e.code), blur = () => h.keys.clear();
    const click = () => { if (active() && canvas.requestPointerLock) canvas.requestPointerLock(); };
    const press = e => { if (e.button === 0 && locked() && active()) { h.world.point(); cross.style.transform = "scale(1.6)"; setTimeout(() => { cross.style.transform = ""; }, 120); } };
    const lock = () => { cross.style.display = locked() ? "block" : "none"; };
    const look = e => { if (!locked()) return; h.yaw -= e.movementX * LOOK; h.pitch = Math.max(-1.4, Math.min(1.4, h.pitch - e.movementY * LOOK)); };
    addEventListener("keydown", down); addEventListener("keyup", up); addEventListener("blur", blur);
    canvas.addEventListener("click", click); canvas.addEventListener("mousedown", press);
    document.addEventListener("mousemove", look); document.addEventListener("pointerlockchange", lock);
    const revs = Object.keys(THREE_FILES);
    loadThree(revs[revs.length - 1], v._threeBase).then(T => {
      if (h.gone) return;
      h.T = T;
      h.renderer = new T.WebGLRenderer({ canvas, antialias: true });
      h.renderer.shadowMap.enabled = true;
      h.camera = new T.PerspectiveCamera(70, 1, 0.05, 500);
      h.camera.rotation.order = "YXZ";
      h.world = v.world({ three: T, renderer: h.renderer });
      const loop = t => { h.raf = requestAnimationFrame(loop); if (!root.hidden) frame(t); };
      h.raf = requestAnimationFrame(loop);
    }).catch(e => { console.warn("visit: the home view could not load three.js", e); cap.textContent = `your room cannot be drawn here: ${e.message || e}`; });
    const frame = t => {
      const dt = h.last ? Math.min(0.1, (t - h.last) / 1000) : 0;
      h.last = t;
      if (v._world !== h.world) { root.hidden = true; return; }   // the page made a world of its own: it draws home
      const w = canvas.clientWidth, hh = canvas.clientHeight;
      if (canvas.width !== w || canvas.height !== hh) { h.renderer.setSize(w, hh, false); h.camera.aspect = w / Math.max(1, hh); h.camera.updateProjectionMatrix(); }
      const k = c => h.keys.has(c), input = { forward: (k("KeyW") || k("ArrowUp") ? 1 : 0) - (k("KeyS") || k("ArrowDown") ? 1 : 0), strafe: (k("KeyD") || k("ArrowRight") ? 1 : 0) - (k("KeyA") || k("ArrowLeft") ? 1 : 0),
        up: (UP_KEYS.some(k) ? 1 : 0) - (DOWN_KEYS.some(k) ? 1 : 0), run: k("ShiftLeft") || k("ShiftRight") };
      const at = h.world.frame(dt, Object.assign({}, h.me, { yaw: h.yaw, pitch: h.pitch }), input);
      h.me = { x: at.x, y: at.y, z: at.z, air: 0 };
      const hs = v._homeScene(), unit = hs ? hs.unit || 1 : 1, b = v.home && v._bodies.get(v.home.channel), eye = b && b.eyes ? b.eyes : hs && hs.eye != null ? hs.eye : EYES / unit;
      h.camera.position.set(at.x, at.y + eye, at.z); h.camera.rotation.set(h.pitch, h.yaw, 0);
      h.world.render(h.camera);
    };
    const draw = () => {
      const show = v.role === "user" && !v.visiting && (!v._world || v._world === h.world);
      root.hidden = !show;
      if (!show && locked()) document.exitPointerLock();
      cap.textContent = !v.home ? "your room is not up" : v.home.paused ? "your room (reloading)…" : "your room · click to look around, WASD to walk, Shift to run, Esc frees the mouse";
    };
    v.on("change", draw);
    draw();
    return {
      element: root,
      release() {
        h.gone = true; cancelAnimationFrame(h.raf);
        removeEventListener("keydown", down); removeEventListener("keyup", up); removeEventListener("blur", blur);
        canvas.removeEventListener("click", click); canvas.removeEventListener("mousedown", press);
        document.removeEventListener("mousemove", look); document.removeEventListener("pointerlockchange", lock);
        v.off("change", draw);
        if (locked()) document.exitPointerLock();
        if (h.world && v._world === h.world) h.world.release();
        if (h.renderer) { try { h.renderer.dispose(); } catch (e) { /* gone */ } }
        root.remove();
      },
    };
  }

  function stage(v, { parent = document.body } = {}) {
    v._as("user", "stage");
    const home = v.role === "user" && !v._world ? homeView(v, parent) : null;   // the person's own room, first person, behind the stage
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
      element: root, home: home && home.element, get big() { return big; }, shrink: () => set(false), grow: () => set(true),
      release() { v.off("change", draw); v.off("stats", stats); if (view) view.release(); if (home) home.release(); root.remove(); },
    };
  }

  window.Visit = {
    version: VERSION,
    // `threeBase`: where to fetch three.js from instead of the CDN ("{r}" the revision; the same files, checked
    // against the same hashes).
    // `url`: where visit-client is, a URL or a path on this origin (a workroom's server's relay), in place of `port`;
    // `role`: "host" (the room) or "user" (the person) (engine/SPEC.md 7); neither: as before.
    connect({ port, token, url = null, role = null, sim = {}, threeBase = null }) {
      const c = new Client(port, token, sim, { threeBase, url, role });
      return c._open().then(() => c, e => { c.close(); throw e; });
    },
    walk,
    bubble,
    checkModel,
    panel,
    chat,
    stage,
    map,
    _test: { cleanScene, imageDims },   // for visit-client's own tests
  };
})();
