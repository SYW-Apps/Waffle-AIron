<#
.SYNOPSIS
  Create a self-signed Authenticode code-signing certificate for LOCAL testing
  of wairon's Windows binary-signing pipeline.

.DESCRIPTION
  This produces a cert that only machines YOU explicitly trust will honour. It
  is NOT for public distribution — external users would still see "Unknown
  Publisher" and SmartScreen warnings. Swap in a CA-issued certificate (needs a
  registered business) for public trust. Use this to:
    1. Validate the whole signing flow end-to-end now.
    2. Sign binaries you run on your own machines.
    3. Produce the base64 blob for the WINDOWS_CERT_PFX_BASE64 GitHub secret
       (so release.yml's signing step exercises the real path).

.EXAMPLE
  ./scripts/sign/New-SelfSignedCodeSign.ps1 -PfxPassword 'dev-only-pass'
#>
param(
  [string]$Subject         = 'SYW Apps',
  [SecureString]$PfxPassword,
  [string]$OutDir          = $PSScriptRoot,
  [switch]$EmitCiSecret
)

$ErrorActionPreference = 'Stop'

# Prompt securely if no password was supplied — never echoed, never logged.
if (-not $PfxPassword) {
  $PfxPassword = Read-Host -AsSecureString 'Enter a password to protect the PFX (save it in Bitwarden)'
}

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=$Subject" `
  -FriendlyName "$Subject (wairon dev code signing)" `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(3)

$pfxPath = Join-Path $OutDir 'wairon-codesign.pfx'
$cerPath = Join-Path $OutDir 'wairon-codesign.cer'

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $PfxPassword | Out-Null
Export-Certificate    -Cert $cert -FilePath $cerPath | Out-Null

Write-Host ""
Write-Host "Created self-signed code-signing cert for '$Subject'." -ForegroundColor Green
Write-Host "  Thumbprint : $($cert.Thumbprint)"
Write-Host "  PFX (private, for signing / CI secret): $pfxPath"
Write-Host "  CER (public, import to trust)         : $cerPath"
Write-Host ""
Write-Host "-- Trust it on THIS machine (run an elevated PowerShell) --" -ForegroundColor Cyan
Write-Host "  Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\Root"
Write-Host "  Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\TrustedPublisher"
Write-Host ""
Write-Host "-- Sign a binary with it --" -ForegroundColor Cyan
Write-Host "  Set-AuthenticodeSignature -FilePath .\wairon.exe -Certificate (Get-Item Cert:\CurrentUser\My\$($cert.Thumbprint)) ``"
Write-Host "    -TimestampServer http://timestamp.digicert.com -HashAlgorithm SHA256"
Write-Host ""
Write-Host "-- Verify (Status should be 'Valid' once trusted) --" -ForegroundColor Cyan
Write-Host "  Get-AuthenticodeSignature .\wairon.exe | Format-List Status, SignerCertificate"
Write-Host ""
if ($EmitCiSecret) {
  Write-Host "-- base64 for the WINDOWS_CERT_PFX_BASE64 GitHub secret (SENSITIVE) --" -ForegroundColor Cyan
  [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
  Write-Host ""
} else {
  Write-Host "(Re-run with -EmitCiSecret to print the base64 PFX for the GitHub secret.)" -ForegroundColor DarkGray
}
Write-Host "Store the .pfx + its password + the .cer in Bitwarden, then delete the local .pfx." -ForegroundColor Yellow
Write-Host "Do NOT commit the .pfx/.cer (already gitignored)." -ForegroundColor Yellow
