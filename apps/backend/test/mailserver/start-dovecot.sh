#!/usr/bin/env bash
# Starts a throwaway Dovecot IMAP server for integration tests (never a real mailbox).
#   IMAPS on 127.0.0.1:19993 (implicit TLS), IMAP+STARTTLS on 127.0.0.1:19143
# Users: alice@test.local / bob@test.local, password "mailpass-123".
# The TLS certificate is self-signed for "localhost"; its CA file is written to $BASE/ca.pem.
set -euo pipefail
BASE=${MAILTEST_DIR:-/var/tmp/mailtest}
if [ -f "$BASE/dovecot.conf" ]; then doveadm -c "$BASE/dovecot.conf" stop 2>/dev/null || true; sleep 0.5; fi
rm -rf "$BASE" && mkdir -p "$BASE"/{mail,run}
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$BASE/key.pem" -out "$BASE/ca.pem" >/dev/null 2>&1
HASH=$(doveadm pw -s SHA512-CRYPT -p 'mailpass-123')
UID_=$(id -u nobody); GID_=$(id -g nobody)
for u in alice bob; do echo "$u@test.local:$HASH:$UID_:$GID_::$BASE/mail/$u" >> "$BASE/users"; done
chown -R nobody:"$(id -gn nobody)" "$BASE/mail"
cat > "$BASE/dovecot.conf" <<CONF
base_dir = $BASE/run
log_path = $BASE/dovecot.log
protocols = imap
listen = 127.0.0.1
ssl = yes
ssl_cert = <$BASE/ca.pem
ssl_key = <$BASE/key.pem
disable_plaintext_auth = yes
auth_mechanisms = plain login
mail_location = maildir:~/Maildir
first_valid_uid = 1
passdb {
  driver = passwd-file
  args = scheme=SHA512-CRYPT $BASE/users
}
userdb {
  driver = passwd-file
  args = $BASE/users
}
service imap-login {
  inet_listener imap {
    port = 19143
  }
  inet_listener imaps {
    port = 19993
    ssl = yes
  }
}
namespace inbox {
  inbox = yes
  mailbox Sent {
    special_use = \Sent
    auto = subscribe
  }
  mailbox Drafts {
    special_use = \Drafts
    auto = subscribe
  }
  mailbox Trash {
    special_use = \Trash
    auto = subscribe
  }
  mailbox Junk {
    special_use = \Junk
    auto = subscribe
  }
  mailbox Archive {
    special_use = \Archive
    auto = subscribe
  }
}
protocol imap {
  mail_max_userip_connections = 20
}
CONF
dovecot -c "$BASE/dovecot.conf"
for i in $(seq 1 30); do (echo > /dev/tcp/127.0.0.1/19993) 2>/dev/null && break; sleep 0.2; done
# Tests (possibly running as another user in CI) edit the user file and read the log and test key.
chmod 755 "$BASE"; chmod 666 "$BASE/users"; chmod 644 "$BASE/key.pem" "$BASE/ca.pem"
touch "$BASE/dovecot.log"; chmod 644 "$BASE/dovecot.log"
# When started with sudo (CI), give the user file to the calling user so tests can also update its timestamp.
if [ -n "${SUDO_USER:-}" ]; then chown "$SUDO_USER" "$BASE/users"; fi
echo "dovecot ready (CA: $BASE/ca.pem)"
