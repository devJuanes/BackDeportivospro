import os
import sys
import time
import paramiko

HOST = "13.140.160.248"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"


def run(client, cmd, timeout=600):
    print(">>>", cmd[:200])
    _, out, err = client.exec_command(cmd, timeout=timeout, get_pty=True)
    text = (out.read() + err.read()).decode(errors="replace")
    code = out.channel.recv_exit_status()
    print(text[-4500:].encode("ascii", "replace").decode("ascii"))
    return code, text


def main():
    if not PASSWORD:
        sys.exit(1)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username="root", password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)

    # Force sync to GitHub api branch (keep .env)
    run(
        c,
        f"cd {APP} && cp .env /tmp/backdeportivospro.env.bak && "
        f"git fetch origin && git reset --hard origin/api && "
        f"cp /tmp/backdeportivospro.env.bak .env && "
        f"sed -i 's|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://api.picks.matupicks.app|' .env && "
        f"mkdir -p data/news/images logs",
    )

    run(c, f"cd {APP} && export PUPPETEER_SKIP_DOWNLOAD=1 && npm ci --omit=dev", 600)

    run(
        c,
        f"cd {APP} && node -e \"require('dotenv').config(); require('./src/database/migrateFactory').runFactoryMigrations().then(()=>console.log('migrate ok'))\"",
        180,
    )
    run(c, f"cd {APP} && node src/scripts/wipeNews.js --confirm=WIPE_NEWS")

    run(c, f"cd {APP} && pm2 delete backdeportivospro >/dev/null 2>&1 ; pm2 start ecosystem.config.cjs && pm2 save")
    time.sleep(5)
    code, _ = run(c, "curl -fsS http://127.0.0.1:3009/health; echo; curl -fsS https://api.picks.matupicks.app/health; echo")
    c.close()
    print("DONE" if code == 0 else "DONE_WITH_WARNINGS")


if __name__ == "__main__":
    main()
