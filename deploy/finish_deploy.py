import os
import sys
import paramiko

HOST = "13.140.160.248"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"


def run(client, cmd, timeout=600):
    print(">>>", cmd[:180])
    _, out, err = client.exec_command(cmd, timeout=timeout, get_pty=True)
    text = (out.read() + err.read()).decode(errors="replace")
    code = out.channel.recv_exit_status()
    print(text[-5000:].encode("ascii", "replace").decode("ascii"))
    if code != 0:
        raise RuntimeError(f"exit {code}")
    return text


def main():
    if not PASSWORD:
        sys.exit(1)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username="root", password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)

    run(
        c,
        f"cd {APP} && git pull --ff-only origin api ; "
        f"export PUPPETEER_SKIP_DOWNLOAD=1 ; "
        f"npm ci --omit=dev",
        600,
    )
    run(
        c,
        f"cd {APP} && "
        f"node -e \"require('dotenv').config(); require('./src/database/migrateFactory').runFactoryMigrations().then(()=>console.log('migrate ok'))\" ; "
        f"node src/scripts/wipeNews.js --confirm=WIPE_NEWS ; "
        f"pm2 restart backdeportivospro --update-env ; "
        f"sleep 4 ; curl -fsS http://127.0.0.1:3009/health ; echo",
        180,
    )
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
