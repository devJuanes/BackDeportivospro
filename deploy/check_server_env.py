import os
import paramiko

PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")
KEYS = [
    "FACTORY_DAILY_CAP_FREE",
    "FACTORY_DAILY_CAP_VIP",
    "FACTORY_MAX_PICKS_PER_MATCH",
    "FACTORY_SECOND_PICK_MIN_CONFIDENCE_FREE",
    "FACTORY_SECOND_PICK_MIN_CONFIDENCE_VIP",
    "FACTORY_MIN_CONFIDENCE_FREE",
    "FACTORY_MIN_CONFIDENCE_VIP",
    "FACTORY_BATCH_FREE",
    "FACTORY_BATCH_VIP",
    "FACTORY_AI_MATCH_LIMIT",
    "FACTORY_MARKETS_PER_MATCH",
    "FACTORY_RULE_MARKETS_PER_MATCH",
    "FACTORY_ENABLE_EXTERNAL_SCRAPERS",
    "FACTORY_AI_LIVE_MATCH_LIMIT",
    "CRON_SETTLE_EXPRESSION",
    "CRON_LIVE_EXPRESSION",
    "CRON_TRACKING_EXPRESSION",
    "FACTORY_AUTO_SETTLE_ENABLED",
    "FACTORY_SPORTS",
    "PUBLIC_BASE_URL",
    "FACTORY_INSTANCE_ID",
]

def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        "13.140.160.248",
        username="root",
        password=PASSWORD,
        timeout=60,
        allow_agent=False,
        look_for_keys=False,
    )
    key_list = " ".join(KEYS)
    cmd = (
        "cd /var/www/backdeportivospro; "
        f"for k in {key_list}; do "
        'grep -E "^$k=" .env || echo "$k=MISSING"; '
        "done"
    )
    _, out, err = c.exec_command(cmd, timeout=30)
    print((out.read() + err.read()).decode(errors="replace"))
    c.close()

if __name__ == "__main__":
    main()
