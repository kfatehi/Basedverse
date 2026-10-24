# The lobby server: one Python process, state in memory. Caddy (lobby/deploy) puts TLS in front of it.
FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY lobby.py .
USER nobody
EXPOSE 8765
CMD ["python", "-u", "lobby.py"]
