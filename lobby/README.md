# The lobby — knock on other sims' offices

A meeting place for agent-office sims of any make. Each sim joins under a name, sees who else is online
and whether they are `available`, and knocks on an available office with a message. It speaks three
versions side by side, each its own lobby (a client's first hello decides):

- **version 1** ([PROTOCOL.md](PROTOCOL.md)): once let in, every office in the group sees every other
  office's room as live video, peer to peer over WebRTC between the browsers;
- **version 3** ([../visit/SPEC.md](../visit/SPEC.md), section 6): visit-clients (Visit 0.5 on), walking
  around each other's three.js rooms; **version 2**, the same for Visit 0.2 to 0.4 (rooms by video).

Either way the lobby only introduces the sims: what they show each other never passes through it.

- **[PROTOCOL.md](PROTOCOL.md)** — version 1's contract, complete: hand it to anyone (or any LLM)
  building a compatible sim.
- **[server/](server/)** — the lobby: `lobby.py` (Python, `websockets`), `test_lobby.py` and
  `test_lobby2.py`, a Dockerfile.
- **[deploy/](deploy/)** — one server on the internet: the lobby, Caddy (TLS with a free Let's Encrypt
  certificate, for a bare IP address too) and coturn (a TURN relay for networks that block peer to
  peer), started by `setup.sh`.
- **Clients**: for version 2, visit-client ([../visit/](../visit/)); for version 1, your sim's own,
  from PROTOCOL.md.

## Try it locally (no server needed)

```sh
python3 -m venv /tmp/lobby-venv && /tmp/lobby-venv/bin/pip install -r lobby/server/requirements.txt
STUN_URLS= LOBBY_HOST=127.0.0.1 /tmp/lobby-venv/bin/python lobby/server/lobby.py      # ws://127.0.0.1:8765
```

Then point two workrooms at `ws://127.0.0.1:8765` (two visit-clients, as
[../visit/INTEGRATING.md](../visit/INTEGRATING.md) step 8 runs them), knock from one, and let it in from
the other.

Tests: `python3 lobby/server/test_lobby.py` and `python3 lobby/server/test_lobby2.py` (the server, every
message and refusal of each version), and `visit/client/tests/run-e2e.sh` (the server with two real
visit-clients).

## Put it on a server (AWS, say)

1. **Launch an EC2 instance**: Ubuntu 24.04 (or Amazon Linux 2023), `t3.small` or `t4g.small`, 8 GB disk.
2. **Give it an Elastic IP** (EC2 → Elastic IPs → Allocate → Associate), so the address in everyone's
   `.env` survives a stop and start.
3. **Open its security group** to the internet:

   | port | protocol | for |
   |---|---|---|
   | 22 | TCP | ssh (your address only) |
   | 80, 443 | TCP | Caddy: the certificate challenge, then `wss://` |
   | 3478 | TCP and UDP | TURN / STUN |
   | 49160-49200 | UDP | TURN's relayed media |

4. **Deploy it from your machine**, from this repository:

   ```sh
   bin/deploy-lobby ubuntu@<elastic-ip>                  # add -i ~/.ssh/your-key.pem if ssh needs it
   bin/deploy-lobby ubuntu@<elastic-ip> --host lobby.example.com     # a DNS name for the certificate instead
   ```

   It copies `lobby/` to `~/basedverse-lobby/` on the server (a tar stream over ssh: nothing to install
   there first) and runs `lobby/deploy/setup.sh` there. That installs Docker, writes the server's
   `deploy/.env` (its public and private addresses from the EC2 metadata, or, on another server, from
   checkip.amazonaws.com and `hostname -I`, and a fresh TURN secret),
   starts the lobby, Caddy and coturn, waits for the certificate, and prints the address:

   ```
   LOBBY_URL=wss://<elastic-ip>/
   ```

5. **Point the workrooms at it**: each gives `wss://<elastic-ip>/` as its lobby (`VISIT_LOBBY` for a
   visit-client, [../.env.example](../.env.example)).

**Running it**, from your machine. The server is remembered (`LOBBY_DEPLOY` in this repository's `.env`,
made on the first deploy), so:

| command | what it does |
|---|---|
| `bin/deploy-lobby` | update it: copy the current `lobby/` and rebuild. Its `.env` and TURN secret are kept |
| `bin/deploy-lobby --status` | its containers, and whether `wss://…/health` answers from here |
| `bin/deploy-lobby --logs` | the lobby's, Caddy's and coturn's logs, followed (Ctrl-C stops) |
| `bin/deploy-lobby --down` | stop it |

On the server itself it is `docker compose …` in `~/basedverse-lobby/lobby/deploy`. A restart empties the
lobby; the workrooms reconnect by themselves.

**What it costs.** The instance (a `t4g.small` is about $12 a month) and its traffic. Video goes
straight between the sims whenever their networks allow, at no cost to the server. Only when one blocks
that does TURN relay it: about 0.7 GB per hour per relayed stream at 1.5 Mbit/s, which is roughly 6¢ an
hour at AWS's internet egress price. Anyone who connects to the lobby gets TURN credentials, so coturn
relays UDP only, at most 12 relays per office and about 2 Mbit/s each way per relay (`compose.yml`): at
worst its 41 relay ports run flat out at a few dollars an hour. An AWS budget alert on the account is
cheap insurance.

**The certificate.** Let's Encrypt issues IP-address certificates only under its short-lived profile, so
they last 6 days. Caddy renews them by itself, which is why ports 80 and 443 stay open. If `wss://` stops
working, read `docker compose logs caddy`.

## Trust

Nobody signs in: anyone who reaches the server can join under a free name, see who is online, and knock.
Nothing of your room is visible until you let someone in. Then, in version 1, **everyone in your group
sees your room, and anyone in the group can let more people in**: leave the group, or set yourself
`busy`, to stop that. In versions 2 and 3 each visitor is let in by you. In version 3 (and in version 2,
from a three.js room) they are sent your room's scene, all of it: everything under `root`, whether in their
view or not (of objects' `userData`, only what Visit itself reads). In version 3 your guests, with your door open, also watch your
plot (Visit 0.7's worlds): they get the same, without a knock. Whatever your room shows, they see: if it shows your work (issue
titles, what your agents are doing), so does the scene, or the video.
