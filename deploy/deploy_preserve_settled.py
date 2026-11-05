"""Deploy preserve-settled fix (no wipe, no deletes)."""
import os
import sys
from pathlib import Path

import paramiko

HOST = "13.140.160.248"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"
ROOT = Path(__file__).resolve().parent.parent

FILES = [
    "src/utils/preserveSettledOutcome.js",
    "src/models/liveModel.js",
    "src/services/liveSettlementService.js",
    "src/services/predictionTrackingService.js",
    "src/services/pickSettlementService.js",
    "src/scripts/wipePredictions.js",
]


def run(c, cmd, timeout=180):
    print(">>>", cmd[:160].encode("ascii", "replace").decode("ascii"))
    _, out, err = c.exec_command(cmd, timeout=timeout, get_pty=True)
    text = (out.read() + err.read()).decode("utf-8", errors="replace")
    code = out.channel.recv_exit_status()
    print(text[-4000:].encode("ascii", "replace").decode("ascii"))
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
node -e "
require('dotenv').config();
const {{ db }} = require('./src/config/database');
(async () => {{
  for (const t of ['abet','abetvip','abetlive']) {{
    const {{ data }} = await db.from(t).select('id,state,outcome').limit(500);
    const rows = data || [];
    const won = rows.filter(r => ['won','ganada'].includes(String(r.state||'').toLowerCase()) || ['won','ganada'].includes(String(r.outcome||'').toLowerCase())).length;
    const lost = rows.filter(r => ['lost','perdida'].includes(String(r.state||'').toLowerCase()) || ['lost','perdida'].includes(String(r.outcome||'').toLowerCase())).length;
    console.log(t + ' sample=' + rows.length + ' won~' + won + ' lost~' + lost);
  }}
}})().catch(e => {{ console.error(e); process.exit(1); }});
"
""",
        180,
    )
    c.close()
    print("DEPLOY_OK")


if __name__ == "__main__":
    main()
