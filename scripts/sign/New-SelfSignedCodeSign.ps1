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
  [string]$Subject     = 'SYW Apps',
  [string]$PfxPassword = 'wairon-dev',
  [string]$OutDir      = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=$Subject" `
  -FriendlyName "$Subject (wairon dev code signing)" `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(3)

$pwd     = ConvertTo-SecureString -String $PfxPassword -Force -AsPlainText
$pfxPath = Join-Path $OutDir 'wairon-codesign.pfx'
$cerPath = Join-Path $OutDir 'wairon-codesign.cer'

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null
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
Write-Host "-- base64 for the WINDOWS_CERT_PFX_BASE64 GitHub secret --" -ForegroundColor Cyan
[Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
Write-Host ""
Write-Host "Do NOT commit the .pfx/.cer (already gitignored). Keep the PFX password private." -ForegroundColor Yellow
