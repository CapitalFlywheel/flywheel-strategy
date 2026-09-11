#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg git nginx fail2ban python3-systemd ufw unattended-upgrades rsync jq

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: jammy
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

if ! swapon --show=NAME --noheadings | grep -qx '/swapfile'; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
if ! grep -qE '^/swapfile[[:space:]]' /etc/fstab; then
  printf '%s\n' '/swapfile none swap sw 0 0' >>/etc/fstab
fi

if ! id -u mstradmin >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash mstradmin
fi
usermod -aG sudo,docker mstradmin
install -d -m 700 -o mstradmin -g mstradmin /home/mstradmin/.ssh
grep 'mstr-system-deploy' /root/.ssh/authorized_keys > /home/mstradmin/.ssh/authorized_keys
chown mstradmin:mstradmin /home/mstradmin/.ssh/authorized_keys
chmod 600 /home/mstradmin/.ssh/authorized_keys
cat >/etc/sudoers.d/90-mstradmin <<'EOF'
mstradmin ALL=(ALL) NOPASSWD: ALL
EOF
chmod 440 /etc/sudoers.d/90-mstradmin
visudo -cf /etc/sudoers.d/90-mstradmin

install -d -m 0750 -o mstradmin -g mstradmin /opt/mstr-system
install -d -m 0700 /var/backups/mstr-system

cat >/etc/ssh/sshd_config.d/99-mstr-system.conf <<'EOF'
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl reload ssh

timedatectl set-timezone UTC
systemctl enable --now docker nginx fail2ban unattended-upgrades

ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

docker --version
docker compose version
free -h
df -h /
