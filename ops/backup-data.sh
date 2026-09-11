#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir=/var/backups/mstr-system
source_dir=/opt/mstr-system/data
timestamp=$(date -u +%Y%m%dT%H%M%SZ)

install -d -m 0700 "$backup_dir"
tar -C "$source_dir" -czf "$backup_dir/data-$timestamp.tar.gz" .
find "$backup_dir" -type f -name 'data-*.tar.gz' -mtime +14 -delete
