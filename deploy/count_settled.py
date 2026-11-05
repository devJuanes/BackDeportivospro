import json
import urllib.request
from collections import Counter
from pathlib import Path

raw = Path(r"C:\Users\juanl\OneDrive\Documentos\GitHub\BackDeportivospro\.env").read_bytes()
text = raw.decode("utf-8", errors="replace")
env = {}
for line in text.splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k.strip()] = v.strip().strip('"').strip("'")

base = env.get("MATUDB_URL", "https://db.matudb.com").rstrip("/")
pid = env["MATUDB_PROJECT_ID"]
key = env["MATUDB_API_KEY"]


def get(table, qs):
    url = f"{base}/api/projects/{pid}/data/{table}?{qs}"
    req = urllib.request.Request(url, headers={"Accept": "application/json", "apikey": key})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.loads(r.read().decode())
    rows = j.get("data", {})
    if isinstance(rows, dict):
        rows = rows.get("rows", [])
    return rows if isinstance(rows, list) else []


for table in ["abet", "abetvip", "abetlive"]:
    print("===", table)
    all_rows = get(table, "limit=500&order=created_at.desc")
    print("sample", len(all_rows))
    print("states", dict(Counter(str(r.get("state") or "").lower() for r in all_rows)))
    if table == "abetlive":
        print("outcomes", dict(Counter(str(r.get("outcome") or "").lower() for r in all_rows)))
    wonish = sum(
        1
        for r in all_rows
        if str(r.get("state") or "").lower() in ("won", "ganada")
        or str(r.get("outcome") or "").lower() in ("won", "ganada")
    )
    lostish = sum(
        1
        for r in all_rows
        if str(r.get("state") or "").lower() in ("lost", "perdida")
        or str(r.get("outcome") or "").lower() in ("lost", "perdida")
    )
    print("wonish", wonish, "lostish", lostish)
