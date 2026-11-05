import os
import paramiko

PASSWORD = os.environ.get("DEPLOY_SSH_PASSWORD", "")

def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect("13.140.160.248", username="root", password=PASSWORD, timeout=60, allow_agent=False, look_for_keys=False)
    cmd = "cd /var/www/backdeportivospro && node src/scripts/diagnoseSettlement.js"
    _, out, err = c.exec_command(cmd, timeout=90)
    print((out.read() + err.read()).decode(errors="replace")[-6000:])
    c.close()

if __name__ == "__main__":
    main()
