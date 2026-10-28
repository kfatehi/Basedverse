# auth-client

A workroom's sign-in: one small program from basedverse that every workroom's server uses, so that none of them
invents its own. [INTEGRATING.md](INTEGRATING.md) says how to use it; this is the contract behind it.

## 1. What it is

A workroom's server today takes whoever can reach it for its owner. auth-client gives it a real sign-in, from
standard pieces. It:

- keeps the owner's account (made in a terminal, never in a browser) and checks passwords;
- makes, checks and ends sessions;
- makes API keys for the owner's scripts and agents;
- hands visit-client's port and token to a signed-in session, in place of each workroom's own `/api/visit`.

It is started by the workroom's launcher beside visit-client, and listens on `127.0.0.1` only. **The browser
never talks to it: only the workroom's server does.**

```
browser (this machine, or another device over HTTPS)
   │  every request, with the session cookie
   ▼
workroom's server ── POST /v1/check ──▶ auth-client (127.0.0.1) ── Postgres (Visit's database, schema auth)
   │  valid: the route runs
   │  a powerful local service: relayed, its own token added by the server
   ▼
local services on 127.0.0.1 (visit-client, an agent console, …)
```

The rule that goes with it, for every workroom: **every page and route checks the session with auth-client,
unless the user says otherwise.**

## 2. Accounts: in a terminal only

There is no sign-up page, ever: having a terminal on the machine is the proof of ownership.

| command | does |
|---|---|
| `auth-client user add <name>` | makes an account; asks for the password twice, without echo. `bin/setup` runs it |
| `auth-client passwd <name>` | sets a new password, and ends that user's sessions |
| `auth-client user list` / `user remove <name>` | the accounts; removing one ends its sessions |
| `auth-client sessions [<name>]` | the signed-in sessions (since when, from where, last seen, the browser), and the last ten sign-ins tried |
| `auth-client revoke <session>` / `revoke --user <name>` | ends a session (its first 6 or more characters, as `sessions` shows it) or all of a user's |
| `auth-client key add <label>` | an API key for a script or agent, printed once |
| `auth-client key list` / `key revoke <label>` | |
| `auth-client migrate [--status]` | makes its schema ready, as `visit-client migrate` does |
| `auth-client migrate --admin <superuser URL>` | makes the database's two plain roles first (5) |

- A name or a label: 1 to 64 letters, digits, `.`, `_`, `@` or `-`, starting with a letter or digit. Names are
  one account whatever their case (`Aldo` is `aldo`), and sign in in any case.
- A password: at least 12 characters, at most 1024 bytes, and no other rule on what they are (NIST SP 800-63B).
  `--password-stdin` takes it as one line on stdin, for a script; without it, a terminal is required.
- Every user is an owner (no roles). Usually there is one.
- A session is shown by the start of its id's SHA-256 (the id itself is never kept, 4).
- Each command that changes accounts, sessions or keys tells the running auth-client (`NOTIFY auth_changed`),
  which reads them again at once: a revoked session or key is refused within the workroom server's own cache
  time (at most 5 s, 3).

## 3. The API

HTTP and JSON on `127.0.0.1:<port>` (default 7403). Every call but `/health` carries
`Authorization: Bearer <service token>`: the launcher makes that token each run and writes it to a file only the
user can read (mode 0600), given to auth-client (`--token-file`) and to the workroom's server, as visit-client's
page token is. Secrets travel in bodies, never in URLs. A body is JSON, at most 16 KiB.

| call | body | answer |
|---|---|---|
| `POST /v1/login` | `{user, password, client: {address, agent}}` | 200 `{session, user, expires}`; 401 `{error: "wrong_login"}`; 429 `{error: "wait", retry_after}` |
| `POST /v1/check` | `{session}` or `{key}` | 200 `{user}` or `{key: <label>}`, and a session's idle time starts again; 401 `{error: "no_session"}` / `{error: "no_key"}` |
| `POST /v1/logout` | `{session}` | 200 `{}` (whether it was live or not) |
| `POST /v1/visit` | `{session}` | 200 `{port, token}`, visit-client's, its token read fresh from its token file; 401 `{error: "no_session"}`; 404 `{error: "no_visit_client"}` when no visit-client runs |
| `GET /health` | | 200 `{ok: true, version}` |

Every call: 401 `{error: "service_token"}` without the service token, or with another; 400
`{error: "bad_request"}` for a body that is not what it should be; 503 `{error: "unavailable"}` when the database
cannot be reached for a sign-in.

- `/v1/login`: `client.address` is the browser's address as the workroom's server has it (from its proxy's header,
  when it sits behind one); `client.agent` its `User-Agent`. `user` is the name as typed. `expires` is when the
  session ends at the latest, in seconds since 1970: the server makes it the cookie's `Max-Age`. An unknown name
  and a wrong password get the same answer, in about the same time.
- `/v1/check` runs on every request. auth-client answers it from memory, from a cache of the live sessions and keys
  (read again when the terminal's commands change them, and every minute), in well under a millisecond. A
  session's `last_seen_at` and a key's `last_used_at` are written at most once a minute. The workroom's server may
  keep a valid answer for at most 5 seconds.
- `/v1/visit` answers 404 when auth-client was given no visit-client token file (`VISIT_TOKEN_FILE`), the file is
  missing or empty, or nothing answers on visit-client's port (`VISIT_PORT`; not asked with `AUTH_VISIT_PROBE=false`).

## 4. Sessions and keys

- A session id is 32 random bytes from the OS's secure generator, base64url (43 characters). Only its SHA-256 is
  kept, so a copy of the database holds no live sessions. Every sign-in makes a new session.
- A session ends after 7 days unused (`--idle`) or 30 days in all (`--max-age`), at sign-out, when revoked, when
  its user is removed, or when its user's password changes.
- An API key is `bvk_` and 32 random bytes, base64url (47 characters), printed once by `key add`; only its SHA-256
  is kept. It lasts until revoked. A script sends it as `Authorization: Bearer <key>` to the workroom's server,
  which checks it with `/v1/check {key}`.
- The workroom's server sets the session as a cookie: `HttpOnly; SameSite=Strict; Path=/` and
  `Max-Age=<expires - now>`, named `session`; over HTTPS, also `Secure`, and named `__Host-session`.

## 5. The database

auth-client uses Visit's own Postgres database, so a workroom can join its users and their sign-ins with Visit's
data. Its tables live in their own schema, `auth`, owned by their own role, `auth` (`AUTH_DATABASE_URL`).
visit-client, the program that talks to the internet, gets no rights to it, so a fault in visit-client cannot
read a password hash; nor does auth-client get any to visit-client's.

| table | |
|---|---|
| `auth.users` | id, name (unique, whatever its case), password_hash (Argon2id, PHC string), created_at, password_changed_at |
| `auth.sessions` | id_hash (SHA-256, the key), user_id, created_at, last_seen_at, expires_at, client_address, user_agent |
| `auth.api_keys` | id, label (unique among live keys), key_hash, created_at, last_used_at, revoked_at |
| `auth.login_attempts` | at, user_name, client_address, ok, waited (turned away unchecked, too soon after wrong ones); kept 90 days |
| `auth.migrations` | version, name, applied_at |

**Roles.** `auth-client migrate --admin <superuser URL>` (with `VISIT_DATABASE_URL` and `AUTH_DATABASE_URL`, the
two URLs as they will be) makes visit-client's role and auth-client's each a plain role with its URL's password
(no superuser, no creating databases or roles), owning a schema of its name (`visit`, `auth`) and searching only it.
Only those two may connect to the database (and the superuser); nobody may make tables in `public`. Then it makes
auth-client's schema ready, as its own role. Run again, it changes nothing but the passwords. The superuser is
for this and nothing else: no run is given it.

**Moving over a database made before 0.21.** Up to 0.20, setup made visit-client's role the database's superuser
(`POSTGRES_USER=visit`), its tables in `public`. Postgres keeps a database's bootstrap superuser a superuser, so
`migrate --admin` with that URL, and `--new-admin <URL>` (the superuser as it will be: another name, a new
password), renames the superuser to `--new-admin`'s name and password, makes `visit` a plain role, and moves
visit-client's tables, with all they hold, into its schema. The old URL then gets nobody in: visit-client is given
its new one.

## 6. Guessing

- Wrong passwords slow down per user name and per client address: after 5 wrong in 15 minutes (since the last
  sign-in that worked, for that name or address), each further try waits twice as long as the last: 1 s, 2 s, 4 s…
  up to 15 minutes. One too soon gets 429 `{error: "wait", retry_after}` (seconds), unchecked, whatever the
  password.
- An unknown name and a wrong password get the same answer, in about the same time (a hash checked either way,
  against a dummy one for an unknown name).
- At most 4 passwords are checked at once (each takes 19 MiB); more wait their turn.
- Every try is kept (`auth.login_attempts`), for `auth-client sessions` and an audit.

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

Each is a flag and a variable in its environment (`AUTH_PORT` is `--port`).

| variable | default | |
|---|---|---|
| `AUTH_DATABASE_URL` | (required) | postgres://auth:password@host:port/database: Visit's database, as auth-client's role |
| `AUTH_PORT` | 7403 | its port on 127.0.0.1 |
| `AUTH_TOKEN_FILE` | (required to run) | the service token's file (at least 32 characters; it warns if others can read it) |
| `AUTH_IDLE` | `7d` | a session ends after this long unused (a number and s, m, h or d) |
| `AUTH_MAX_AGE` | `30d` | ...and after this long in all |
| `VISIT_PORT`, `VISIT_TOKEN_FILE` | 7401, none | visit-client's, for `/v1/visit`: the same as visit-client is given |
| `AUTH_VISIT_PROBE` | `true` | whether `/v1/visit` makes sure something answers on visit-client's port; `false` where auth-client cannot reach it (a container beside a visit-client on the host's network): its token file there is then taken for a running visit-client |
| `VISIT_DATABASE_ADMIN_URL`, `VISIT_DATABASE_URL` | | for `migrate --admin` only |
| `AUTH_LOG` | `info` | what it logs (to stderr): `warn`, `debug`, … |

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

| exit | |
|---|---|
| 0 | done (a run: stopped) |
| 1 | it failed (said on stderr) |
| 2 | bad flags (no database, no token file, a token too short) |
| 5 | the database is not at the schema it needs: run `auth-client migrate` (or use a newer auth-client) |

## Not in v1

Signing up in a browser (never); roles beyond owner; passkeys and two-factor sign-in (later: WebAuthn); Visit from
another device (the workroom's server relaying visit-client); HTTPS inside auth-client (the workroom's server, or
a proxy in front of it, serves HTTPS).
