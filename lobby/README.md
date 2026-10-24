# The lobby — knock on other sims' offices

A meeting place for agent-office sims of any make. Each sim joins under a name, sees who else is online
and whether they are `available`, knocks on an available office with a message, and once let in, every
office in the group sees every other office's room as live video. The video goes peer to peer over
WebRTC; the lobby only introduces the sims.

- **[PROTOCOL.md](PROTOCOL.md)** — the contract, complete: hand it to anyone (or any LLM) building a
  compatible sim.
- **[server/](server/)** — the lobby: `lobby.py` (Python, `websockets`), `test_lobby.py`, a Dockerfile.
- **[deploy/](deploy/)** — one server on the internet: the lobby, Caddy (TLS with a free Let's Encrypt
  certificate, for a bare IP address too) and coturn (a TURN relay for networks that block peer to
  peer), started by `setup.sh`.

## Try it locally (no server needed)

```sh
python3 -m venv /tmp/lobby-venv && /tmp/lobby-venv/bin/pip install -r lobby/server/requirements.txt
STUN_URLS= LOBBY_HOST=127.0.0.1 /tmp/lobby-venv/bin/python lobby/server/lobby.py      # ws://127.0.0.1:8765
```

Then point two sims at `ws://127.0.0.1:8765`, knock from one, and let it in from the other.

Tests: `python3 lobby/server/test_lobby.py` (the server, every message and refusal).

## Put it on AWS

1. **Launch an EC2 instance**: Ubuntu 24.04 (or Amazon Linux 2023), `t3.small` or `t4g.small`, 8 GB disk.
2. **Give it an Elastic IP** (EC2 → Elastic IPs → Allocate → Associate), so the address in everyone's
   `.env` survives a stop and start.
3. **Open its security group** to the internet:

   | port | protocol | for |
   |---|---|---|
   | 22 | TCP | ssh (your address only) |
   | 80, 443 | TCP | Caddy: the certificate challenge, then `wss://` |
   | 3478 | TCP and UDP | TURN / STUN |
   | 49160–49200 | UDP | TURN's relayed media |

4. **Copy the lobby there and run the setup:**

   ```sh
   scp -r lobby ubuntu@<elastic-ip>:~/
   ssh ubuntu@<elastic-ip> ~/lobby/deploy/setup.sh
   ```

   It installs Docker, writes `deploy/.env` (the instance's public and private addresses from the EC2
   metadata, and a fresh TURN secret), starts the lobby, Caddy and coturn, waits for the certificate,
   and prints the line for your `.env`:

   ```
   LOBBY_URL=wss://<elastic-ip>/
   ```

   With a DNS name pointing at the instance, run `LOBBY_HOST=lobby.example.com ./setup.sh` instead.
5. **Point the sims at it**: each gives `wss://<elastic-ip>/` as its lobby.

**Running it.** `cd ~/lobby/deploy && docker compose logs -f` (all three), `docker compose restart`,
`docker compose down`. After copying a new `lobby/`, run `./setup.sh` again: it keeps its `.env` and
rebuilds. A restart empties the lobby; the sims reconnect by themselves.

**What it costs.** The instance (a `t4g.small` is about $12 a month) and its traffic. Video goes
straight between the sims whenever their networks allow, at no cost to the server. Only when one blocks
that does TURN relay it: about 0.7 GB per hour per relayed stream at 1.5 Mbit/s, which is roughly 6¢ an
hour at AWS's internet egress price.

**The certificate.** Let's Encrypt issues IP-address certificates only under its short-lived profile, so
they last 6 days. Caddy renews them by itself, which is why ports 80 and 443 stay open. If `wss://` stops
working, read `docker compose logs caddy`.

## Trust

Nobody signs in: anyone who reaches the server can join under a free name, see who is online, and knock.
Nothing of your room is visible until you let someone in. Then **everyone in your group sees your room,
and anyone in the group can let more people in**: leave the group, or set yourself `busy`, to stop that.
Whatever your room shows, they see: if it shows your work, so does the video.
