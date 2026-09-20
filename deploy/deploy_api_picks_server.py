"""One-shot deploy to root@13.140.160.248 for api.picks.matupicks.app.
Password via env DEPLOY_SSH_PASSWORD — never commit credentials.
"""
import os
import sys
import time
from pathlib import Path

import paramiko

HOST = "13.140.160.248"
USER = "root"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
DOMAIN = "api.picks.matupicks.app"
APP_DIR = "/var/www/backdeportivospro"
REPO = "https://github.com/devJuanes/BackDeportivospro.git"
BRANCH = "api"
ROOT = Path(__file__).resolve().parent.parent
NGINX_LOCAL = ROOT / "deploy" / "nginx.api.picks.matupicks.app.conf"
SETUP_LOCAL = ROOT / "deploy" / "setup-api-picks-matupicks.sh"


def run(client, cmd, timeout=600):
    print(f"\n>>> {cmd}")
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout, get_pty=True)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    code = stdout.channel.recv_exit_status()
    # Avoid Windows console UnicodeEncodeError on npm spinners
    safe = (out + ("\n" + err if err.strip() else "")).encode("ascii", "replace").decode("ascii")
    if safe.strip():
        print(safe[-8000:])
    if code != 0:
        raise RuntimeError(f"exit {code}: {cmd}")
    return out


def main():
    if not PASSWORD:
        print("Set DEPLOY_SSH_PASSWORD", file=sys.stderr)
        sys.exit(1)
    if not NGINX_LOCAL.exists():
        print(f"Missing {NGINX_LOCAL}", file=sys.stderr)
        sys.exit(1)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Connecting {USER}@{HOST} ...")
    client.connect(HOST, username=USER, password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)

    # Resume / finish deploy steps (idempotent)
    run(
        client,
        f"cd {APP_DIR} && (test -d node_modules && echo 'node_modules ok' || npm ci --omit=dev)",
        timeout=600,
    )
    run(client, f"mkdir -p {APP_DIR}/logs")

    # Ensure nginx conf is present (uploaded earlier or rewrite)
    sftp = client.open_sftp()
    remote_nginx = f"{APP_DIR}/deploy/nginx.api.picks.matupicks.app.conf"
    try:
        sftp.stat(f"{APP_DIR}/deploy")
    except OSError:
        run(client, f"mkdir -p {APP_DIR}/deploy")
    sftp.put(str(NGINX_LOCAL), remote_nginx)
    local_env = ROOT / ".env"
    if local_env.exists():
        sftp.put(str(local_env), f"{APP_DIR}/.env")
        print("Uploaded local .env to server")
    sftp.close()

    run(
        client,
        f"cd {APP_DIR}; "
        f"if [ ! -f .env ] && [ -f .env.example ]; then cp .env.example .env; fi; "
        f"if [ -f .env ]; then "
        f"  grep -q '^PUBLIC_BASE_URL=' .env && sed -i 's|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://{DOMAIN}|' .env || echo 'PUBLIC_BASE_URL=https://{DOMAIN}' >> .env; "
        f"  grep -q '^PORT=' .env || echo 'PORT=3009' >> .env; "
        f"  grep -q '^NODE_ENV=' .env && sed -i 's|^NODE_ENV=.*|NODE_ENV=production|' .env || echo 'NODE_ENV=production' >> .env; "
        f"fi",
    )

    # Upload local .env secrets if server .env is only example (has missing MATUDB)
    # Prefer keeping existing server .env; only warn.
    run(
        client,
        f"cd {APP_DIR} && "
        f"if ! grep -q '^MATUDB_API_KEY=mb_' .env 2>/dev/null; then echo 'WARN: .env may lack MatuDB keys'; fi; "
        f"pm2 delete backdeportivospro >/dev/null 2>&1 || true; "
        f"pm2 start ecosystem.config.cjs && pm2 save; "
        f"(pm2 startup systemd -u root --hp /root | tail -n 1 | bash) || true",
        timeout=120,
    )

    run(
        client,
        f"cp {remote_nginx} /etc/nginx/sites-available/{DOMAIN}; "
        f"ln -sfn /etc/nginx/sites-available/{DOMAIN} /etc/nginx/sites-enabled/{DOMAIN}; "
        f"nginx -t && systemctl reload nginx",
    )

    time.sleep(2)
    run(client, "curl -fsS http://127.0.0.1:3009/health; echo; pm2 status | head -n 20")

    run(
        client,
        "command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-nginx; "
        f"certbot --nginx -d {DOMAIN} --non-interactive --agree-tos -m hola@matupicks.app --redirect || "
        f"echo SSL_PENDING DNS_A {DOMAIN} to {HOST}",
        timeout=180,
    )

    run(client, f"curl -fsS http://127.0.0.1:3009/health; echo; curl -fsSI https://{DOMAIN}/health 2>&1 | head -n 15 || true")

    client.close()
    print(f"\nDONE. API URL: https://{DOMAIN}")


if __name__ == "__main__":
    main()
