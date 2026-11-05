"""Verify MatuDB day stats after repair (runs on server via SSH)."""
import os
import sys
from pathlib import Path

import paramiko

HOST = "13.140.160.248"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"

REMOTE_JS = r"""
require('dotenv').config();
const { db } = require('./src/config/database');

function statusOf(row) {
  const outcome = String(row.outcome || '').toLowerCase();
  const state = String(row.state || '').toLowerCase();
  for (const x of [outcome, state]) {
    if (['won', 'ganado', 'ganada'].includes(x)) return 'won';
    if (['lost', 'perdido', 'perdida'].includes(x)) return 'lost';
  }
  return 'pending';
}

(async () => {
  const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
  const freeQ = await db.from('abet').select('id,state,outcome').eq('match_date', today).limit(80);
  const liveQ = await db.from('abetlive').select('id,state,outcome').eq('match_date', today).limit(60);
  const free = freeQ.data || [];
  const live = liveQ.data || [];
  const seen = new Set();
  const all = [];
  for (const r of [...free, ...live]) {
    if (!r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    all.push(r);
  }
  const c = { won: 0, lost: 0, pending: 0 };
  for (const r of all) c[statusOf(r)] += 1;
  const wonQ = await db.from('abetlive').select('id').eq('outcome', 'won').limit(1000);
  const lostQ = await db.from('abetlive').select('id').eq('outcome', 'lost').limit(1000);
  console.log(JSON.stringify({
    today,
    flutterDaySim: { total: all.length, ...c, freeRows: free.length, liveRows: live.length },
    allLiveOutcome: { won: (wonQ.data || []).length, lost: (lostQ.data || []).length },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
"""


def main():
    if not PASSWORD:
        sys.exit("DEPLOY_SSH_PASSWORD required")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username="root", password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)
    sftp = c.open_sftp()
    remote = f"{APP}/_tmp_verify_counts.js"
    with sftp.file(remote, "w") as f:
        f.write(REMOTE_JS)
    sftp.close()
    _, out, err = c.exec_command(f"cd {APP} && node _tmp_verify_counts.js; rm -f _tmp_verify_counts.js", timeout=120, get_pty=True)
    text = (out.read() + err.read()).decode("utf-8", errors="replace")
    print(text[-4000:])
    c.close()


if __name__ == "__main__":
    main()
