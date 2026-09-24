FROM postgres:16-alpine

# age encrypts to a public key, so this container can write a backup and
# cannot read yesterday's (KEHOACH 4.8).
RUN apk add --no-cache age tzdata

# restore-drill.sh stays out: it needs the private key, which never reaches this box (KEHOACH 9.22.2).
COPY backup.sh wal-push.sh retention.sh table-growth.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/wal-push.sh \
    /usr/local/bin/retention.sh /usr/local/bin/table-growth.sh

# A nightly dump, a weekly growth sample and a monthly partition sweep, spaced
# by an hour so no two hold the database at once.
RUN printf '%s\n' \
    '10 2 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1' \
    '0 5 * * 1 /usr/local/bin/table-growth.sh >> /var/log/backup.log 2>&1' \
    '0 4 1 * * /usr/local/bin/retention.sh >> /var/log/backup.log 2>&1' \
    > /etc/crontabs/root

CMD ["crond", "-f", "-l", "8"]
