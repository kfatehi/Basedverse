"""auth, inside visit (V2.md 2): the workroom's database as visit makes it (its roles apart); the terminal's
commands (`visit auth …`, on a running visit's database and on one started for the command); and the API a running
visit serves, as a workroom's server calls it. No Postgres of its own: the one inside visit.

  python3 e2e.py <visit>
"""
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import psycopg

VISIT = sys.argv[1]
TMP = tempfile.mkdtemp()
os.environ["XDG_DATA_HOME"] = os.path.join(TMP, "xdg")   # where the Postgres inside visit is unpacked, once
DATA = os.path.join(TMP, "office")                        # the workroom's data directory
PASSWORD, NEW_PASSWORD = "correct horse battery staple", "a whole new password, longer"
failures = []


def check(what, got, want):
    if got == want:
        print("ok    " + what, flush=True)
    else:
        failures.append(what)
        print("FAIL  %s\n      got  %r\n      want %r" % (what, got, want), flush=True)


def run(*args, data=DATA, stdin=None):
    """`visit auth <args>` on the workroom in `data`: (exit code, stdout, stderr)."""
    r = subprocess.run([VISIT, "auth", "--data-dir", data, *args], input=stdin, capture_output=True, text=True,
                       stdin=None if stdin is not None else subprocess.DEVNULL, timeout=60)
    return r.returncode, r.stdout, r.stderr


def secret_file(path, value):
    with open(path, "w") as f:
        f.write(value + "\n")
    os.chmod(path, 0o600)
    return path


def start(data, visit_port, auth_port, *extra):
    """A running visit for the workroom in `data`, its sign-in API on `auth_port`: (process, service token, its
    page token). No lobby answers (none is needed here): it keeps trying, as it would."""
    token, vtoken = os.urandom(32).hex(), os.urandom(32).hex()
    tfile = secret_file(os.path.join(data + ".auth-token"), token)
    vfile = secret_file(os.path.join(data + ".visit-token"), vtoken)
    p = subprocess.Popen([VISIT, "--lobby", "ws://127.0.0.1:9/", "--name", "Auth Test", "--port", str(visit_port), "--token-file", vfile,
                          "--data-dir", data, "--auth-token-file", tfile, "--auth-port", str(auth_port), *extra],
                         stdout=subprocess.PIPE, stderr=open(data + ".log", "w"), env={**os.environ, "RUST_LOG": "warn"})
    ready = json.loads(p.stdout.readline() or "{}")
    if not ready.get("ready"):
        raise AssertionError("visit did not start: " + open(data + ".log").read())
    return p, token, vtoken


def urls(data):
    """Each role's URL to the Postgres of a running visit, from what it keeps (its passwords; its port)."""
    secrets_ = json.load(open(os.path.join(data, "postgres", "secrets")))
    port = int(open(os.path.join(data, "postgres", "data", "postmaster.pid")).read().splitlines()[3])
    return {r: "postgres://%s:%s@127.0.0.1:%d/visit" % ("postgres" if r == "superuser" else r, secrets_[r], port) for r in secrets_}


def sql(url, q, *params):
    with psycopg.connect(url, autocommit=True) as c:
        cur = c.execute(q, params or None)
        return cur.fetchall() if cur.description else None


def refused(url, q):
    try:
        sql(url, q)
        return "allowed"
    except psycopg.Error as e:
        return type(e).__name__


def postgres_running():
    """How many processes here are Postgres' (its server and its backends), from /proc."""
    n = 0
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            if open("/proc/%s/cmdline" % pid, "rb").read().split(b"\0")[0].endswith(b"/postgres"):
                n += 1
        except OSError:
            pass
    return n


def until(f, timeout=5.0):
    end = time.time() + timeout
    while True:
        v = f()
        if v or time.time() > end:
            return v
        time.sleep(0.1)


def main():
    print("\nthe terminal's commands, on a workroom no visit runs yet: its database made for them")
    code, out, err = run("user", "add", "aldo", "--password-stdin", stdin="too short\n")
    check("user add, the first command: the database made; a short password refused", (code, "at least 12" in err, os.path.isfile(os.path.join(DATA, "postgres", "data", "PG_VERSION"))), (1, True, True))
    check("user add, typed with no terminal to type in: refused, saying so", "no terminal" in run("user", "add", "aldo")[2], True)
    check("user add aldo", run("user", "add", "aldo", "--password-stdin", stdin=PASSWORD + "\n")[:2], (0, "aldo can sign in now\n"))
    check("user add Aldo again: there is one", run("user", "add", "Aldo", "--password-stdin", stdin=PASSWORD + "\n")[0], 1)
    check("a name with a space refused", run("user", "add", "a b", "--password-stdin", stdin=PASSWORD + "\n")[0], 1)
    code, out, err = run("user", "list")
    check("user list", (code, out.splitlines()[0].split(), out.splitlines()[1].split()[0]), (0, ["USER", "MADE", "PASSWORD", "CHANGED", "SESSIONS"], "aldo"))
    code, key, err = run("key", "add", "ci")
    key = key.strip()
    check("key add ci: a key, printed once", (code, key.startswith("bvk_"), len(key)), (0, True, 47))
    check("key add ci again: a live one has that label", run("key", "add", "ci")[0], 1)
    check("no Postgres left running after them", postgres_running(), 0)
    check("which workroom, said when nothing says it", (lambda r: (r.returncode, "VISIT_DATA_DIR" in r.stderr))(
        subprocess.run([VISIT, "auth", "user", "list"], capture_output=True, text=True, env={k: v for k, v in os.environ.items() if k not in ("VISIT_DATA_DIR", "VISIT_NAME")})), (2, True))

    print("\nvisit running: its database, its roles apart")
    server, token, vtoken = start(DATA, 17401, 7403)
    short = wide = None
    try:
        u = urls(DATA)
        roles = dict(sql(u["superuser"], "SELECT rolname::text, rolsuper FROM pg_roles WHERE rolname IN ('postgres', 'visit', 'auth')"))
        check("the superuser, and visit and auth as plain roles", roles, {"postgres": True, "visit": False, "auth": False})
        check("each schema its own role's", sorted(sql(u["superuser"], "SELECT tablename::text, tableowner::text FROM pg_tables WHERE tablename IN ('bans', 'messages', 'users', 'api_keys')")),
              [("api_keys", "auth"), ("bans", "visit"), ("messages", "visit"), ("users", "auth")])
        check("visit's role cannot read auth's tables", refused(u["visit"], "SELECT * FROM auth.users"), "InsufficientPrivilege")
        check("nor auth's visit's", refused(u["auth"], "SELECT * FROM visit.bans"), "InsufficientPrivilege")
        check("nor make tables in public", refused(u["visit"], "CREATE TABLE public.x (y int)"), "InsufficientPrivilege")
        check("the hash kept: Argon2id at OWASP's parameters", sql(u["auth"], "SELECT left(password_hash, 31) FROM auth.users"), [("$argon2id$v=19$m=19456,t=2,p=1$",)])
        check("only the key's hash kept", sql(u["auth"], "SELECT key_hash FROM auth.api_keys"), [(hashlib.sha256(key.encode()).digest(),)])
        here = socket.gethostbyname(socket.gethostname())   # this container's address on its network
        check("Postgres on 127.0.0.1 only: nothing answers on this container's network", refused(u["visit"].replace("127.0.0.1", here), "SELECT 1"), "OperationalError")
        code, out, err = run("user", "list")
        check("a command while visit runs: on its database (nothing started)", (code, "aldo" in out), (0, True))
        r = subprocess.run([VISIT, "--lobby", "ws://127.0.0.1:9/", "--name", "Auth Test", "--port", "17409", "--token-file", DATA + ".visit-token", "--data-dir", DATA],
                           capture_output=True, text=True, timeout=30)
        check("a second visit for the workroom: refused", (r.returncode, "running already" in r.stderr), (5, True))

        print("\nthe API, as a workroom's server calls it")
        api = lambda path, body=None, tok=token, port=7403: call(port, path, body, tok)
        check("GET /health: up, its version", until(lambda: api("/health")[0] == 200 and api("/health")[1].get("ok")), True)
        check("a call without the service token: refused", api("/v1/check", {"session": "x"}, tok=None), (401, {"error": "service_token"}))
        check("with another: refused", api("/v1/check", {"session": "x"}, tok="0" * 64), (401, {"error": "service_token"}))
        check("a body that is not JSON: 400", call(7403, "/v1/check", b"nope", token), (400, {"error": "bad_request"}))
        client = {"address": "203.0.113.7", "agent": "e2e"}

        t = time.time(); wrong = api("/v1/login", {"user": "aldo", "password": "not the password", "client": client}); t_wrong = time.time() - t
        t = time.time(); nobody = api("/v1/login", {"user": "nobody", "password": "not the password", "client": client}); t_nobody = time.time() - t
        check("a wrong password, and an unknown name: the same answer", (wrong, nobody), ((401, {"error": "wrong_login"}),) * 2)
        check("...in about the same time (a hash checked either way)", 0.4 < t_nobody / max(t_wrong, 1e-6) < 2.5 and t_wrong > 0.01, True)
        code, b = api("/v1/login", {"user": "ALDO", "password": PASSWORD, "client": client})
        session = b.get("session", "")
        check("signing in (the name as typed, any case): a session for aldo, 30 days at most", (code, b.get("user"), len(session), abs(b.get("expires", 0) - (time.time() + 30 * 86400)) < 60), (200, "aldo", 43, True))
        check("kept by its SHA-256 only, with where it came from", sql(u["auth"], "SELECT id_hash, client_address, user_agent FROM auth.sessions"),
              [(hashlib.sha256(session.encode()).digest(), "203.0.113.7", "e2e")])
        check("/v1/check: whose it is", api("/v1/check", {"session": session}), (200, {"user": "aldo"}))
        check("a session nobody made: 401", api("/v1/check", {"session": "A" * 43}), (401, {"error": "no_session"}))
        check("the API key: its label", api("/v1/check", {"key": key}), (200, {"key": "ci"}))
        check("a key nobody made: 401", api("/v1/check", {"key": "bvk_" + "A" * 43}), (401, {"error": "no_key"}))
        check("/v1/visit: this visit's own port and page token", api("/v1/visit", {"session": session}), (200, {"port": 17401, "token": vtoken}))
        check("for no session: 401", api("/v1/visit", {"session": "A" * 43}), (401, {"error": "no_session"}))

        check("/v1/logout", api("/v1/logout", {"session": session}), (200, {}))
        check("the session over", (api("/v1/check", {"session": session})[0], sql(u["auth"], "SELECT count(*) FROM auth.sessions")), (401, [(0,)]))

        s2 = api("/v1/login", {"user": "aldo", "password": PASSWORD, "client": client})[1]["session"]
        code, out, err = run("sessions")
        prefix = hashlib.sha256(s2.encode()).hexdigest()[:10]
        check("visit auth sessions: the session, by its hash's start, from where; the last sign-ins tried",
              (code, prefix in out, "203.0.113.7" in out, "the last sign-ins tried" in out, "wrong" in out), (0, True, True, True, True))
        check("revoke <it>", run("revoke", prefix)[:2], (0, "1 session ended\n"))
        check("...and the running visit knows at once", until(lambda: api("/v1/check", {"session": s2})[0] == 401, 3), True)

        s3 = api("/v1/login", {"user": "aldo", "password": PASSWORD, "client": client})[1]["session"]
        check("passwd: a new password, the user's sessions ended", run("passwd", "aldo", "--password-stdin", stdin=NEW_PASSWORD + "\n")[:2], (0, "aldo's password changed; 1 session ended\n"))
        check("...at once", until(lambda: api("/v1/check", {"session": s3})[0] == 401, 3), True)
        check("the old password no longer signs in", api("/v1/login", {"user": "aldo", "password": PASSWORD})[0], 401)
        check("the new one does", api("/v1/login", {"user": "aldo", "password": NEW_PASSWORD})[0], 200)

        check("key revoke ci", run("key", "revoke", "ci")[0], 0)
        check("...and the key is refused at once", until(lambda: api("/v1/check", {"key": key})[0] == 401, 3), True)
        code, out, err = run("key", "list")
        check("key list: it, revoked", (code, "ci" in out, "revoked" in out), (0, True, True))

        print("\nguessing, slowed")
        guess = {"address": "198.51.100.9"}
        for i in range(5):
            api("/v1/login", {"user": "aldo", "password": "guess %d" % i, "client": guess})
        code, b = api("/v1/login", {"user": "aldo", "password": "guess 5", "client": guess})
        check("five wrong in 15 minutes: the sixth waits (429), told how long", (code, b.get("error"), b.get("retry_after")), (429, "wait", 1))
        time.sleep(1.1)
        check("after it, a try (wrong again)", api("/v1/login", {"user": "aldo", "password": "guess 6", "client": guess})[0], 401)
        code, b = api("/v1/login", {"user": "aldo", "password": NEW_PASSWORD, "client": guess})
        check("the next waits twice as long, even with the right password", (code, b.get("retry_after")), (429, 2))
        check("from elsewhere, the name too is slowed", api("/v1/login", {"user": "aldo", "password": NEW_PASSWORD, "client": {"address": "192.0.2.1"}})[0], 429)
        time.sleep(2.1)
        check("waited: the right password signs in", api("/v1/login", {"user": "aldo", "password": NEW_PASSWORD, "client": guess})[0], 200)
        check("and that starts the count again", api("/v1/login", {"user": "aldo", "password": "one more wrong", "client": guess})[0], 401)
        spray = {"address": "198.51.100.77"}
        for i in range(5):
            api("/v1/login", {"user": "user%d" % i, "password": "spray", "client": spray})
        check("five names guessed from one address: that address waits", api("/v1/login", {"user": "aldo", "password": NEW_PASSWORD, "client": spray})[0], 429)
        check("every try kept: signed in, wrong, too soon", sorted(sql(u["auth"], "SELECT ok, waited, count(*) > 0 FROM auth.login_attempts GROUP BY 1, 2")),
              [(False, False, True), (False, True, True), (True, False, True)])

        # In a container, beside a workroom's server in another: its container's own network (--auth-listen 0.0.0.0).
        check("by default on 127.0.0.1 only: nothing answers on this container's network", call(7403, "/health", None, None, host=here)[0], 0)
        wide_data = os.path.join(TMP, "wide")
        wide, wtoken, _ = start(wide_data, 17406, 7406, "--auth-listen", "0.0.0.0")
        check("--auth-listen 0.0.0.0: on this container's network too, where another container reaches it",
              until(lambda: call(7406, "/health", None, None, host=here)[0] == 200), True)
        check("...its service token still asked there", call(7406, "/v1/check", {"session": "x"}, None, host=here), (401, {"error": "service_token"}))

        print("\na session's two ends: unused, and in all")
        short_data = os.path.join(TMP, "short")
        run("user", "add", "aldo", "--password-stdin", data=short_data, stdin=NEW_PASSWORD + "\n")
        short, stoken, _ = start(short_data, 17404, 7404, "--auth-idle", "2s", "--auth-max-age", "5s")
        s4 = call(7404, "/v1/login", {"user": "aldo", "password": NEW_PASSWORD}, stoken)[1]["session"]
        check("signed in (2 s unused ends it)", call(7404, "/v1/check", {"session": s4}, stoken)[0], 200)
        time.sleep(2.3)
        check("unused 2 s: over", call(7404, "/v1/check", {"session": s4}, stoken), (401, {"error": "no_session"}))
        s5 = call(7404, "/v1/login", {"user": "aldo", "password": NEW_PASSWORD}, stoken)[1]["session"]
        alive = []
        for _ in range(6):
            alive.append(call(7404, "/v1/check", {"session": s5}, stoken)[0])
            time.sleep(1.0)
        check("used every second: alive until its 5 s are up, then over", (alive[:4], alive[-1]), ([200] * 4, 401))

        print("\na workroom moved over from another database: visit import")
        imported = os.path.join(TMP, "imported")
        old = urls(short_data)["superuser"]   # the short-lived workroom's, running: as a 1.x Visit's database would be
        r = subprocess.run([VISIT, "import", "--data-dir", imported, old], capture_output=True, text=True, timeout=120)
        check("visit import <the old database>: done, saying what came", (r.returncode, "accounts: 1" in r.stdout, "imported" in r.stdout), (0, True, True))
        code, out, err = run("user", "list", data=imported)
        check("its account here now", (code, "aldo" in out), (0, True))
        r = subprocess.run([VISIT, "import", "--data-dir", imported, old], capture_output=True, text=True, timeout=120)
        check("again, into a workroom with data: refused", (r.returncode, "has data already" in r.stderr), (1, True))
        r = subprocess.run([VISIT, "import", "--data-dir", os.path.join(TMP, "imported2"), "postgres://nobody:x@127.0.0.1:1/visit"], capture_output=True, text=True, timeout=120)
        check("from a database it cannot read: said, nothing changed", (r.returncode, "reading the old database" in r.stderr), (1, True))

        s6 = api("/v1/login", {"user": "aldo", "password": NEW_PASSWORD})[1]["session"]
        code, out, err = run("user", "remove", "aldo")
        check("user remove aldo: signed out everywhere", (code, until(lambda: api("/v1/check", {"session": s6})[0] == 401, 3), sql(u["auth"], "SELECT count(*) FROM auth.sessions")), (0, True, [(0,)]))
    finally:
        for p in (server, short, wide):
            if p:
                p.terminate()
                p.wait(15)
    check("visit stopped: its Postgres with it", postgres_running(), 0)
    print("\n%d failure(s)" % len(failures))
    sys.exit(1 if failures else 0)


def call(port, path, body, token, host="127.0.0.1"):
    """(status, JSON) from the sign-in API, as a workroom's server asks it; 0 when nothing answers there."""
    data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request("http://%s:%d%s" % (host, port, path), data=data, method="POST" if data is not None else "GET")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")
    except (urllib.error.URLError, ConnectionError):
        return 0, {}


if __name__ == "__main__":
    main()
