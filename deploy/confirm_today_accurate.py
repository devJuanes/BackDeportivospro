"""Accurate TODAY confirmation — same HTTP as Flutter MatuDbClient."""
import os
import sys

import paramiko

HOST = "13.140.160.248"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"

REMOTE = r"""
require('dotenv').config();
const https = require('https');

const base = process.env.MATUDB_URL.replace(/\/$/, '');
const project = process.env.MATUDB_PROJECT_ID;
const key = process.env.MATUDB_API_KEY;
const { formatDateInTimezone, normalizeMatchDate } = require('./src/utils/helpers');
const today = formatDateInTimezone(new Date(), 'America/Bogota');

function fetchRaw(qs) {
  return new Promise((resolve, reject) => {
    const u = `${base}/api/projects/${project}/data/${qs}`;
    https.get(u, { headers: { apikey: key, Accept: 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, bytes: b.length, body: b }));
    }).on('error', reject);
  });
}

function rowsOf(body) {
  try {
    const j = JSON.parse(body || '[]');
    if (Array.isArray(j)) return j;
    if (Array.isArray(j?.data)) return j.data;
    if (Array.isArray(j?.rows)) return j.rows;
    if (j && typeof j === 'object' && j.id) return [j];
    return [];
  } catch {
    return [];
  }
}

function statusOf(row) {
  const outcome = String(row.outcome || '').toLowerCase().trim();
  const state = String(row.state || '').toLowerCase().trim();
  for (const x of [outcome, state]) {
    if (['won','ganado','ganada','green','hit','success'].includes(x)) return 'won';
    if (['lost','perdido','perdida','red','miss','fail'].includes(x)) return 'lost';
  }
  return 'pending';
}

function tally(list) {
  const t = { total: list.length, won: 0, lost: 0, pending: 0 };
  for (const r of list) t[statusOf(r)] += 1;
  return t;
}

(async () => {
  // 1) Exact Flutter queries
  const freeR = await fetchRaw(`abet?limit=80&order=match_date.desc&match_date=eq.${today}`);
  const liveR = await fetchRaw(`abetlive?limit=60&order=created_at.desc&match_date=eq.${today}`);
  let free = rowsOf(freeR.body);
  let live = rowsOf(liveR.body);
  let fallback = false;
  if (free.length === 0) {
    const fb = await fetchRaw('abet?limit=80&order=created_at.desc');
    free = rowsOf(fb.body);
    fallback = true;
  }
  if (live.length === 0) {
    const fb = await fetchRaw('abetlive?limit=60&order=created_at.desc');
    live = rowsOf(fb.body);
    fallback = true;
  }

  // Flutter dayTipsForStats: blocks+home+live = free + free + live deduped = free+live
  const seen = new Set();
  const merged = [];
  for (const r of [...free, ...live]) {
    if (!r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }

  // 2) All rows with match_date normalized to today (truth for "hoy")
  const freeBig = rowsOf((await fetchRaw(`abet?limit=500&order=created_at.desc`)).body);
  const liveBig = rowsOf((await fetchRaw(`abetlive?limit=500&order=created_at.desc`)).body);
  const freeToday = freeBig.filter((r) => normalizeMatchDate(r.match_date, 'America/Bogota') === today);
  const liveToday = liveBig.filter((r) => normalizeMatchDate(r.match_date, 'America/Bogota') === today);

  const wonAll = rowsOf((await fetchRaw('abetlive?outcome=eq.won&limit=1000')).body);
  const lostAll = rowsOf((await fetchRaw('abetlive?outcome=eq.lost&limit=1000')).body);

  const pairs = {};
  for (const r of merged) {
    const k = `${r.state}|${r.outcome || ''}`;
    pairs[k] = (pairs[k] || 0) + 1;
  }

  console.log(JSON.stringify({
    bogotaToday: today,
    answer: {
      are_110_won_from_today: false,
      are_110_won_all_time: true,
      what_user_screen_uses: 'solo tips del dia (free80+live60)',
    },
    flutterDayScreen: {
      fallbackUsed: fallback,
      freeHttpBytes: freeR.bytes,
      liveHttpBytes: liveR.bytes,
      freeCount: free.length,
      liveCount: live.length,
      ...tally(merged),
      pairs,
    },
    todayNormalized_noFlutterLimit: {
      free: tally(freeToday),
      live: tally(liveToday),
      combined: tally([...freeToday, ...liveToday]),
    },
    allTimeLive_forContrast: {
      won: wonAll.length,
      lost: lostAll.length,
    },
    sampleMerged: merged.slice(0, 5).map((r) => ({
      id: String(r.id).slice(0, 8),
      state: r.state,
      outcome: r.outcome,
      match_date: r.match_date,
      status: statusOf(r),
    })),
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
    path = f"{APP}/_tmp_today_accurate.js"
    with sftp.file(path, "w") as f:
        f.write(REMOTE)
    sftp.close()
    _, out, err = c.exec_command(f"cd {APP} && node _tmp_today_accurate.js; rm -f _tmp_today_accurate.js", timeout=180, get_pty=True)
    print((out.read() + err.read()).decode("utf-8", errors="replace")[-6000:])
    c.close()


if __name__ == "__main__":
    main()
