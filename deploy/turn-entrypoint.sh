#!/bin/sh
set -eu
umask 077
case "${TURN_SECRET:-}" in
  ''|*[!a-zA-Z0-9_-]*) echo 'TURN_SECRET 必须为至少 32 字符的随机字母数字值' >&2; exit 1 ;;
esac
for value in "${TURN_MAX_BPS:-81920}" "${TURN_BPS_CAPACITY:-10485760}"; do
  case "$value" in
    ''|*[!0-9]*) echo 'TURN bandwidth must be a positive integer in bytes/s' >&2; exit 1 ;;
  esac
  if [ "${#value}" -gt 10 ] || [ "$value" -lt 1 ] || [ "$value" -gt 4294967295 ]; then
    echo 'TURN bandwidth is out of range' >&2
    exit 1
  fi
done
if [ "${TURN_BPS_CAPACITY:-10485760}" -lt "${TURN_MAX_BPS:-81920}" ]; then
  echo 'TURN_BPS_CAPACITY must cover TURN_MAX_BPS' >&2
  exit 1
fi
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
  sed '/^max-bps=/d; /^bps-capacity=/d' "$(dirname "$0")/turn-limits.conf"
  printf 'max-bps=%s\nbps-capacity=%s\n' "${TURN_MAX_BPS:-81920}" "${TURN_BPS_CAPACITY:-10485760}"
  printf 'external-ip=%s\nrealm=%s\nstatic-auth-secret=%s\n' "$TURN_EXTERNAL_IP" "$TURN_REALM" "$TURN_SECRET"
  printf '%s\n' 'use-auth-secret' 'fingerprint' 'no-cli' 'no-tls' 'no-dtls' 'stale-nonce=600' 'no-multicast-peers'
  printf '%s\n' 'denied-peer-ip=0.0.0.0-0.255.255.255' 'denied-peer-ip=10.0.0.0-10.255.255.255' 'denied-peer-ip=127.0.0.0-127.255.255.255' 'denied-peer-ip=169.254.0.0-169.254.255.255' 'denied-peer-ip=172.16.0.0-172.31.255.255' 'denied-peer-ip=192.168.0.0-192.168.255.255' 'denied-peer-ip=::1' 'denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' 'denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'
  printf '%s\n' 'denied-peer-ip=100.64.0.0-100.127.255.255'
  printf '%s\n' 'pidfile=/tmp/suichuan-turn.pid' 'log-file=stdout' 'simple-log'
} > /tmp/suichuan-turn.conf
exec turnserver -c /tmp/suichuan-turn.conf
