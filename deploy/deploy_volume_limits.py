"""Sync volume limits, wipe predictions, restart PM2."""
import os
import sys
import time
import paramiko

HOST = "13.140.160.248"
PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"

ENV_PATCHES = [
    ("FACTORY_DAILY_CAP_FREE", "40"),
    ("FACTORY_DAILY_CAP_VIP", "40"),
    ("FACTORY_MAX_PICKS_PER_MATCH", "2"),
    ("FACTORY_SECOND_PICK_MIN_CONFIDENCE_FREE", "72"),
    ("FACTORY_SECOND_PICK_MIN_CONFIDENCE_VIP", "78"),
    ("FACTORY_MIN_CONFIDENCE_FREE", "68"),
    ("FACTORY_MIN_CONFIDENCE_VIP", "75"),
    ("FACTORY_BATCH_FREE", "20"),
    ("FACTORY_BATCH_VIP", "20"),
    ("FACTORY_LATAM_BATCH_FREE", "15"),
    ("FACTORY_LATAM_BATCH_VIP", "15"),
    ("FACTORY_LATAM_AI_MATCH_LIMIT", "12"),
    ("FACTORY_AI_MATCH_LIMIT", "8"),
    ("FACTORY_MARKETS_PER_MATCH", "1"),
    ("FACTORY_RULE_MARKETS_PER_MATCH", "1"),
    ("FACTORY_AI_LIVE_MATCH_LIMIT", "5"),
    ("FACTORY_ENABLE_EXTERNAL_SCRAPERS", "false"),
    ("FACTORY_FIXTURE_ROTATION_POOL", "40"),
]


def run(client, cmd, timeout=600):
    print(">>>", cmd[:220])
    _, out, err = client.exec_command(cmd, timeout=timeout, get_pty=True)
    text = (out.read() + err.read()).decode(errors="replace")
    code = out.channel.recv_exit_status()
    print(text[-5000:].encode("ascii", "replace").decode("ascii"))
    return code, text


def main():
    if not PASSWORD:
        sys.exit("Missing DEPLOY_SSH_PASSWORD")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username="root", password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)

    run(
        c,
        f"cd {APP} && cp .env /tmp/backdeportivospro.env.bak && "
        f"git fetch origin && git reset --hard origin/api && "
        f"cp /tmp/backdeportivospro.env.bak .env && "
        f"sed -i 's|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://api.picks.matupicks.app|' .env && "
        f"mkdir -p data/news/images logs",
    )

    # Upsert volume-limit env keys on server .env
    upsert_parts = []
    for key, val in ENV_PATCHES:
        upsert_parts.append(
            f"grep -q '^{key}=' .env && sed -i 's|^{key}=.*|{key}={val}|' .env || echo '{key}={val}' >> .env"
        )
    run(c, f"cd {APP} && " + " && ".join(upsert_parts))

    run(c, f"cd {APP} && export PUPPETEER_SKIP_DOWNLOAD=1 && npm ci --omit=dev", 600)
    run(c, f"cd {APP} && node src/scripts/wipePredictions.js --confirm=WIPE_PREDICTIONS", 180)
    run(c, f"cd {APP} && pm2 delete backdeportivospro >/dev/null 2>&1 ; pm2 start ecosystem.config.cjs && pm2 save")
    time.sleep(6)
    code, _ = run(c, "curl -fsS http://127.0.0.1:3009/health; echo; curl -fsS https://api.picks.matupicks.app/health; echo")
    c.close()
    print("DONE" if code == 0 else "DONE_WITH_WARNINGS")


if __name__ == "__main__":
    main()
