"""Verify Firebase env + health on production."""
import os
import sys

import paramiko

HOST = "13.140.160.248"
USER = "root"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"


def main():
    if not PASSWORD:
        sys.exit("DEPLOY_SSH_PASSWORD required")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)

    remote = r"""
cd /var/www/backdeportivospro
python3 - <<'PY'
from pathlib import Path
env = Path('.env').read_text(errors='replace')
vals = {}
for line in env.splitlines():
    if not line or line.lstrip().startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    vals[k] = v
b64 = vals.get('FIREBASE_SERVICE_ACCOUNT_BASE64', '')
print('project', vals.get('FIREBASE_PROJECT_ID'))
print('push', vals.get('PREDICTION_PUSH_ENABLED'))
print('b64_len', len(b64))
print('b64_prefix', b64[:24])
PY
node -e "require('dotenv').config(); const f=require('./src/services/firebaseAdmin'); console.log('firebase_ready=' + !!f.ensureInitialized());"
curl -fsS http://127.0.0.1:3009/health; echo
curl -fsS https://api.picks.matupicks.app/health; echo
"""
    _, out, err = c.exec_command(remote, timeout=90, get_pty=True)
    text = (out.read() + err.read()).decode("utf-8", errors="replace")
    print(text.encode("ascii", "replace").decode("ascii"))
    code = out.channel.recv_exit_status()
    c.close()
    raise SystemExit(code)


if __name__ == "__main__":
    main()
