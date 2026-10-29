# Integrating the sign-in into your workroom

**Written for the coding agent doing the integration.** Read it all before you change anything, then work
through the steps in order; each ends with how to check it. The contract behind it is [SPEC.md](SPEC.md).

This guide lives in basedverse's `auth/` directory, beside `client/` (the sign-in's source, a library built into
`visit`) and `web/login.html` (the sign-in page to start from). Paths below are relative to `auth/`.

## What you are building

Your workroom's server takes whoever can reach it for its owner: anyone on the network who can write a `Host`
header. After this integration:

- **every page and route checks the session with the sign-in**, in the one place every request passes, except an
  explicit list of public ones: a request without a valid session is turned away (a page: to `/login`; an API
  route: 401);
- the owner signs in on your `/login` page (from [web/login.html](web/login.html)) with an account made in a
  terminal, and stays signed in for up to 30 days;
- the owner's scripts and agents use API keys, checked the same way;
- `visit`'s page token comes from the sign-in, for a signed-in session, in place of your own `/api/visit`;
- anything powerful your page reached directly on `127.0.0.1` is relayed by your server, which adds that
  service's token itself: the browser never holds it.

You get it inside the program you already run and do not modify, **`visit`**: given a service token by your launcher
(step 4), it serves the sign-in's API on `127.0.0.1` only (in a container, on its container's own network,
unpublished: step 4), and talks only to your server, which sends that token with every call. **The browser never
talks to it.** Its accounts and sessions are kept in `visit`'s own database.

You write: a launcher step (a token file for `visit`), one check before every route, `/login` and `/logout`,
an `Origin` check on writes, the `/v1/visit` route, relays for local services, and a test that keeps all of it
true.

## The rule

**Every page and route checks the session with the sign-in, unless the user says otherwise.** Public routes are
an explicit list in code: `GET /login`, `POST /login`, the login page's own files (it has none: it is one page),
and only what the user names besides. Nothing is public by default. A route added later is covered without
anyone remembering to cover it. Keep the user's choices (what they made public, and why) in your workroom's
integration log.

## Before you start

- **Visit first.** The sign-in is part of `visit` and keeps its data in `visit`'s database: integrate Visit
  ([../visit/INTEGRATING.md](../visit/INTEGRATING.md)) before this, or alongside.
- **Find the one place every request passes**: your framework's middleware, or the top of your request handler.
  If your server answers some requests elsewhere (a WebSocket upgrade, a static file handler, a second port),
  each of those needs the same check: list them now.
- **List your routes**, from your router where it can tell you (Flask's `url_map`, Express's router stack,
  FastAPI's `app.routes`, a table of handlers). Step 12 tests every one.
- **Ask the user** what, if anything, must work without signing in (a status badge, a webhook). The answer is
  usually nothing.

## Step 1 — It is inside `visit`

Nothing to get: from 2.0 the sign-in is built into `visit` ([../visit/INTEGRATING.md](../visit/INTEGRATING.md),
step 1). Before 2.0 it was a program of its own, auth-client; a workroom on it moves over by
[../visit/INTEGRATING.md](../visit/INTEGRATING.md)'s "Upgrading a 1.x room to 2.0".

**Check:** `visit auth --help` lists its commands.

## Step 2 — Its database: `visit`'s own

Its accounts, sessions and keys are kept in the workroom's database, the Postgres inside `visit`, in a schema of
their own (`auth`) and as a role of their own: `visit` makes the roles and brings the schema up to date at every
start (SPEC.md 5). There is nothing to run, and no database address and no superuser to keep: none goes in your
`.env`, and your launcher passes none on.

**Check:** with your workroom's `.env` loaded, `visit psql -c '\dn'` lists the schemas `auth` and `visit`.

## Step 3 — The owner's account

In a terminal, on the machine, with your workroom's `.env` loaded (`set -a; . ./.env; set +a` in a shell: its
`VISIT_DATA_DIR` says which workroom), or with `--data-dir` right after `auth`: `visit auth user add <name>`. It
asks for the password twice, without echo (at least 12 characters). It works whether `visit` runs or not.
`bin/setup` offers to do it. There is no sign-up page, and you never add one.

**Check:** `visit auth user list` shows the account.

## Step 4 — Start it from your launcher

On every start of `visit` ([../visit/INTEGRATING.md](../visit/INTEGRATING.md), step 2):

1. Make a new service token (32 random bytes, hex) and write it to a file only the user can read (mode 0600),
   e.g. beside `visit`'s page token file. Never in the `.env`, never in a log.
2. Give `visit` that file as `AUTH_TOKEN_FILE`: it then serves the sign-in's API too, on `AUTH_PORT` (7403) unless
   you say otherwise. For step 8 it uses its own page port and token file: nothing more to give it.
3. Give your server the same `AUTH_TOKEN_FILE` and `AUTH_PORT`. It reads the token from the file once at its
   start: write the file before your server starts.
4. It stops with `visit`.

```sh
# in step 2's shell launcher, before visit starts (umask 077 already)
export AUTH_TOKEN_FILE="${XDG_RUNTIME_DIR:-/tmp}/my-workroom-auth.token"
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$AUTH_TOKEN_FILE"
```

A sign-in that cannot start (its token file missing or short, its port taken) stops `visit` before its ready line,
exit 5, saying why.

**Where your server runs.** Best, on the machine beside `visit`, with no Docker: it asks the sign-in at
`127.0.0.1:7403` as it is. A server kept in a container cannot reach the machine's `127.0.0.1`
(`host.docker.internal` does not lead there on Linux or in WSL): give its container the host's network and bind the
server to `127.0.0.1` itself (visit/INTEGRATING.md step 2, "Where your sim's own server runs"):

```yaml
services:
  your-server:
    network_mode: host              # the machine's network: visit on 127.0.0.1, as for a server on the machine
    environment:
      BIND: 127.0.0.1               # your server's own address setting, whatever it is called: never 0.0.0.0
      AUTH_HOST: 127.0.0.1          # where your server asks the sign-in
      AUTH_TOKEN_FILE: /auth/token  # the launcher's file, mounted
```

(`visit` itself can run in a container, `AUTH_LISTEN` and `VISIT_LISTEN` `0.0.0.0` on that container's own
network with no published port, for a workroom that insists: [../visit/SPEC.md](../visit/SPEC.md) 4.4 says what it
needs there. Not the way to do it.)

**Check:** `curl -s http://127.0.0.1:7403/health` answers `{"ok":true,"version":"…"}`; a call without the token,
`curl -s -X POST http://127.0.0.1:7403/v1/check -d '{}'`, answers 401. Restart your server alone: it still signs
you in.

## Step 5 — One check before every route

In the one place every request passes (never route by route):

1. If the route is in your public list, let it through.
2. Read the session cookie (`session`, or `__Host-session` over HTTPS) or, from a script, an
   `Authorization: Bearer <API key>` header.
3. Ask the sign-in: `POST /v1/check` with `{"session": …}` or `{"key": …}` and your service token. You may keep a
   valid answer for at most 5 seconds (keyed by the session or key); never keep a refusal.
4. 200: the request is the owner's (`user`, or a key's `key`): let it through. Anything else: refuse it. A page:
   `303` to `/login?next=<its path>` (with `&e=expired` if a session cookie came and failed). An API route, or any
   request with a Bearer key: `401` `{"error": "sign in"}`.
5. The sign-in unreachable (`visit` not running): refuse (503). Never let a request through because the check could
   not be made.

A sketch, in Python (adapt it to your framework's middleware):

```python
import json, os, time, urllib.error, urllib.request

AUTH = "http://%s:%s" % (os.environ.get("AUTH_HOST", "127.0.0.1"), os.environ.get("AUTH_PORT", "7403"))
SERVICE = open(os.environ["AUTH_TOKEN_FILE"]).read().strip()
PUBLIC = {("GET", "/login"), ("POST", "/login")}   # and only what the user names
_seen = {}   # session or key -> (answer, until): 5 s at most

def auth(path, body):
    """(status, JSON) from the sign-in (visit)."""
    req = urllib.request.Request(AUTH + path, json.dumps(body).encode(),
                                 {"Authorization": "Bearer " + SERVICE, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)

def who(session=None, key=None):
    """Whose a request is ({"user": …} or {"key": …}), or None."""
    ask = {"session": session} if session else {"key": key} if key else None
    if not ask:
        return None
    k, now = json.dumps(ask), time.monotonic()
    hit = _seen.get(k)
    if hit and hit[1] > now:
        return hit[0]
    code, answer = auth("/v1/check", ask)
    if code != 200:
        _seen.pop(k, None)
        return None
    if len(_seen) > 10000:
        _seen.clear()
    _seen[k] = (answer, now + 5)
    return answer
```

And in Node (Express):

```js
const PUBLIC = new Set(["GET /login", "POST /login"]);   // and only what the user names
app.use(async (req, res, next) => {
  if (PUBLIC.has(`${req.method} ${req.path}`)) return next();
  const key = (req.get("Authorization") || "").replace(/^Bearer /, "") || null;
  const session = req.cookies[secure ? "__Host-session" : "session"] || null;
  let who = null;
  try { who = await check(session ? { session } : key ? { key } : null); }   // POST /v1/check, kept 5 s at most
  catch { return res.status(503).end(); }
  if (who) { req.who = who; return next(); }
  if (key || req.path.startsWith("/api/")) return res.status(401).json({ error: "sign in" });
  res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}${session ? "&e=expired" : ""}`);
});
```

**Check:** signed out, your workroom's page sends you to `/login`, and an API route answers 401.

## Step 6 — Signing in and out

- **`GET /login`** serves [web/login.html](web/login.html), as it is or restyled (keep what SPEC.md 7 lists).
  Copy it into your workroom; do not serve it from basedverse's directory.
- **`POST /login`** (form fields `user`, `password`, `next`): call `POST /v1/login` with
  `{"user", "password", "client": {"address": <the browser's address>, "agent": <its User-Agent>}}`. The address
  is the connection's, or, only when your server sits behind a proxy you run, your proxy's header for it.
  - 200 `{session, user, expires}`: set the cookie (`HttpOnly; SameSite=Strict; Path=/; Max-Age=<expires - now>`;
    over HTTPS also `Secure`, and name it `__Host-session`), then `303` to `next`, if it is a path on your site
    (it starts with `/` but not `//` or `/\`), else to `/`.
  - 401: `303` to `/login?e=wrong` (and the same `next`). 429: `303` to `/login?e=wait`. Anything else: 503.
  - Never log the password, the session, or the body.
- **`/logout`** (a `POST`, behind the check): call `POST /v1/logout` with the session, clear the cookie
  (`Max-Age=0`), and `303` to `/login`. Put a sign-out button somewhere in your page.

**Check:** a wrong password brings you back to the page with "That name and password do not match."; the right one
brings you where you were going; after six wrong ones in a row, the page says to wait; signing out sends you to
`/login`, and the back button does not get you in.

## Step 7 — Writes refuse other sites

On top of `SameSite=Strict`: a `POST`, `PUT`, `PATCH` or `DELETE` signed in with the session cookie is refused
(403) unless its `Origin` header is your workroom's own (scheme, host and port as you serve it; each, if you serve
it under more than one name). Requests with an API key (scripts send no `Origin`) are not held to it.

**Check:** `curl -X POST -H "Origin: https://example.com" --cookie "session=<yours>" <a write route>` answers 403.

## Step 8 — `visit`'s token, from the sign-in

Replace your own `/api/visit` (the one that read `visit`'s token file, and checked the `Host` header) with a
route behind the check that calls `POST /v1/visit` with the request's session and returns its `{port, token}`.
404 from it: `visit` has no token file to read it from (pass the 404 on); no answer: `visit` is not running (503).
The `Host` check is not what keeps the network out: listening on `127.0.0.1` is, and from now on the session check
is. Your page fetches it exactly as before.

Keep `VISIT_ORIGINS` set to your page's origins (visit/INTEGRATING.md, step 2): a token taken somehow is then of
no use to another site.

**Check:** signed in, your page connects to `visit` as before; signed out, the route answers 401.

## Step 9 — Relay what is powerful

Anything your page reached directly on `127.0.0.1` with a token of its own (an agent's terminal, a console, an
internal API) now goes through your server, behind the check: the page calls your server's route, and only your
server reaches the service. The browser never holds the service's token, so every action passes your one gate
(who, from which page, and later what each account may do), and works from another device too (step 10). Remove
the token from every page and response, and the route that handed it out.

How your server reaches the service depends on where each runs:

- **The same network** (both on this machine's, or both in one container's): your server calls the service on
  `127.0.0.1` and adds its token.
- **Your server in a container, the service on this machine** (the usual case: a container cannot reach this
  machine's `127.0.0.1`, and `host.docker.internal` reaches it only on Docker Desktop for macOS and Windows, not
  on Linux or in WSL): turn the connection around. **The service connects out to your server**, at the port your
  server publishes on this machine (which any program on it can reach, on any OS), signed in with an API key of
  its own (`visit auth key add <its name>`), and asks for work:

  ```
  service ──GET /api/<it>/next (Bearer <its key>)──▶ server    held until there is work (or ~25 s: nothing, ask again)
          ◀── {"id": 17, "do": "...", ...} ──                   a request your page made, queued by the server
  service ──POST /api/<it>/answer {"id": 17, "status", "body"}──▶ server ──▶ the page's request answered
  ```

  Long-polling, as above, is enough for request-and-answer traffic (a screen read every second, a reply); a
  stream (audio, live video) wants a WebSocket the same way round. The service then listens on no port at all: no
  token, no `Origin` or `Host` checks of its own. Your server accepts `/next` and `/answer` from that service's key
  only, never a session or another key, and your page's routes from a session only. The service still checks each
  job it takes (names, lengths, which keys it may press), so a fault in your server cannot make it do anything.

**Visit is the exception**, for a room not on the engine: its page connects to `visit` directly (its scene, input
and voice are a stream, at up to 60 messages a second), with its token from `/v1/visit` (step 8). So Visit works on
this machine's own browser only; from another device, your server refuses `/api/visit` (step 10), and your page goes
on without it. A room on the engine has no exception: your server relays the person to `visit` like the rest
([../engine/INTEGRATING.md](../engine/INTEGRATING.md), step 4).

**Check:** search your page's code and responses for those tokens: none. Each service's own port: none (`ss -ltnp`).
Its key refused on your page's routes, a session refused on its `/next`.

## Step 10 — Where it listens, and reaching it from another device

Your server listens on `127.0.0.1` until this integration is done and checked, and `visit`'s ports stay on
`127.0.0.1` always (`visit` in a container: its own network, never published). To reach your workroom from another
device (a laptop or a phone on your network, or your tailnet), put an **HTTPS proxy** in front of it, never plain
HTTP: your password and session cookie would cross the network readable by anyone on it. Any proxy will do; the
user picks one:

- **Tailscale**, if they have it: `tailscale serve --bg http://127.0.0.1:<your proxy port>` gives
  `https://<machine>.<tailnet>.ts.net`, with a certificate every device trusts, on their tailnet only.
- **Caddy**, beside your server (in its compose file): HTTPS on this machine's LAN address with its own certificate
  authority (`tls internal`), accepting private addresses only (`remote_ip private_ranges`). Each device trusts
  its root certificate once (install it, or accept the browser's warning). Find the LAN address in your launcher
  (Python: connect a UDP socket to any public address and read `getsockname()`), so the user types nothing.
- Their own (nginx, a router's, a domain with a real certificate).

Give the proxy **a port of its own**: a second listener of your server's, on `127.0.0.1` (published only there
from a container), where every request is another device's. There, and only there:

- the session cookie is `__Host-session`, with `Secure` (SPEC.md 4);
- your page's origin is `https://` and the request's `Host` (only the proxy reaches this port, and it serves
  HTTPS for that name), so writes are checked against it with no setting;
- the browser's address for `/v1/login` is the proxy's word for it: the last `X-Forwarded-For` entry (the proxy
  adds it; earlier entries are the client's own claims), or your proxy's `X-Real-IP`;
- `/api/visit` is refused (step 9).

Your own listener (`127.0.0.1`, plain HTTP) stays as it is: the `session` cookie, your own origins, the connection's
address. Nothing else changes.

**Check:** `ss -ltnp` (or `netstat -an`): `visit`'s ports (7401, 7403; 7405 with the engine) on `127.0.0.1` only
(`visit` in a container: not listed, no port published); your server's two listeners too (or published only
there). From another device, through the proxy: you sign in, your pages and their relayed services work,
`/api/visit` is refused, and plain `http://` to this machine's address answers nothing.

## Step 11 — Scripts and agents

`visit auth key add <label>` makes a key, printed once: give it to the script, which sends it as
`Authorization: Bearer <key>`; your check (step 5) asks `/v1/check {key}`. `visit auth key revoke <label>` ends
it. One key a script, so each can be revoked alone. Not the label `engine`: that is `visit`'s own key, for its
engine, made new at each start (SPEC.md 4).

**Check:** a request with the key gets through; after `key revoke`, within 5 s, it is refused.

## Step 12 — The test you keep

Add this test to your workroom and run it with the rest: every route your server has, asked without a session, is
refused; asked with one, is not. List the routes from your router where it can (so a new one is in the test
without anyone adding it); else keep the list by hand, and keep it whole.

```python
"""Every route is refused without a session and answered with one (auth/INTEGRATING.md, step 12).
Needs the workroom running, and a session: sign in once, or make one in the test with POST /login."""
import http.client, os

HOST, PORT = "127.0.0.1", int(os.environ.get("WORKROOM_PORT", "8000"))
SESSION = os.environ["TEST_SESSION"]          # a signed-in session's cookie value
ROUTES = [("GET", "/"), ("GET", "/api/visit")]   # every route: from your router, if it can say
PUBLIC = {("GET", "/login"), ("POST", "/login")}

def ask(method, path, cookie=None):
    c = http.client.HTTPConnection(HOST, PORT, timeout=10)
    headers = {"Origin": "http://%s:%d" % (HOST, PORT)}
    if cookie:
        headers["Cookie"] = "session=" + cookie
    c.request(method, path, body=b"{}" if method != "GET" else None, headers=headers)
    r = c.getresponse()
    return r.status, r.getheader("Location") or ""

for method, path in ROUTES:
    if (method, path) in PUBLIC:
        continue
    code, where = ask(method, path)
    assert code == 401 or (code == 303 and where.startswith("/login")), "%s %s answered %d without a session" % (method, path, code)
    code, where = ask(method, path, SESSION)
    assert code not in (401, 403) and not where.startswith("/login"), "%s %s refused a session (%d)" % (method, path, code)
    print("ok", method, path)
```

## Checklist

- [ ] The sign-in is `visit`'s (2.0 on): no auth-client, and no database address or superuser in the `.env` or
      passed to anything; `visit psql -c '\dn'` lists `auth`.
- [ ] The owner's account made in a terminal; no sign-up page anywhere.
- [ ] The launcher makes a new service token each start (mode 0600) and gives it to `visit` (`AUTH_TOKEN_FILE`) and
      the server.
- [ ] One check, in the one place every request passes (and in each other place that answers requests: WebSocket
      upgrades, static files, other ports); refused without a session; 503 when the sign-in cannot be reached.
- [ ] Public routes: an explicit list in code, and only what the user named; kept in the integration log.
- [ ] `/login` from web/login.html: its form, its message codes, `next` checked again on the server; `/logout`.
- [ ] The cookie: `HttpOnly; SameSite=Strict; Path=/`, `Max-Age` from `expires`; `Secure` and `__Host-` over HTTPS.
- [ ] Writes with the cookie refused from another `Origin`.
- [ ] `visit`'s token from `/v1/visit`, behind the check; the old `/api/visit` gone; `VISIT_ORIGINS` set.
- [ ] Local services relayed by the server (in a container: they connect out to it, with keys of their own); their
      tokens in no page or response, their own ports gone.
- [ ] The server on `127.0.0.1`; from another device only through an HTTPS proxy, on a listener of its own (the
      `__Host-` cookie, the origin from `Host`, the proxy's word for the address, no `/api/visit`); `visit`'s ports on
      `127.0.0.1` (`visit` in a container: its own network, by name, no published port).
- [ ] The route test (step 12) in your tests, passing.
- [ ] Nothing logs a password, a session, a key or a token.

## Upgrading

Read [../CHANGELOG.md](../CHANGELOG.md) from your version up; then get the new `visit`
([../visit/INTEGRATING.md](../visit/INTEGRATING.md), "Upgrading"): the sign-in comes with it, its schema brought up
to date by its first start, with nothing to run. From auth-client (1.x): ../visit/INTEGRATING.md's "Upgrading a 1.x
room to 2.0" (its accounts, sessions and keys move in with `visit import`).

## Don't

- Don't add a sign-up page, a "forgot password" link, or any way to make an account in a browser.
- Don't check sessions route by route, or make anything public by default.
- Don't let a request through when the sign-in cannot be reached.
- Don't give the browser the sign-in's service token, `visit`'s page token outside `/v1/visit`, or any local
  service's token.
- Don't take a message for the login page from the URL, or redirect to a `next` that is not a path on your site.
- Don't give anything the database superuser's password (`postgres/secrets` in the workroom's data directory): it is
  `visit`'s alone.
- Don't listen beyond `127.0.0.1` without HTTPS or an encrypted network, and don't open a local service's port to
  your server's container (`route_localnet`, binding it to `0.0.0.0` or Docker's bridge): have it connect out.
