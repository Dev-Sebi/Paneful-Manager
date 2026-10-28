# Tests install.ps1 without touching the system: wsl.exe and the ScheduledTasks cmdlets are replaced by functions (a
# function wins over an application or cmdlet of the same name), so no distro, WSL setting or task is ever changed.
# Runs under Windows PowerShell 5.1 and PowerShell 7 (also on Linux). Usage: powershell -NoProfile -NonInteractive
# -ExecutionPolicy Bypass -File scripts/test-install-ps1.ps1   (from WSL: sh scripts/test-install-ps1.sh)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'install.ps1'))
$script:Tests = 0
$script:Fails = 0
$script:Out = ''
$WslEnvBefore = $env:WSLENV

function wsl.exe {
  $line = $args -join ' '
  [void]$global:PmCalls.Add($line)
  $stub = $global:PmStub
  $global:LASTEXITCODE = 0
  if ($line -eq '--status') { $global:LASTEXITCODE = $stub.WslStatus; return }
  if ($line -eq '--list --quiet') { return $stub.Distros }
  if ($line -eq '--shutdown') { $stub.Init = $stub.InitAfterShutdown; return }
  if ($line -like '--install*') { return }
  if ($line -eq '-e sh -c echo $WSL_DISTRO_NAME') { return $stub.DefaultDistro }
  if ($line -like '-d * -e uname -r') { return $stub.Kernel }
  if ($line -like '-d * -e id -u') { return $stub.Uid }
  if ($line -like '-d * -e ps -p 1 -o comm=') { return $stub.Init }
  if ($line -like '-d * --cd ~ -e sh -c *') {
    [void]$global:PmCalls.Add("ENV url=$($env:PM_INSTALL_URL) args=$($env:PM_INSTALL_ARGS) repo=$($env:PANEFUL_MANAGER_REPO) wslenv=$($env:WSLENV)")
    Write-Output 'install.sh ran'
    $global:LASTEXITCODE = $stub.InstallExit
    return
  }
  throw "unexpected wsl.exe call: $line"
}

function Get-ScheduledTask([string]$TaskName) {
  [void]$global:PmCalls.Add("Get-ScheduledTask $TaskName")
  if ($global:PmStub.Tasks -contains $TaskName) { return [pscustomobject]@{ TaskName = $TaskName } }
  return $null
}
function Register-ScheduledTask([string]$TaskName) { [void]$global:PmCalls.Add("Register-ScheduledTask $TaskName") }
function Unregister-ScheduledTask([string]$TaskName) { [void]$global:PmCalls.Add("Unregister-ScheduledTask $TaskName") }
function New-ScheduledTaskAction { [void]$global:PmCalls.Add("New-ScheduledTaskAction $($args -join ' ')"); return 'action' }
function New-ScheduledTaskTrigger { return 'trigger' }
function New-ScheduledTaskSettingsSet { return 'settings' }

$Guarded = @('wsl.exe', 'Get-ScheduledTask', 'Register-ScheduledTask', 'Unregister-ScheduledTask', 'New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'New-ScheduledTaskSettingsSet')
foreach ($name in $Guarded) {
  if ((Get-Command $name).CommandType -ne 'Function') { throw "$name is not stubbed; refusing to run" }
}

function New-Stub([hashtable]$Overrides = @{}) {
  $stub = @{
    WslStatus = 0
    Distros = @('Ubuntu')
    DefaultDistro = 'Ubuntu'
    Kernel = '5.15.167.4-microsoft-standard-WSL2'
    Uid = '1000'
    Init = 'systemd'
    InitAfterShutdown = 'systemd'
    InstallExit = 0
    Tasks = @()
  }
  foreach ($key in $Overrides.Keys) { $stub[$key] = $Overrides[$key] }
  return $stub
}

# Runs install.ps1 the way 'irm | iex' does (a script block, no file), with the given stub, environment and arguments.
function Invoke-Installer([hashtable]$Stub, [hashtable]$Environment = @{}, [object[]]$Arguments = @()) {
  $global:PmStub = $Stub
  $global:PmCalls = New-Object System.Collections.ArrayList
  foreach ($name in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'PANEFUL_MANAGER_*' -or $_.Name -like 'PM_INSTALL_*' } | ForEach-Object { $_.Name })) {
    Remove-Item "Env:$name"
  }
  foreach ($key in $Environment.Keys) { Set-Item "Env:$key" $Environment[$key] }
  $script:PmCode = $null
  try {
    $script:Out = (& ([scriptblock]::Create($source)) @Arguments *>&1 | Out-String)
  } finally {
    foreach ($key in $Environment.Keys) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue }
  }
  $script:Calls = ($global:PmCalls -join "`n")
}

function Check([string]$Name, [bool]$Condition) {
  $script:Tests++
  if ($Condition) {
    Write-Host "ok   $Name"
  } else {
    $script:Fails++
    Write-Host "FAIL $Name"
    Write-Host ($script:Out -replace '(?m)^', '    ')
    Write-Host ($script:Calls -replace '(?m)^', '    | ')
  }
}
function OutHas([string]$Text) { return $script:Out.Contains($Text) }
function CallsHave([string]$Text) { return $script:Calls.Contains($Text) }

$latest = 'https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.sh'

# ---------- dry run ----------

Invoke-Installer (New-Stub) @{ PANEFUL_MANAGER_DRY_RUN = '1' }
Check 'dry run: succeeds' ($script:PmCode -eq 0)
Check 'dry run: says so' (OutHas 'Dry run: nothing will be changed')
Check 'dry run: runs install.sh with --dry-run' (CallsHave "args=--yes --no-wsl-conf --no-windows-task --dry-run")
Check 'dry run: registers no task' (-not (CallsHave 'Register-ScheduledTask'))
Check 'dry run: prints the task step' (OutHas "+ Register-ScheduledTask -TaskName 'paneful-manager-Ubuntu'")
Check 'dry run: no shutdown' (-not (CallsHave '--shutdown'))

Invoke-Installer (New-Stub @{ Init = 'init' }) @{ PANEFUL_MANAGER_DRY_RUN = '1' }
Check 'dry run without systemd: enables it only in dry-run mode' (CallsHave 'args=--enable-wsl-systemd --yes --dry-run')
Check 'dry run without systemd: prints the shutdown' (OutHas '+ wsl.exe --shutdown')
Check 'dry run without systemd: never shuts WSL down' (-not (CallsHave "`n--shutdown"))

# ---------- install ----------

Invoke-Installer (New-Stub) @{ PANEFUL_MANAGER_YES = '1'; PANEFUL_MANAGER_PORT = '7400' }
Check 'install: succeeds' ($script:PmCode -eq 0)
Check 'install: runs the latest install.sh' (CallsHave "ENV url=$latest ")
Check 'install: passes the port' (CallsHave 'args=--yes --no-wsl-conf --no-windows-task --port 7400 ')
Check 'install: shares the values through WSLENV' (CallsHave 'PM_INSTALL_URL:PM_INSTALL_ARGS:PANEFUL_MANAGER_REPO')
Check 'install: runs in the home directory of the distro' (CallsHave '-d Ubuntu --cd ~ -e sh -c f=$(mktemp)')
Check 'install: a failed download fails the step' (CallsHave 'curl -fsSL --proto =https --tlsv1.2 -o $f $PM_INSTALL_URL && sh $f $PM_INSTALL_ARGS; c=$?')
Check 'install: no double quotes through the wsl.exe command line' (-not ($script:Calls -match '--cd ~ -e sh -c [^\n]*"'))
Check 'install: registers the logon task once' (([regex]::Matches($script:Calls, 'Register-ScheduledTask')).Count -eq 1)
Check 'install: task boots the distro' (CallsHave 'New-ScheduledTaskAction -Execute wsl.exe -Argument -d Ubuntu --exec true')
Check 'install: tells how to get a login URL' (OutHas 'install.sh --login-url')
Check 'install: restores the environment' ($null -eq $env:PM_INSTALL_URL -and $env:WSLENV -eq $WslEnvBefore)

Invoke-Installer (New-Stub @{ Tasks = @('paneful-manager-Ubuntu') }) @{ PANEFUL_MANAGER_YES = '1'; PANEFUL_MANAGER_VERSION = 'v0.2.0'; PANEFUL_MANAGER_REPO = 'someone/fork' }
Check 'version: runs that release''s install.sh' (CallsHave 'ENV url=https://github.com/someone/fork/releases/download/v0.2.0/install.sh ')
Check 'version: passes --version' (CallsHave '--version v0.2.0')
Check 'repo: passes the repository into WSL' (CallsHave 'repo=someone/fork')
Check 'existing task: kept' ((OutHas 'already exists') -and -not (CallsHave 'Register-ScheduledTask'))

Invoke-Installer (New-Stub) @{ PANEFUL_MANAGER_YES = '1'; PANEFUL_MANAGER_NO_WINDOWS_TASK = '1' }
Check 'no windows task: none registered' (-not (CallsHave 'Register-ScheduledTask'))

Invoke-Installer (New-Stub @{ InstallExit = 1 }) @{ PANEFUL_MANAGER_YES = '1' }
Check 'failed install.sh: reported' ($script:PmCode -eq 1 -and (OutHas 'install.sh failed in Ubuntu'))
Check 'failed install.sh: no task' (-not (CallsHave 'Register-ScheduledTask'))

# ---------- systemd ----------

Invoke-Installer (New-Stub @{ Init = 'init'; InitAfterShutdown = 'systemd' }) @{ PANEFUL_MANAGER_YES = '1' }
Check 'systemd off: enabled as root' (CallsHave '-d Ubuntu -u root --cd ~')
Check 'systemd off: through install.sh --enable-wsl-systemd' (CallsHave 'args=--enable-wsl-systemd --yes ')
Check 'systemd off: WSL restarted' (CallsHave "`n--shutdown")
Check 'systemd off: then installed' ($script:PmCode -eq 0 -and (CallsHave 'args=--yes --no-wsl-conf'))
Check 'systemd off: warns that all distros stop' (OutHas 'stops ALL running distros')

Invoke-Installer (New-Stub @{ Init = 'init'; InitAfterShutdown = 'init' }) @{ PANEFUL_MANAGER_YES = '1' }
Check 'systemd still off: stops with a hint' ($script:PmCode -eq 1 -and (OutHas 'systemd still does not run'))
Check 'systemd still off: nothing installed' (-not (CallsHave 'args=--yes --no-wsl-conf'))

Invoke-Installer (New-Stub @{ Init = 'init' })
Check 'systemd off without a console: nothing changed' ($script:PmCode -eq 1 -and -not (CallsHave '--shutdown') -and -not (CallsHave '-u root'))
Check 'systemd off without a console: manual steps' (OutHas "add '[boot]' and 'systemd=true'")

# ---------- distros ----------

Invoke-Installer (New-Stub @{ Kernel = '4.4.0-19041-Microsoft' }) @{ PANEFUL_MANAGER_YES = '1' }
Check 'WSL 1: refused with the conversion hint' ($script:PmCode -eq 1 -and (OutHas 'wsl --set-version Ubuntu 2'))

Invoke-Installer (New-Stub @{ Uid = '0' })
Check 'root default user: refused without consent' ($script:PmCode -eq 1 -and (OutHas 'default user of Ubuntu is root') -and -not (CallsHave '--cd ~'))

Invoke-Installer (New-Stub @{ Distros = @('docker-desktop', 'Debian', 'Ubuntu'); DefaultDistro = 'docker-desktop' }) @{ PANEFUL_MANAGER_YES = '1' }
Check 'docker-desktop is never picked' (CallsHave '-d Debian --cd ~')

Invoke-Installer (New-Stub @{ Distros = @('Debian', 'Ubuntu') }) @{ PANEFUL_MANAGER_YES = '1'; PANEFUL_MANAGER_DISTRO = 'Debian' }
Check 'PANEFUL_MANAGER_DISTRO picks the distro' ((CallsHave '-d Debian --cd ~') -and (CallsHave 'Register-ScheduledTask paneful-manager-Debian'))

Invoke-Installer (New-Stub) @{ PANEFUL_MANAGER_YES = '1'; PANEFUL_MANAGER_DISTRO = 'Nope' }
Check 'unknown distro: refused' ($script:PmCode -eq 1 -and (OutHas "WSL distro 'Nope' not found"))

Invoke-Installer (New-Stub @{ Distros = @() }) @{ PANEFUL_MANAGER_YES = '1' }
Check 'no distro: installs Ubuntu' (CallsHave '--install -d Ubuntu')
Check 'no distro: stops after it with the next step' ($script:PmCode -eq 1 -and (OutHas 'run the installer again') -and -not (CallsHave '--cd ~'))

# ---------- WSL missing ----------

Invoke-Installer (New-Stub @{ WslStatus = 1 }) @{ PANEFUL_MANAGER_YES = '1' }
Check 'WSL missing: next steps printed' ($script:PmCode -eq 1 -and (OutHas 'wsl --install') -and (OutHas 'Restart Windows'))
Check 'WSL missing: never loops into the install' (-not (CallsHave '--cd ~') -and -not (CallsHave '--list'))

# ---------- uninstall ----------

Invoke-Installer (New-Stub @{ Tasks = @('paneful-manager-Ubuntu', 'AgentHub-Ubuntu') }) @{ PANEFUL_MANAGER_YES = '1'; PANEFUL_MANAGER_UNINSTALL = '1' }
Check 'uninstall: runs install.sh --uninstall' (CallsHave 'args=--uninstall --no-windows-task --yes ')
Check 'uninstall: removes the logon task' (CallsHave 'Unregister-ScheduledTask paneful-manager-Ubuntu')
Check 'uninstall: removes the pre-rename task' (CallsHave 'Unregister-ScheduledTask AgentHub-Ubuntu')
Check 'uninstall: no systemd changes' (-not (CallsHave '-u root') -and -not (CallsHave '--shutdown'))

Invoke-Installer (New-Stub @{ Tasks = @('paneful-manager-Ubuntu') }) @{} @('-Uninstall', '-DryRun')
Check '-Uninstall -DryRun: install.sh in dry-run mode' (CallsHave 'args=--uninstall --no-windows-task --dry-run ')
Check '-Uninstall -DryRun: no task removed' (-not (CallsHave 'Unregister-ScheduledTask'))

# ---------- options ----------

Invoke-Installer (New-Stub) @{ PANEFUL_MANAGER_PORT = '70000' }
Check 'invalid port: refused before WSL is touched' ($script:PmCode -eq 2 -and $global:PmCalls.Count -eq 0)
Invoke-Installer (New-Stub) @{} @('-Bogus')
Check 'unknown option: refused' ($script:PmCode -eq 2 -and (OutHas 'Unknown option: -Bogus'))
Invoke-Installer (New-Stub) @{ PANEFUL_MANAGER_REPO = 'a/b c' }
Check 'odd repo: refused' ($script:PmCode -eq 2)
Invoke-Installer (New-Stub) @{ PANEFUL_MANAGER_YES = '1' } @('-Port', '7500', '-Distro', 'Ubuntu')
Check 'arguments: -Port and -Distro' (CallsHave '--port 7500')

Check 'install.ps1 is plain ASCII (irm decodes it without a charset)' (-not ($source -match '[^\x00-\x7F]'))

Write-Host ''
Write-Host "$($script:Tests) tests, $($script:Fails) failed"
if ($script:Fails -gt 0) { exit 1 }
exit 0
