FROM postgres:16-alpine

# age encrypts to a public key, so this container can write a backup and
# cannot read yesterday's (KEHOACH 4.8).
RUN apk add --no-cache age tzdata

COPY backup.sh restore-drill.sh wal-push.sh retention.sh table-growth.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore-drill.sh \
    /usr/local/bin/wal-push.sh /usr/local/bin/retention.sh \
    /usr/local/bin/table-growth.sh

# A nightly dump, a weekly restore drill, a weekly growth sample and a monthly
# partition sweep, spaced by an hour so no two hold the database at once.
RUN printf '%s\n' \
    '10 2 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1' \
    '30 3 * * 0 /usr/local/bin/restore-drill.sh >> /var/log/backup.log 2>&1' \
    '0 5 * * 1 /usr/local/bin/table-growth.sh >> /var/log/backup.log 2>&1' \
    '0 4 1 * * /usr/local/bin/retention.sh >> /var/log/backup.log 2>&1' \
    > /etc/crontabs/root

CMD ["crond", "-f", "-l", "8"]
