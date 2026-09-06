# Self-signed TLS cert for local HTTPS (POC / dev only).
# Nécessite OpenSSL dans le PATH (fourni avec Git for Windows : "C:\Program Files\Git\usr\bin\openssl.exe").
$ErrorActionPreference = 'Stop'
$certDir = Join-Path $PSScriptRoot '..\certs'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
& openssl req -x509 -newkey rsa:2048 -nodes -days 365 `
  -keyout (Join-Path $certDir 'key.pem') -out (Join-Path $certDir 'cert.pem') `
  -subj "/C=FR/O=HADJ Dialysis Intelligence/CN=localhost" `
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
Write-Host "OK -> $certDir\{key.pem,cert.pem}. Redemarrez le serveur : il passera en HTTPS."
