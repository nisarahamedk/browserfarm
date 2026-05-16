# Run this from an Administrator PowerShell on the Windows browserfarm host.

New-NetFirewallRule `
  -DisplayName "browserfarm gateway 8787" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 8787 `
  -Action Allow `
  -Profile Any

New-NetFirewallRule `
  -DisplayName "browserfarm Chrome CDP ports" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 1024-65535 `
  -Action Allow `
  -Profile Any
