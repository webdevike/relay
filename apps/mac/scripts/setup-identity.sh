#!/bin/sh
# One-time: create a local self-signed code-signing identity named "Relay Local Signing" in the
# login keychain, so bundle.sh can sign Relay.app with a STABLE identity. macOS keys the app's
# Accessibility grant to that identity's designated requirement, so it survives every rebuild
# (ad-hoc signing keys to the binary's cdhash and resets the grant every time; see
# Sources/RelayCore/Input/README.md). No Apple Developer account needed. Safe to re-run; it
# no-ops if already present.
set -euo pipefail

IDENTITY="Relay Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
	echo "'$IDENTITY' already present."
	exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# self-signed cert with the codeSigning EKU
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
	-keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
	-subj "/CN=$IDENTITY" \
	-addext "extendedKeyUsage=codeSigning" \
	-addext "basicConstraints=critical,CA:false" \
	-addext "keyUsage=critical,digitalSignature" >/dev/null 2>&1

# -legacy: macOS `security` cannot read OpenSSL 3's modern PKCS12 MAC
openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
	-out "$TMP/id.p12" -passout pass:relay -name "$IDENTITY" >/dev/null 2>&1

security import "$TMP/id.p12" -k "$KEYCHAIN" -P relay -T /usr/bin/codesign -A >/dev/null 2>&1

# trust it for code signing so it shows under `find-identity -p codesigning`
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem" >/dev/null 2>&1

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
	echo "created '$IDENTITY'. now run: sh scripts/bundle.sh"
else
	echo "failed to create '$IDENTITY'; check keychain access." >&2
	exit 1
fi
