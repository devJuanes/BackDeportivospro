"""Deploy admin API + factory settle power to api.picks.matupicks.app."""
import os
import sys
from pathlib import Path

import paramiko

HOST = "13.140.160.248"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"
ROOT = Path(__file__).resolve().parent.parent

FILES = [
    "src/app.js",
    "src/routes/adminRoutes.js",
    "src/controllers/adminController.js",
    "src/controllers/factoryController.js",
    "src/services/factoryService.js",
    "src/services/pickSettlementService.js",
    "src/services/liveSettlementService.js",
    "src/utils/preserveSettledOutcome.js",
    "src/utils/liveScoreMatch.js",
    "src/database/migrateFactory.js",
    "src/database/admin_ops.sql",
    "src/database/app_modal_campaigns.sql",
    "src/database/vip_requests.sql",
    "src/controllers/vipRequestController.js",
    "src/routes/vipRequestRoutes.js",
]


def run(c, cmd, timeout=180):
    print(">>>", cmd[:160].encode("ascii", "replace").decode("ascii"))
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
    c.connect(HOST, username="root", password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)
    sftp = c.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        if not local.exists():
            print("SKIP missing", rel)
            continue
        remote = f"{APP}/{rel}"
        remote_dir = "/".join(remote.split("/")[:-1])
        try:
            sftp.stat(remote_dir)
        except OSError:
            run(c, f"mkdir -p {remote_dir}")
        sftp.put(str(local), remote)
        print("uploaded", rel)
    sftp.close()

    run(
        c,
        f"""cd {APP}
node -e "require('dotenv').config(); require('./src/database/migrateFactory').runFactoryMigrations().then(()=>console.log('migrate ok')).catch(e=>{{console.error(e);process.exit(1)}})"
pm2 restart backdeportivospro --update-env
sleep 5
curl -fsS http://127.0.0.1:3009/health; echo
curl -fsS -o /tmp/admin_me.json -w "%{{http_code}}" http://127.0.0.1:3009/api/admin/me; echo
cat /tmp/admin_me.json; echo
""",
        240,
    )
    c.close()
    print("DEPLOY_ADMIN_OK")


if __name__ == "__main__":
    main()
