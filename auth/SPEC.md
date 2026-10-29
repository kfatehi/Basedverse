# auth: a workroom's sign-in

A workroom's sign-in, from basedverse, that every workroom's server uses, so that none of them invents its own. It
is built into `visit`, the one program a workroom runs ([../visit/SPEC.md](../visit/SPEC.md) 4): `visit` serves its
API, and `visit auth …` is its side in a terminal. (Up to 1.x it was a program of its own, auth-client.)
[INTEGRATING.md](INTEGRATING.md) says how to use it; this is the contract behind it.

## 1. What it is

A workroom's server, without it, takes whoever can reach it for its owner. The sign-in gives it a real one, from
standard pieces. It:

- keeps the owner's account (made in a terminal, never in a browser) and checks passwords;
- makes, checks and ends sessions;
- makes API keys for the owner's scripts and agents;
- hands `visit`'s page port and token to a signed-in session, in place of each workroom's own `/api/visit`.

`visit` serves its API when the workroom's launcher gives it a service token's file (`AUTH_TOKEN_FILE`, 8), on
`127.0.0.1` only, or, in a container, on its container's own network (`AUTH_LISTEN`), its port never published.
**The browser never talks to it: only the workroom's server does.**

```
browser (this machine, or another device over HTTPS)
   │  every request, with the session cookie
   ▼
workroom's server ── POST /v1/check ──▶ visit's sign-in API (127.0.0.1) ── the Postgres inside visit (schema auth)
   │  valid: the route runs
   │  a powerful local service: relayed, its own token added by the server
   ▼
local services on 127.0.0.1 (visit, an agent console, …)
```

The rule that goes with it, for every workroom: **every page and route checks the session with the sign-in,
unless the user says otherwise.**

## 2. Accounts: in a terminal only

There is no sign-up page, ever: having a terminal on the machine is the proof of ownership.

| command | does |
|---|---|
| `visit auth user add <name>` | makes an account; asks for the password twice, without echo. `bin/setup` offers it |
| `visit auth passwd <name>` | sets a new password, and ends that user's sessions |
| `visit auth user list` / `user remove <name>` | the accounts; removing one ends its sessions |
| `visit auth sessions [<name>]` | the signed-in sessions (since when, from where, last seen, the browser), and the last ten sign-ins tried |
| `visit auth revoke <session>` / `revoke --user <name>` | ends a session (its first 6 or more characters, as `sessions` shows it) or all of a user's |
| `visit auth key add <label>` | an API key for a script or agent, printed once |
| `visit auth key list` / `key revoke <label>` | |

- **Which workroom**: the one `visit` itself would run, `VISIT_DATA_DIR` or, without it, the default made from
  `VISIT_NAME` (so, with the workroom's `.env` loaded, its own); or `--data-dir <dir>` (or `--name <name>`) right
  after `auth`: `visit auth --data-dir <dir> user list`. While the workroom's `visit` runs, on its database;
  otherwise `visit` starts the workroom's Postgres for the command and stops it after (../visit/SPEC.md 4.5).
- A name or a label: 1 to 64 letters, digits, `.`, `_`, `@` or `-`, starting with a letter or digit. Names are
  one account whatever their case (`Aldo` is `aldo`), and sign in in any case.
- A password: at least 12 characters, at most 1024 bytes, and no other rule on what they are (NIST SP 800-63B).
  `--password-stdin` takes it as one line on stdin, for a script; without it, a terminal is required.
- Every user is an owner (no roles). Usually there is one.
- A session is shown by the start of its id's SHA-256 (the id itself is never kept, 4).
- Each command that changes accounts, sessions or keys tells the running `visit` (`NOTIFY auth_changed`), which
  reads them again at once: a revoked session or key is refused within the workroom server's own cache time (at
  most 5 s, 3).

## 3. The API

HTTP and JSON on `127.0.0.1:<port>` (`AUTH_PORT`, default 7403; in a container, its address there), served by
`visit` while it runs. Every call but `/health` carries `Authorization: Bearer <service token>`: the launcher makes
that token each run and writes it to a file only the user can read (mode 0600), given to `visit`
(`AUTH_TOKEN_FILE`) and to the workroom's server, as `visit`'s page token is. Secrets travel in bodies, never in
URLs. A body is JSON, at most 16 KiB.

| call | body | answer |
|---|---|---|
| `POST /v1/login` | `{user, password, client: {address, agent}}` | 200 `{session, user, expires}`; 401 `{error: "wrong_login"}`; 429 `{error: "wait", retry_after}` |
| `POST /v1/check` | `{session}` or `{key}` | 200 `{user}` or `{key: <label>}`, and a session's idle time starts again; 401 `{error: "no_session"}` / `{error: "no_key"}` |
| `POST /v1/logout` | `{session}` | 200 `{}` (whether it was live or not) |
| `POST /v1/visit` | `{session}` | 200 `{port, token}`, `visit`'s own page port and token, the token read fresh from its token file; 401 `{error: "no_session"}`; 404 `{error: "no_visit_client"}` when there is no token file to read |
| `GET /health` | | 200 `{ok: true, version}` |

Every call: 401 `{error: "service_token"}` without the service token, or with another; 400
`{error: "bad_request"}` for a body that is not what it should be; 503 `{error: "unavailable"}` when the database
cannot be reached for a sign-in.

- `/v1/login`: `client.address` is the browser's address as the workroom's server has it (from its proxy's header,
  when it sits behind one); `client.agent` its `User-Agent`. `user` is the name as typed. `expires` is when the
  session ends at the latest, in seconds since 1970: the server makes it the cookie's `Max-Age`. An unknown name
  and a wrong password get the same answer, in about the same time.
- `/v1/check` runs on every request. `visit` answers it from memory, from a cache of the live sessions and keys
  (read again when the terminal's commands change them, and every minute), in well under a millisecond. A
  session's `last_seen_at` and a key's `last_used_at` are written at most once a minute. The workroom's server may
  keep a valid answer for at most 5 seconds.
- `/v1/visit` answers 404 when `visit` was given its page token without a file (`--token`), or its token file
  (`VISIT_TOKEN_FILE`) is missing or empty. The API and the page are one process: there is nothing to probe.
- A sign-in API that cannot start (its token file missing, or shorter than 32 characters; its port taken;
  `AUTH_IDLE` longer than `AUTH_MAX_AGE`) stops `visit` before it says it is ready: exit 5 (../visit/SPEC.md 4.1).

## 4. Sessions and keys

- A session id is 32 random bytes from the OS's secure generator, base64url (43 characters). Only its SHA-256 is
  kept, so a copy of the database holds no live sessions. Every sign-in makes a new session.
- A session ends after 7 days unused (`AUTH_IDLE`) or 30 days in all (`AUTH_MAX_AGE`), at sign-out, when revoked,
  when its user is removed, or when its user's password changes.
- An API key is `bvk_` and 32 random bytes, base64url (47 characters), printed once by `key add`; only its SHA-256
  is kept. It lasts until revoked. A script sends it as `Authorization: Bearer <key>` to the workroom's server,
  which checks it with `/v1/check {key}`.
- **The engine's key.** A `visit` that runs the engine (`ENGINE_ROOM_URL`, ../engine/SPEC.md 5) makes it an API
  key of its own at each start, labelled `engine`, and the one before it is gone. The engine sends it on the room's
  server page's requests to its server, which checks it with `/v1/check {key}` as any key (`{key: "engine"}`).
  Nothing outside `visit` ever holds it. A key of anyone else's labelled `engine` is replaced too: give yours other
  labels.
- The workroom's server sets the session as a cookie: `HttpOnly; SameSite=Strict; Path=/` and
  `Max-Age=<expires - now>`, named `session`; over HTTPS, also `Secure`, and named `__Host-session`.

## 5. The database

The sign-in keeps its data in the workroom's database, the Postgres inside `visit` (../visit/SPEC.md 4.4), so a
workroom can join its users and their sign-ins with Visit's data. Its tables live in their own schema, `auth`,
owned by their own role, `auth`. The visit-client, the part of `visit` that talks to the internet, uses a role of
its own, `visit`, with no rights to `auth`'s tables, so its queries cannot read a password hash; nor do the
sign-in's reach the visit-client's.

| table | |
|---|---|
| `auth.users` | id, name (unique, whatever its case), password_hash (Argon2id, PHC string), created_at, password_changed_at |
| `auth.sessions` | id_hash (SHA-256, the key), user_id, created_at, last_seen_at, expires_at, client_address, user_agent |
| `auth.api_keys` | id, label (unique among live keys), key_hash, created_at, last_used_at, revoked_at |
| `auth.login_attempts` | at, user_name, client_address, ok, waited (turned away unchecked, too soon after wrong ones); kept 90 days |
| `auth.migrations` | version, name, applied_at |

**Roles.** `visit` makes them right at every start, as the database's superuser (`postgres`): `visit` and `auth`,
each a plain role with its own password (no superuser, no creating databases or roles), owning a schema of its name
and searching only it. Only those two may connect to the database (and the superuser); nobody may make tables in
`public`. Then it brings this schema up to date as `auth`, each migration once, in a transaction of its own
(recorded in `auth.migrations`). The three passwords are made at the first start and kept in `postgres/secrets` in
the workroom's data directory, readable by the user only. The superuser is `visit`'s alone: no run and no server is
given it (`visit psql` is a psql as it, for the user at a terminal).

**From 1.x.** A workroom's database from auth-client's days (0.21 to 1.1) is moved in once, with the rest of it, by
`visit import` (../visit/SPEC.md 4.5): accounts, sessions, keys and the sign-ins tried come as they were.

## 6. Guessing

- Wrong passwords slow down per user name and per client address: after 5 wrong in 15 minutes (since the last
  sign-in that worked, for that name or address), each further try waits twice as long as the last: 1 s, 2 s, 4 s…
  up to 15 minutes. One too soon gets 429 `{error: "wait", retry_after}` (seconds), unchecked, whatever the
  password.
- An unknown name and a wrong password get the same answer, in about the same time (a hash checked either way,
  against a dummy one for an unknown name).
- At most 4 passwords are checked at once (each takes 19 MiB); more wait their turn.
- Every try is kept (`auth.login_attempts`), for `visit auth sessions` and an audit.

## 7. The login template

`auth/web/login.html` is one self-contained page, with nothing from elsewhere: its pictures are drawn by it. A
workroom serves it at `GET /login`, and may restyle it, but keeps:

- a form posting `user`, `password` and a hidden `next` to `/login`, with `autocomplete="username"` and
  `autocomplete="current-password"`, so password managers work;
- messages chosen by a code (`?e=wrong`, `?e=wait`, `?e=expired`), never text taken from the URL;
- `next` honoured only as a path on the same site (it starts with `/` but not `//` or `/\`), else `/`. The server
  checks it again before it redirects there.

It has no way to sign up. It shows the address it was served from ("Workroom localhost:8000"), so whoever signs in
sees whose it is.

## 8. Settings

Each is a variable in `visit`'s environment and a flag of `visit`'s (`AUTH_PORT` is `--auth-port`;
../visit/SPEC.md 4.1).

| variable | flag | default | |
|---|---|---|---|
| `AUTH_TOKEN_FILE` | `--auth-token-file` | none: no API | the service token's file (at least 32 characters; it warns if others can read it). Given, `visit` serves the API |
| `AUTH_PORT` | `--auth-port` | 7403 | its port |
| `AUTH_LISTEN` | `--auth-listen` | `127.0.0.1` | its address: `127.0.0.1`, or, in a container, `0.0.0.0`: its container's own network, where a workroom's server in another container on that network reaches it by name (its port never published, so nothing else does) |
| `AUTH_IDLE` | `--auth-idle` | `7d` | a session ends after this long unused (a number and s, m, h or d) |
| `AUTH_MAX_AGE` | `--auth-max-age` | `30d` | ...and after this long in all |

For `/v1/visit` it takes `visit`'s own page port and token file (`VISIT_PORT`, `VISIT_TOKEN_FILE`). Its database is
the workroom's, inside `visit`: there is no setting for it. It logs with the rest of `visit`, to stderr. Gone with
auth-client: `AUTH_DATABASE_URL`, `AUTH_VISIT_PROBE`, `AUTH_LOG`, and, for its `migrate`, `VISIT_DATABASE_URL`
and `VISIT_DATABASE_ADMIN_URL`.

## 9. Limits

| what | limit |
|---|---|
| a request body | 16 KiB |
| a name, a label | 64 characters |
| a password | 12 characters to 1024 bytes |
| passwords checked at once | 4 |
| a session's or key's last use, written | at most once a minute |
| a check's answer, kept by the workroom's server | at most 5 s |
| sign-ins kept | 90 days |

## 10. How it ends

`visit auth …`:

| exit | |
|---|---|
| 0 | done |
| 1 | it failed (said on stderr) |
| 2 | bad flags, or no workroom (neither `VISIT_DATA_DIR` nor `VISIT_NAME`, nor their flags) |
| 5 | the workroom's database could not be opened (said on stderr) |

The API is part of a running `visit`: one that cannot start stops `visit` before it is ready, exit 5 (3).

## Not in v1

Signing up in a browser (never); roles beyond owner; passkeys and two-factor sign-in (later: WebAuthn); HTTPS inside
`visit` (the workroom's server, or a proxy in front of it, serves HTTPS).
