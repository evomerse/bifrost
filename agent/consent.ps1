# Bifrost consent dialog. Prints YES or NO on stdout.
# The agent kills this process after a timeout, which counts as a refusal.
# ASCII only on purpose: the texts come from the agent as arguments.
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$Title
)
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$owner.Show()
$result = [System.Windows.Forms.MessageBox]::Show(
  $owner, $Text, $Title,
  [System.Windows.Forms.MessageBoxButtons]::YesNo,
  [System.Windows.Forms.MessageBoxIcon]::Warning,
  [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.WriteLine('YES') } else { [Console]::Out.WriteLine('NO') }
[Console]::Out.Flush()
