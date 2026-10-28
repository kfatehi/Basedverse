"""auth-client against real Postgres (run-e2e.sh starts them): the roles made, and a 0.20 database moved over; the
terminal's commands; and the API, as a workroom's server calls it.

  python3 e2e.py <auth-client> <visit-client>
"""
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

import psycopg

AUTH, VISIT = sys.argv[1], sys.argv[2]
OLD_ADMIN = "postgres://visit:old-password-0.20-setup@old/visit"   # 0.20's VISIT_DATABASE_URL: the superuser itself
NEW_ADMIN = "postgres://basedverse:a-new-admin-password@old/visit"
OLD_VISIT, OLD_AUTH = "postgres://visit:visit-password-0123456789@old/visit", "postgres://auth:auth-password-0123456789@old/visit"
FRESH_ADMIN = "postgres://basedverse:admin-password-fresh@new/visit"
VISIT_URL, AUTH_URL = "postgres://visit:visit-password-abcdefghij@new/visit", "postgres://auth:auth-password-abcdefghij@new/visit"
PASSWORD, NEW_PASSWORD = "correct horse battery staple", "a whole new password, longer"
failures = []


def check(what, got, want):
    if got == want:
        print("ok    " + what, flush=True)
    else:
        failures.append(what)
        print("FAIL  %s\n      got  %r\n      want %r" % (what, got, want), flush=True)


def run(*args, env=None, stdin=None):
    """auth-client (or visit-client, given first): (exit code, stdout, stderr)."""
    cmd = list(args) if args[0] in (AUTH, VISIT) else [AUTH, *args]
    r = subprocess.run(cmd, env={**os.environ, **(env or {})}, input=stdin, capture_output=True, text=True,
                       stdin=None if stdin is not None else subprocess.DEVNULL, timeout=60)
    return r.returncode, r.stdout, r.stderr


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


def until(f, timeout=5.0):
    end = time.time() + timeout
    while True:
        v = f()
        if v or time.time() > end:
            return v
        time.sleep(0.1)


def main():
    print("\na database as 0.20's setup made it: visit-client on the superuser, its tables in public")
    code, out, err = run(VISIT, "migrate", "--database", OLD_ADMIN)
    check("visit-client 0.20 made its tables", code, 0)
    sql(OLD_ADMIN, "INSERT INTO bans (key, name, voice, chat, at) VALUES ('k1', 'Mallory', true, false, 1)")
    env = {"AUTH_DATABASE_URL": OLD_AUTH, "VISIT_DATABASE_URL": OLD_VISIT}
    code, out, err = run("migrate", "--admin", OLD_ADMIN, env=env)
    check("migrate --admin, visit-client on the superuser and no --new-admin: refused, saying what to give", (code, "--new-admin" in err), (1, True))
    code, out, err = run("migrate", "--admin", OLD_ADMIN, "--new-admin", NEW_ADMIN, env=env)
    check("with --new-admin: done", (code, err), (0, ""))
    print("      " + out.strip().replace("\n", "\n      "))
    roles = dict(sql(NEW_ADMIN, "SELECT rolname::text, rolsuper FROM pg_roles WHERE rolname IN ('visit', 'auth', 'basedverse') OR rolname LIKE 'auth_setup_%'"))
    check("the superuser is basedverse now; visit and auth are plain roles; the role of the moment gone", roles, {"basedverse": True, "visit": False, "auth": False})
    check("the old URL (the superuser's, which visit-client held) no longer gets in", refused(OLD_ADMIN, "SELECT 1"), "OperationalError")
    check("visit-client's tables moved into its schema, its own", sorted(sql(NEW_ADMIN, "SELECT tablename::text, tableowner::text FROM pg_tables WHERE schemaname IN ('public', 'visit') AND tablename IN ('bans', 'messages', 'visit_migrations')")),
          [("bans", "visit"), ("messages", "visit"), ("visit_migrations", "visit")])
    check("what was in them kept: visit-client's role reads its ban", sql(OLD_VISIT, "SELECT name FROM bans"), [("Mallory",)])
    code, out, err = run(VISIT, "migrate", "--status", "--database", OLD_VISIT)
    check("visit-client, on its plain role: its schema up to date", (code, "up to date" in out), (0, True))
    check("visit-client's role cannot read auth-client's tables", refused(OLD_VISIT, "SELECT * FROM auth.users"), "InsufficientPrivilege")
    check("nor auth-client's visit-client's", refused(OLD_AUTH, "SELECT * FROM visit.bans"), "InsufficientPrivilege")
    check("nor make tables in public", refused(OLD_VISIT, "CREATE TABLE public.x (y int)"), "InsufficientPrivilege")
    code, out, err = run("migrate", "--admin", NEW_ADMIN, env=env)
    check("run again (the superuser on its own now): changes nothing but passwords", (code, "plain, its password set" in out), (0, True))

    print("\na fresh database: its superuser for setup only")
    env = {"AUTH_DATABASE_URL": AUTH_URL, "VISIT_DATABASE_URL": VISIT_URL}
    code, out, err = run("migrate", "--admin", FRESH_ADMIN, env=env)
    check("migrate --admin: the roles made, auth-client's schema ready", (code, "role visit: made" in out, "applied: 1 auth" in out), (0, True, True))
    code, out, err = run(VISIT, "migrate", "--database", VISIT_URL)
    check("visit-client migrates as its plain role: its tables in its schema", (code, sql(FRESH_ADMIN, "SELECT schemaname::text FROM pg_tables WHERE tablename = 'messages'")), (0, [("visit",)]))
    code, out, err = run("migrate", "--status", env=env)
    check("auth-client migrate --status: up to date", (code, "up to date" in out), (0, True))
    code, out, err = run("user", "list", env={"AUTH_DATABASE_URL": FRESH_ADMIN.replace("/visit", "/postgres")})
    check("a database it has not made ready: exit 5, saying to migrate", (code, "auth-client migrate" in err), (5, True))

    print("\nthe terminal's commands")
    env = {"AUTH_DATABASE_URL": AUTH_URL}
    code, out, err = run("user", "add", "aldo", "--password-stdin", env=env, stdin="too short\n")
    check("user add: a short password refused", (code, "at least 12" in err), (1, True))
    check("user add, typed with no terminal to type in: refused, saying so", "no terminal" in run("user", "add", "aldo", env=env)[2], True)
    check("user add aldo", run("user", "add", "aldo", "--password-stdin", env=env, stdin=PASSWORD + "\n")[:2], (0, "aldo can sign in now\n"))
    check("user add Aldo again: there is one", run("user", "add", "Aldo", "--password-stdin", env=env, stdin=PASSWORD + "\n")[0], 1)
    check("a name with a space refused", run("user", "add", "a b", "--password-stdin", env=env, stdin=PASSWORD + "\n")[0], 1)
    check("the hash kept: Argon2id at OWASP's parameters", sql(AUTH_URL, "SELECT left(password_hash, 31) FROM auth.users"), [("$argon2id$v=19$m=19456,t=2,p=1$",)])
    code, out, err = run("user", "list", env=env)
    check("user list", (code, out.splitlines()[0].split(), out.splitlines()[1].split()[0]), (0, ["USER", "MADE", "PASSWORD", "CHANGED", "SESSIONS"], "aldo"))
    code, key, err = run("key", "add", "ci", env=env)
    key = key.strip()
    check("key add ci: a key, printed once", (code, key.startswith("bvk_"), len(key)), (0, True, 47))
    check("key add ci again: a live one has that label", run("key", "add", "ci", env=env)[0], 1)
    check("only its hash kept", sql(AUTH_URL, "SELECT key_hash FROM auth.api_keys"), [(hashlib.sha256(key.encode()).digest(),)])

    print("\nthe API, as a workroom's server calls it")
    token = os.urandom(32).hex()
    tdir = tempfile.mkdtemp()
    tfile, vfile = os.path.join(tdir, "auth-token"), os.path.join(tdir, "visit-token")
    with open(tfile, "w") as f:
        f.write(token + "\n")
    os.chmod(tfile, 0o600)
    server = subprocess.Popen([AUTH, "--port", "7403", "--token-file", tfile, "--visit-port", "17401", "--visit-token-file", vfile],
                              env={**os.environ, "AUTH_DATABASE_URL": AUTH_URL, "AUTH_LOG": "warn"})
    short = None
    try:
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
        check("kept by its SHA-256 only, with where it came from", sql(AUTH_URL, "SELECT id_hash, client_address, user_agent FROM auth.sessions"),
              [(hashlib.sha256(session.encode()).digest(), "203.0.113.7", "e2e")])
        check("/v1/check: whose it is", api("/v1/check", {"session": session}), (200, {"user": "aldo"}))
        check("a session nobody made: 401", api("/v1/check", {"session": "A" * 43}), (401, {"error": "no_session"}))
        check("the API key: its label", api("/v1/check", {"key": key}), (200, {"key": "ci"}))
        check("a key nobody made: 401", api("/v1/check", {"key": "bvk_" + "A" * 43}), (401, {"error": "no_key"}))

        check("/v1/visit, no visit-client's token file: 404", api("/v1/visit", {"session": session}), (404, {"error": "no_visit_client"}))
        with open(vfile, "w") as f:
            f.write("ab" * 32 + "\n")
        check("its file there, but nothing on its port: 404", api("/v1/visit", {"session": session}), (404, {"error": "no_visit_client"}))
        lsock = socket.socket(); lsock.bind(("127.0.0.1", 17401)); lsock.listen()
        threading.Thread(target=lambda: [lsock.accept()[0].close() for _ in range(5)], daemon=True).start()
        check("visit-client running: its port and token, read fresh", api("/v1/visit", {"session": session}), (200, {"port": 17401, "token": "ab" * 32}))
        check("for no session: 401", api("/v1/visit", {"session": "A" * 43}), (401, {"error": "no_session"}))

        check("/v1/logout", api("/v1/logout", {"session": session}), (200, {}))
        check("the session over", (api("/v1/check", {"session": session})[0], sql(AUTH_URL, "SELECT count(*) FROM auth.sessions")), (401, [(0,)]))

        s2 = api("/v1/login", {"user": "aldo", "password": PASSWORD, "client": client})[1]["session"]
        code, out, err = run("sessions", env=env)
        prefix = hashlib.sha256(s2.encode()).hexdigest()[:10]
        check("auth-client sessions: the session, by its hash's start, from where; the last sign-ins tried",
              (code, prefix in out, "203.0.113.7" in out, "the last sign-ins tried" in out, "wrong" in out), (0, True, True, True, True))
        check("revoke <it>", run("revoke", prefix, env=env)[:2], (0, "1 session ended\n"))
        check("...and the running auth-client knows at once", until(lambda: api("/v1/check", {"session": s2})[0] == 401, 3), True)

        s3 = api("/v1/login", {"user": "aldo", "password": PASSWORD, "client": client})[1]["session"]
        check("passwd: a new password, the user's sessions ended", run("passwd", "aldo", "--password-stdin", env=env, stdin=NEW_PASSWORD + "\n")[:2], (0, "aldo's password changed; 1 session ended\n"))
        check("...at once", until(lambda: api("/v1/check", {"session": s3})[0] == 401, 3), True)
        check("the old password no longer signs in", api("/v1/login", {"user": "aldo", "password": PASSWORD})[0], 401)
        check("the new one does", api("/v1/login", {"user": "aldo", "password": NEW_PASSWORD})[0], 200)

        check("key revoke ci", run("key", "revoke", "ci", env=env)[0], 0)
        check("...and the key is refused at once", until(lambda: api("/v1/check", {"key": key})[0] == 401, 3), True)
        code, out, err = run("key", "list", env=env)
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
        check("every try kept: signed in, wrong, too soon", sorted(sql(AUTH_URL, "SELECT ok, waited, count(*) > 0 FROM auth.login_attempts GROUP BY 1, 2")),
              [(False, False, True), (False, True, True), (True, False, True)])

        print("\na session's two ends: unused, and in all")
        short = subprocess.Popen([AUTH, "--port", "7404", "--token-file", tfile, "--idle", "2s", "--max-age", "5s"],
                                 env={**os.environ, "AUTH_DATABASE_URL": AUTH_URL, "AUTH_LOG": "warn"})
        until(lambda: call(7404, "/health", None, None)[0] == 200)
        s4 = call(7404, "/v1/login", {"user": "aldo", "password": NEW_PASSWORD}, token)[1]["session"]
        check("signed in (2 s unused ends it)", call(7404, "/v1/check", {"session": s4}, token)[0], 200)
        time.sleep(2.3)
        check("unused 2 s: over", call(7404, "/v1/check", {"session": s4}, token), (401, {"error": "no_session"}))
        s5 = call(7404, "/v1/login", {"user": "aldo", "password": NEW_PASSWORD}, token)[1]["session"]
        alive = []
        for _ in range(6):
            alive.append(call(7404, "/v1/check", {"session": s5}, token)[0])
            time.sleep(1.0)
        check("used every second: alive until its 5 s are up, then over", (alive[:4], alive[-1]), ([200] * 4, 401))

        code, out, err = run("user", "remove", "aldo", env=env)
        check("user remove aldo: signed out everywhere", (code, until(lambda: api("/v1/check", {"session": s5})[0] == 401, 3), sql(AUTH_URL, "SELECT count(*) FROM auth.sessions")), (0, True, [(0,)]))
    finally:
        for p in (server, short):
            if p:
                p.terminate()
                p.wait(5)
    print("\n%d failure(s)" % len(failures))
    sys.exit(1 if failures else 0)


def call(port, path, body, token):
    """(status, JSON) from auth-client on 127.0.0.1, as a workroom's server asks it."""
    data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=data, method="POST" if data is not None else "GET")
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
