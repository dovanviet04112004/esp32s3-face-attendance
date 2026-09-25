#!/usr/bin/env bash
# Rebuild the Android shell from twa-manifest.json and sign it (KEHOACH 9.21.7).
# Needs ~/.bubblewrap/config.json (JDK 17, Android SDK) and android/signing.env beside the keystore.
set -euo pipefail
cd "$(dirname "$0")"

BUBBLEWRAP="npx -y @bubblewrap/cli@1.25.0"
OUT="nhan-luc.apk"

if [ ! -f signing.env ] || [ ! -f nhanluc.keystore ]; then
  echo "signing.env or nhanluc.keystore missing: restore them from the owner's backup" >&2
  exit 1
fi
set -a
. ./signing.env
set +a

$BUBBLEWRAP update --skipVersionUpgrade < /dev/null
$BUBBLEWRAP build --skipPwaValidation < /dev/null
cp app-release-signed.apk "$OUT"
sha256sum "$OUT"
