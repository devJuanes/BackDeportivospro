"""Pull latest api branch + restart PM2 + migrate + wipe news on production."""
import os
import sys
from pathlib import Path

import paramiko

HOST = "13.140.160.248"
USER = "root"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"
ROOT = Path(__file__).resolve().parent.parent


def run(client, cmd, timeout=600):
    print(">>>", cmd[:200])
    _, out, err = client.exec_command(cmd, timeout=timeout, get_pty=True)
    text = (out.read() + err.read()).decode(errors="replace")
    code = out.channel.recv_exit_status()
    print(text[-6000:].encode("ascii", "replace").decode("ascii"))
    if code != 0:
        raise RuntimeError(f"exit {code}: {cmd[:120]}")
    return text


def main():
    if not PASSWORD:
        sys.exit("DEPLOY_SSH_PASSWORD required")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)

    # Upload local .env (with faster crons + multi-sport) but force public URL
    sftp = c.open_sftp()
    local_env = ROOT / ".env"
    if local_env.exists():
        sftp.put(str(local_env), f"{APP}/.env")
        print("uploaded .env")
    sftp.close()

    run(
        c,
        f"cd {APP} && git fetch origin && git checkout api && git pull --ff-only origin api && "
        f"mkdir -p data/news/images logs && "
        f"sed -i 's|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://api.picks.matupicks.app|' .env && "
        f"grep -q '^CRON_LIVE_EXPRESSION=' .env || echo 'CRON_LIVE_EXPRESSION=*/1 * * * *' >> .env && "
        f"sed -i 's|^CRON_LIVE_EXPRESSION=.*|CRON_LIVE_EXPRESSION=*/1 * * * *|' .env && "
        f"grep -q '^CRON_SETTLE_EXPRESSION=' .env || echo 'CRON_SETTLE_EXPRESSION=*/3 * * * *' >> .env && "
        f"sed -i 's|^CRON_SETTLE_EXPRESSION=.*|CRON_SETTLE_EXPRESSION=*/3 * * * *|' .env && "
        f"grep -q '^CRON_TRACKING_EXPRESSION=' .env || echo 'CRON_TRACKING_EXPRESSION=* * * * *' >> .env && "
        f"sed -i 's|^CRON_TRACKING_EXPRESSION=.*|CRON_TRACKING_EXPRESSION=* * * * *|' .env && "
        f"sed -i 's|^FACTORY_SPORTS=.*|FACTORY_SPORTS=football,basketball,tennis,hockey|' .env && "
        f"npm ci --omit=dev",
        timeout=600,
    )

    run(
        c,
        f"cd {APP} && node -e \"require('dotenv').config(); require('./src/database/migrateFactory').runFactoryMigrations().then(()=>console.log('migrate ok'))\" && "
        f"node src/scripts/wipeNews.js --confirm=WIPE_NEWS && "
        f"pm2 restart backdeportivospro --update-env && sleep 3 && "
        f"curl -fsS http://127.0.0.1:3009/health && echo && pm2 show backdeportivospro | head -25",
        timeout=180,
    )

    c.close()
    print("DONE https://api.picks.matupicks.app")


if __name__ == "__main__":
    main()
