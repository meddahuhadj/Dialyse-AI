#!/usr/bin/env bash
# Self-signed TLS cert for local HTTPS (POC / dev only — navigateur affichera un avertissement).
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/C=FR/O=HADJ Dialysis Intelligence/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
chmod 600 "$DIR/key.pem"
echo "OK → $DIR/{key.pem,cert.pem}. Redémarrez le serveur : il passera en HTTPS."
