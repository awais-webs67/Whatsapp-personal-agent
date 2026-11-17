#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu server (Oracle Cloud Always Free, Hostinger VPS, any VPS).
# Run it from inside the cloned project folder:
#   bash deploy/setup-server.sh agent.yourdomain.com
# It installs Node.js 22, the app's packages, PM2 (keeps the agent running and restarts it after a reboot)
# and Caddy (HTTPS with a free certificate). Safe to run again.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: bash deploy/setup-server.sh agent.yourdomain.com"
  echo "Point the domain's A record to this server's public IP first."
  exit 1
fi
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(id -un)"
PORT="${PORT:-3000}"

step() { printf '\n==> %s\n' "$*"; }

step "Swap: extra memory for small servers"
# Free 1 GB servers (Oracle E2.1.Micro) run out of memory during npm install without swap.
ram_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
if [[ "$ram_mb" -lt 3000 ]] && ! swapon --show | grep -q .; then
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "Added 2 GB swap (RAM is ${ram_mb} MB)."
else
  echo "RAM ${ram_mb} MB; swap not needed or already on."
fi

step "System packages"
sudo apt-get update -y
sudo -E apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

step "Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

step "App packages"
cd "$APP_DIR"
npm install --omit=dev

step "PM2: keep the agent running"
sudo npm install -g pm2
if pm2 describe agent >/dev/null 2>&1; then
  HOST=127.0.0.1 PORT="$PORT" pm2 restart agent --update-env
else
  HOST=127.0.0.1 PORT="$PORT" pm2 start npm --name agent --cwd "$APP_DIR" -- start
fi
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "$HOME" >/dev/null
pm2 save

step "Auto update: pull new code from GitHub every 5 minutes"
mkdir -p "$APP_DIR/data"
cron_line="*/5 * * * * bash $APP_DIR/deploy/auto-update.sh >> $APP_DIR/data/update.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'deploy/auto-update.sh'; echo "$cron_line" ) | crontab -
echo "On. Log: $APP_DIR/data/update.log  (private repo? run once: git config credential.helper store && git pull)"

step "Firewall: open ports 80 and 443 on this machine"
# Oracle's Ubuntu images block everything except SSH in iptables, even after the cloud firewall is opened.
for p in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null; then
    # Insert before the catch-all REJECT rule if there is one, otherwise append.
    pos="$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
    if [[ -n "$pos" ]]; then sudo iptables -I INPUT "$pos" -p tcp --dport "$p" -m state --state NEW -j ACCEPT
    else sudo iptables -A INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT; fi
  fi
done
sudo netfilter-persistent save >/dev/null

step "Caddy: HTTPS for $DOMAIN"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
sudo systemctl enable caddy >/dev/null
sudo systemctl restart caddy

step "Done"
echo "Open https://$DOMAIN in a minute (the certificate is issued on the first visit)."
echo "If it does not open: check the domain's A record, and that ports 80 and 443 are open in the cloud firewall."
echo "Logs:     pm2 logs agent"
echo "Updates:  automatic every 5 minutes (log: $APP_DIR/data/update.log)"
echo "Backup:   the folder $APP_DIR/data holds chats, settings and keys. Copy it somewhere safe."
