#!/bin/sh
set -eu
umask 077
case "${TURN_SECRET:-}" in
  ''|*[!a-zA-Z0-9_-]*) echo 'TURN_SECRET 必须为至少 32 字符的随机字母数字值' >&2; exit 1 ;;
esac
if [ "${#TURN_SECRET}" -lt 32 ]; then
  echo 'TURN_SECRET 长度不足' >&2
  exit 1
fi
case "${TURN_EXTERNAL_IP:-}" in
  ''|*[!0-9.]*) echo 'TURN_EXTERNAL_IP 必须为公网 IPv4' >&2; exit 1 ;;
esac
case "${TURN_REALM:-}" in
  ''|*[!a-zA-Z0-9.-]*) echo 'TURN_REALM 必须为域名' >&2; exit 1 ;;
esac
{
  printf '%s\n' 'listening-port=3478'
  cat "$(dirname "$0")/turn-limits.conf"
  printf 'external-ip=%s\nrealm=%s\nstatic-auth-secret=%s\n' "$TURN_EXTERNAL_IP" "$TURN_REALM" "$TURN_SECRET"
  printf '%s\n' 'use-auth-secret' 'fingerprint' 'no-cli' 'no-tls' 'no-dtls' 'stale-nonce=600' 'no-multicast-peers'
  printf '%s\n' 'denied-peer-ip=0.0.0.0-0.255.255.255' 'denied-peer-ip=10.0.0.0-10.255.255.255' 'denied-peer-ip=127.0.0.0-127.255.255.255' 'denied-peer-ip=169.254.0.0-169.254.255.255' 'denied-peer-ip=172.16.0.0-172.31.255.255' 'denied-peer-ip=192.168.0.0-192.168.255.255' 'denied-peer-ip=::1' 'denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' 'denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'
  printf '%s\n' 'pidfile=/tmp/suichuan-turn.pid' 'log-file=stdout' 'simple-log'
} > /tmp/suichuan-turn.conf
exec turnserver -c /tmp/suichuan-turn.conf
