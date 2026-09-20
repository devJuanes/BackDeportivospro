"""Patch server: public logo base URL + futboolLogoService + restart PM2."""
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
    ("src/services/futboolLogoService.js", f"{APP}/src/services/futboolLogoService.js"),
    ("src/scripts/fixLocalhostLogoUrls.js", f"{APP}/src/scripts/fixLocalhostLogoUrls.js"),
]


def run(client, cmd, timeout=120):
    print(">>>", cmd)
    _, out, err = client.exec_command(cmd, timeout=timeout, get_pty=True)
    text = (out.read() + err.read()).decode(errors="replace")
    code = out.channel.recv_exit_status()
    print(text[-4000:].encode("ascii", "replace").decode("ascii"))
    if code != 0:
        raise RuntimeError(f"exit {code}")
    return text


def main():
    if not PASSWORD:
        sys.exit("DEPLOY_SSH_PASSWORD required")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)
    sftp = c.open_sftp()
    for local, remote in FILES:
        sftp.put(str(ROOT / local), remote)
        print("uploaded", local)
    sftp.close()
    run(
        c,
        f"cd {APP} && "
        f"grep -q '^PUBLIC_BASE_URL=' .env && sed -i 's|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://api.picks.matupicks.app|' .env || "
        f"echo 'PUBLIC_BASE_URL=https://api.picks.matupicks.app' >> .env; "
        f"pm2 restart backdeportivospro --update-env; sleep 2; "
        f"curl -fsS http://127.0.0.1:3009/health; echo; "
        f"node -e \"require('dotenv').config(); const s=require('./src/services/futboolLogoService'); console.log(s.getPublicBaseUrl()); console.log(s.resolveTeamLogoUrl('Barcelona','La Liga'));\"",
    )
    run(c, f"cd {APP} && node src/scripts/fixLocalhostLogoUrls.js")
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
