"""Deploy fix: re-settle ended+pending live tips; stop leaving pending forever."""
import os
import sys
from pathlib import Path

import paramiko

HOST = "13.140.160.248"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"
ROOT = Path(__file__).resolve().parent.parent

FILES = [
    "src/models/liveModel.js",
    "src/services/liveSettlementService.js",
    "src/services/pickSettlementService.js",
    "src/utils/preserveSettledOutcome.js",
    "src/scripts/repairSettledOutcomes.js",
]


def run(c, cmd, timeout=300):
    print(">>>", cmd[:200].encode("ascii", "replace").decode("ascii"))
    _, out, err = c.exec_command(cmd, timeout=timeout, get_pty=True)
    text = (out.read() + err.read()).decode("utf-8", errors="replace")
    code = out.channel.recv_exit_status()
    print(text[-6000:].encode("ascii", "replace").decode("ascii"))
    if code != 0:
        raise SystemExit(f"exit {code}")
    return text


def main():
    if not PASSWORD:
        sys.exit("DEPLOY_SSH_PASSWORD required")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username="root", password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)
    sftp = c.open_sftp()
    for rel in FILES:
        sftp.put(str(ROOT / rel), f"{APP}/{rel}")
        print("uploaded", rel)
    sftp.close()
    run(
        c,
        f"""cd {APP}
pm2 restart backdeportivospro --update-env
sleep 6
curl -fsS http://127.0.0.1:3009/health; echo
node src/scripts/repairSettledOutcomes.js
""",
        360,
    )
    c.close()
    print("DEPLOY_RESETTLE_OK")


if __name__ == "__main__":
    main()
