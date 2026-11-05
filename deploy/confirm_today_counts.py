"""Confirm TODAY-only counts matching Flutter dayTipsForStats."""
import os
import sys

import paramiko

HOST = "13.140.160.248"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"

REMOTE_JS = r"""
require('dotenv').config();
const { db } = require('./src/config/database');
const { formatDateInTimezone } = require('./src/utils/helpers');

function statusOf(row) {
  const outcome = String(row.outcome || '').toLowerCase().trim();
  const state = String(row.state || '').toLowerCase().trim();
  for (const x of [outcome, state]) {
    if (['won','ganado','ganada','green','hit','success','acertada','acertado'].includes(x)) return 'won';
    if (['lost','perdido','perdida','red','miss','fail','fallada','fallado'].includes(x)) return 'lost';
    if (['live','ended','finished','pending','open','pre',''].includes(x)) continue;
  }
  return 'pending';
}

function bogotaToday() {
  return formatDateInTimezone(new Date(), 'America/Bogota');
}

(async () => {
  const today = bogotaToday();

  // Exact Flutter queries
  const freeQ = await db.from('abet').select('id,state,outcome,match_date,created_at')
    .eq('match_date', today).order('match_date', { ascending: false }).limit(80);
  const liveQ = await db.from('abetlive').select('id,state,outcome,match_date,created_at,home_goals,away_goals')
    .eq('match_date', today).order('created_at', { ascending: false }).limit(60);

  // Also count ALL today (no flutter limit) for truth
  const freeAllQ = await db.from('abet').select('id,state,outcome').eq('match_date', today).limit(500);
  const liveAllQ = await db.from('abetlive').select('id,state,outcome').eq('match_date', today).limit(500);

  // Fallback like Flutter if today empty
  let free = freeQ.data || [];
  let live = liveQ.data || [];
  let usedFallback = false;
  if (free.length === 0) {
    const fb = await db.from('abet').select('id,state,outcome,match_date').order('created_at', { ascending: false }).limit(80);
    free = fb.data || [];
    usedFallback = true;
  }
  if (live.length === 0) {
    const fb = await db.from('abetlive').select('id,state,outcome,match_date').order('created_at', { ascending: false }).limit(60);
    live = fb.data || [];
    usedFallback = true;
  }

  const seen = new Set();
  const merged = [];
  for (const r of [...free, ...live]) {
    if (!r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }

  const day = { won: 0, lost: 0, pending: 0 };
  const byPair = {};
  for (const r of merged) {
    const st = statusOf(r);
    day[st] += 1;
    const k = String(r.state) + '|' + String(r.outcome || '');
    byPair[k] = (byPair[k] || 0) + 1;
  }

  function tally(rows) {
    const t = { won: 0, lost: 0, pending: 0, total: rows.length };
    for (const r of rows) t[statusOf(r)] += 1;
    return t;
  }

  const freeAll = freeAllQ.data || [];
  const liveAll = liveAllQ.data || [];

  // All-time live (for contrast — NOT what the app day screen uses)
  const allWon = await db.from('abetlive').select('id').eq('outcome', 'won').limit(1000);
  const allLost = await db.from('abetlive').select('id').eq('outcome', 'lost').limit(1000);

  console.log(JSON.stringify({
    bogotaToday: today,
    usedFallback,
    whatAppShows_dayTips: {
      total: merged.length,
      ...day,
      freeLimit80: free.length,
      liveLimit60: live.length,
      stateOutcomeBreakdown: byPair,
    },
    todayAllNoLimit: {
      free: tally(freeAll),
      live: tally(liveAll),
    },
    allTimeLive_NOT_day: {
      won: (allWon.data || []).length,
      lost: (allLost.data || []).length,
    },
    note: 'Flutter Tips del dia = free80 + live60 del dia (dedupe). El all-time NO sale en esa pantalla.',
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
    remote = f"{APP}/_tmp_confirm_today.js"
    with sftp.file(remote, "w") as f:
        f.write(REMOTE_JS)
    sftp.close()
    _, out, err = c.exec_command(
        f"cd {APP} && node _tmp_confirm_today.js; rm -f _tmp_confirm_today.js",
        timeout=120,
        get_pty=True,
    )
    text = (out.read() + err.read()).decode("utf-8", errors="replace")
    print(text[-5000:])
    code = out.channel.recv_exit_status()
    c.close()
    if code != 0:
        sys.exit(code)


if __name__ == "__main__":
    main()
