"""HTTP MatuDB same as Flutter + check wipe source in logs."""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

import paramiko

HOST = "13.140.160.248"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"


def bogota_today():
    return (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%d")


REMOTE = r"""
require('dotenv').config();
const https = require('https');
const http = require('http');

const url = process.env.MATUDB_URL.replace(/\/$/, '');
const project = process.env.MATUDB_PROJECT_ID;
const key = process.env.MATUDB_API_KEY;
const today = require('./src/utils/helpers').formatDateInTimezone(new Date(), 'America/Bogota');

function get(pathQuery) {
  return new Promise((resolve, reject) => {
    const u = `${url}/api/projects/${project}/data/${pathQuery}`;
    const lib = u.startsWith('https') ? https : http;
    const req = lib.get(u, { headers: { apikey: key, Accept: 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(b || '[]');
          resolve(Array.isArray(j) ? j : j ? [j] : []);
        } catch (e) {
          reject(new Error(b.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
  });
}

function statusOf(row) {
  const outcome = String(row.outcome || '').toLowerCase().trim();
  const state = String(row.state || '').toLowerCase().trim();
  for (const x of [outcome, state]) {
    if (['won','ganado','ganada','green','hit','success'].includes(x)) return 'won';
    if (['lost','perdido','perdida','red','miss','fail'].includes(x)) return 'lost';
    if (['live','ended','finished','pending','open','pre',''].includes(x)) continue;
  }
  return 'pending';
}

(async () => {
  const free = await get(`abet?match_date=eq.${today}&limit=80&order=match_date.desc`);
  const live = await get(`abetlive?match_date=eq.${today}&limit=60&order=created_at.desc`);
  const freeAll = await get(`abet?match_date=eq.${today}&limit=500&order=created_at.desc`);
  const liveAll = await get(`abetlive?match_date=eq.${today}&limit=500&order=created_at.desc`);
  const liveWon = await get('abetlive?outcome=eq.won&limit=1000');
  const liveLost = await get('abetlive?outcome=eq.lost&limit=1000');
  const livePend = await get('abetlive?outcome=eq.pending&limit=5');

  const seen = new Set();
  const merged = [];
  for (const r of [...free, ...live]) {
    if (!r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  const day = { won: 0, lost: 0, pending: 0 };
  const pairs = {};
  for (const r of merged) {
    const s = statusOf(r);
    day[s] += 1;
    const k = `${r.state}|${r.outcome || ''}`;
    pairs[k] = (pairs[k] || 0) + 1;
  }
  function tally(rows) {
    const t = { total: rows.length, won: 0, lost: 0, pending: 0 };
    for (const r of rows) t[statusOf(r)] += 1;
    return t;
  }

  // sample 3 live today
  const samples = (liveAll.slice(0, 3) || []).map((r) => ({
    id: r.id,
    state: r.state,
    outcome: r.outcome,
    hg: r.home_goals,
    ag: r.away_goals,
    match_date: r.match_date,
    prediction: String(r.prediction || '').slice(0, 60),
  }));

  console.log(JSON.stringify({
    today,
    flutterExact: { total: merged.length, ...day, free: free.length, live: live.length, pairs },
    todayAll: { free: tally(freeAll), live: tally(liveAll) },
    allTimeLive: { won: liveWon.length, lost: liveLost.length },
    samples,
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
    path = f"{APP}/_tmp_http_today.js"
    with sftp.file(path, "w") as f:
        f.write(REMOTE)
    sftp.close()
    cmds = [
        f"cd {APP} && node _tmp_http_today.js; rm -f _tmp_http_today.js",
        "pm2 logs backdeportivospro --lines 80 --nostream 2>/dev/null | tail -n 80",
    ]
    for cmd in cmds:
        print(">>>", cmd[:120])
        _, out, err = c.exec_command(cmd, timeout=120, get_pty=True)
        text = (out.read() + err.read()).decode("utf-8", errors="replace")
        print(text[-4500:])
    c.close()


if __name__ == "__main__":
    main()
