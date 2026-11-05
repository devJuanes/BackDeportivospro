import os
import paramiko

HOST = "13.140.160.248"
PASS = os.environ.get("DEPLOY_SSH_PASSWORD", "")
APP = "/var/www/backdeportivospro"

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASS, timeout=60, allow_agent=False, look_for_keys=False)


def run(cmd):
    print("====", cmd[:100])
    _, o, e = c.exec_command(cmd, timeout=90)
    text = (o.read() + e.read()).decode("utf-8", "replace")
    print(text[-4500:].encode("ascii", "replace").decode("ascii"))


run(
    f"grep -n 'outcome.*pending\\|finalizeLivePrediction\\|preserveSettled\\|updateLiveScore' "
    f"{APP}/src/services/liveSettlementService.js {APP}/src/models/liveModel.js | head -60"
)
run(f"sed -n '145,190p' {APP}/src/services/liveSettlementService.js")
run(f"sed -n '255,320p' {APP}/src/models/liveModel.js")
run(f"grep -n 'isAutoSettleEnabled\\|autoSettleEnabled\\|FACTORY_AUTO_SETTLE' {APP}/src/services/pickSettlementService.js {APP}/src/services/factoryService.js {APP}/.env || true")
run("pm2 jlist | python3 -c \"import sys,json; d=json.load(sys.stdin);\\n[print(p['name'], p['pm2_env'].get('status'), p['pm2_env'].get('pm_uptime'), p['pm2_env'].get('restart_time')) for p in d if 'deportivos' in p['name'] or 'back' in p['name']]\"")
run(f"ls -la {APP}/src/utils/preserveSettledOutcome.js {APP}/src/services/liveSettlementService.js")
c.close()
