FROM postgres:16-alpine

# age encrypts to a public key, so this container can write a backup and
# cannot read yesterday's (KEHOACH 4.8).
RUN apk add --no-cache age rclone tzdata zstd

# restore-drill.sh stays out: it needs the private key, which never reaches this box (KEHOACH 9.22.2).
COPY backup.sh wal-push.sh pg-start.sh offsite.sh retention.sh table-growth.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/wal-push.sh /usr/local/bin/pg-start.sh \
    /usr/local/bin/offsite.sh /usr/local/bin/retention.sh /usr/local/bin/table-growth.sh

# The offsite copy never holds the database; the nightly backup, weekly growth
# sample and monthly partition sweep sit an hour apart so no two do at once.
RUN printf '%s\n' \
    '*/5 * * * * /usr/local/bin/offsite.sh >> /var/log/backup.log 2>&1' \
    '10 2 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1' \
    '0 5 * * 1 /usr/local/bin/table-growth.sh >> /var/log/backup.log 2>&1' \
    '0 4 1 * * /usr/local/bin/retention.sh >> /var/log/backup.log 2>&1' \
    > /etc/crontabs/root

# deploy.sh compares this hash of deploy/backup with the checkout to know when to rebuild.
ARG INPUTS=unset
LABEL cckiosk.inputs=$INPUTS

CMD ["crond", "-f", "-l", "8"]
