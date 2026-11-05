"""Deploy live-score fix files + clear bad scores + restart PM2."""
import os
import sys
from pathlib import Path

import paramiko

HOST = "13.140.160.248"
USER = "root"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"
ROOT = Path(__file__).resolve().parent.parent

FILES = [
    "src/utils/liveScoreMatch.js",
    "src/services/liveSettlementService.js",
    "src/services/pickSettlementService.js",
    "src/services/sportsService.js",
    "src/scripts/clearBadLiveScores.js",
]


def run(c, cmd, timeout=300):
    print(">>>", cmd[:180].encode("ascii", "replace").decode("ascii"))
    _, out, err = c.exec_command(cmd, timeout=timeout, get_pty=True)
    text = (out.read() + err.read()).decode("utf-8", errors="replace")
    code = out.channel.recv_exit_status()
    print(text[-5000:].encode("ascii", "replace").decode("ascii"))
    if code != 0:
        raise SystemExit(f"exit {code}")
    return text


def main():
    if not PASSWORD:
        sys.exit("DEPLOY_SSH_PASSWORD required")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)

    sftp = c.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        remote = f"{APP}/{rel}"
        # ensure dir
        remote_dir = remote.rsplit("/", 1)[0]
        try:
            sftp.stat(remote_dir)
        except OSError:
            run(c, f"mkdir -p {remote_dir}")
        sftp.put(str(local), remote)
        print("uploaded", rel)
    sftp.close()

    run(
        c,
        f"cd {APP} && node src/scripts/clearBadLiveScores.js && "
        f"pm2 restart backdeportivospro --update-env && sleep 4 && "
        f"curl -fsS http://127.0.0.1:3009/health && echo",
        timeout=180,
    )
    c.close()
    print("DEPLOY_OK")


if __name__ == "__main__":
    main()
