# Bifrost "session active" indicator: an always-on-top banner with a Stop button.
# Prints STOP on stdout when the user clicks the button. The agent shows it for the whole
# duration of any session, so a remote session is never invisible to the person at the PC.
# ASCII only on purpose: the texts come from the agent as arguments.
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$StopLabel,
  [int]$ParentPid = 0
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.BackColor = [System.Drawing.Color]::FromArgb(176, 32, 32)
$form.Size = New-Object System.Drawing.Size(520, 40)
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($area.Left + [int](($area.Width - 520) / 2)), $area.Top)

$label = New-Object System.Windows.Forms.Label
$label.Text = $Text
$label.ForeColor = [System.Drawing.Color]::White
$label.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$label.AutoSize = $false
$label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$label.Location = New-Object System.Drawing.Point(12, 0)
$label.Size = New-Object System.Drawing.Size(380, 40)

$button = New-Object System.Windows.Forms.Button
$button.Text = $StopLabel
$button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$button.BackColor = [System.Drawing.Color]::White
$button.Location = New-Object System.Drawing.Point(400, 6)
$button.Size = New-Object System.Drawing.Size(110, 28)
$button.Add_Click({
  [Console]::Out.WriteLine('STOP')
  [Console]::Out.Flush()
  $form.Close()
})

$form.Controls.Add($label)
$form.Controls.Add($button)

# If the agent dies, close the banner instead of leaving a stale "session active" notice.
if ($ParentPid -gt 0) {
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 2000
  $timer.Add_Tick({
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { $form.Close() }
  })
  $timer.Start()
}

[System.Windows.Forms.Application]::Run($form)
