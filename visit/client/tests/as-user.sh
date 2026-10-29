#!/bin/sh
# Runs the rest of its arguments in a test container as AS_UID:AS_GID (this machine's user, so what it writes to the
# mounted volumes is theirs), a user the container knows: Postgres won't run as root, and initdb asks the system
# for the user's name. The container starts as root, says who that user is in its own /etc/passwd, and drops to it.
# (Lending the host's /etc/passwd fails where the Docker daemon's host is another machine's, as on a dind runner.)
set -eu
echo "tester:x:${AS_UID}:${AS_GID}::/tmp:/bin/sh" >> /etc/passwd
exec setpriv --reuid="$AS_UID" --regid="$AS_GID" --clear-groups env HOME=/tmp "$@"
