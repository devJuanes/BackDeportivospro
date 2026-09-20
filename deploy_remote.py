"""Deploy via Cloudflare SSH tunnel. Usage (PowerShell):
  $env:MATUBYTE_SSH_PASSWORD='...'
  python deploy_remote.py
"""
import os
import subprocess
import sys
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 2222
USER = "matubyte"
REMOTE = "~/apps/BackDeportivospro"
PM2_APP = "backdeportivospro"

FILES = [
    "package.json",
    "src/controllers/factoryController.js",
    "src/database/migrateFactory.js",
    "src/jobs/liveMonitor.js",
    "src/jobs/scrapingJobs.js",
    "src/models/liveModel.js",
    "src/models/vipModel.js",
    "src/routes/factoryRoutes.js",
    "src/services/factoryService.js",
    "src/services/liveSettlementService.js",
    "src/services/pickSettlementService.js",
    "src/services/productionPublishService.js",
    "src/utils/matchSchedule.js",
    "src/utils/playStoreSafe.js",
    "src/scripts/backfillProduction.js",
    "src/services/factoryLockService.js",
    "src/services/predictionNotifyService.js",
    "src/services/telegramService.js",
]


def connect():
    pwd = os.environ.get("MATUBYTE_SSH_PASSWORD")
    if not pwd:
        print("Set MATUBYTE_SSH_PASSWORD env var", file=sys.stderr)
        sys.exit(1)

    # Windows: Paramiko ProxyCommand falla; usamos túnel TCP local con cloudflared.
    tunnel = subprocess.Popen(
        [
            "cloudflared",
            "access",
            "tcp",
            "--hostname",
            "ssh.logsfm.com",
            "--url",
            f"127.0.0.1:{PORT}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(4)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(HOST, port=PORT, username=USER, password=pwd, timeout=120)
    except Exception:
        tunnel.terminate()
        raise
    client._deploy_tunnel = tunnel  # noqa: SLF001
    return client


def run(client, cmd, timeout=300):
    print(f"\n>>> {cmd}")
    _, stdout, stderr = client.exec_command(f"cd {REMOTE} && {cmd}", timeout=timeout)
    out = stdout.read().decode()
    err = stderr.read().decode()
    code = stdout.channel.recv_exit_status()
    if out:
        print(out.rstrip())
    if err:
        print(err.rstrip(), file=sys.stderr)
    if code != 0:
        raise SystemExit(f"Command failed ({code}): {cmd}")
    return out


def upload(client):
    sftp = client.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        if not local.exists():
            print(f"Skip missing {rel}")
            continue
        remote = f"/home/{USER}/apps/BackDeportivospro/{rel.replace(chr(92), '/')}"
        remote_dir = os.path.dirname(remote)
        try:
            sftp.stat(remote_dir)
        except OSError:
            pass
        print(f"Upload {rel}")
        sftp.put(str(local), remote)
    sftp.close()


def main():
    client = connect()
    try:
        run(client, "git status -sb && git log -1 --oneline", timeout=60)
        upload(client)
        run(client, "npm install --omit=dev", timeout=600)
        run(client, "npm run db:migrate", timeout=300)
        run(client, "npm run backfill", timeout=600)
        run(client, f"pm2 restart {PM2_APP}", timeout=120)
        run(client, "pm2 list", timeout=60)
        print("\nDeploy OK")
    finally:
        tunnel = getattr(client, "_deploy_tunnel", None)
        client.close()
        if tunnel:
            tunnel.terminate()


if __name__ == "__main__":
    main()
