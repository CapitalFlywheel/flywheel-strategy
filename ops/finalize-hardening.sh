#!/usr/bin/env bash
set -Eeuo pipefail

install -m 0644 /root/fail2ban-jail.local /etc/fail2ban/jail.local
install -m 0440 /root/mstradmin-sudoers /etc/sudoers.d/90-mstradmin
visudo -cf /etc/sudoers.d/90-mstradmin
install -m 0644 /root/sshd-mstr-system.conf /etc/ssh/sshd_config.d/99-mstr-system.conf
sshd -t
systemctl restart fail2ban
systemctl reload ssh
