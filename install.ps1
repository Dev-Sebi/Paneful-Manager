# Paneful Manager installer for Windows: sets up WSL2 with systemd, runs install.sh inside the distro and registers
# the logon task that boots the distro. Windows PowerShell 5.1 or PowerShell 7, no admin rights unless WSL is missing.
#   irm https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.ps1 | iex
# Options come from environment variables, because 'irm | iex' cannot pass arguments (see docs/install.md):
#   PANEFUL_MANAGER_DISTRO=<name>   WSL distro to install into (default: the default distro)
#   PANEFUL_MANAGER_PORT=<port>     server port, passed to install.sh --port
#   PANEFUL_MANAGER_VERSION=<tag>   release to install (default: latest)
#   PANEFUL_MANAGER_REPO=<o>/<r>    GitHub repository to download from
#   PANEFUL_MANAGER_UNINSTALL=1     uninstall instead (or: .\install.ps1 -Uninstall)
#   PANEFUL_MANAGER_YES=1           answer yes to every question (or -Yes)
#   PANEFUL_MANAGER_DRY_RUN=1       print every step, change nothing (or -DryRun); install.sh runs with --dry-run
#   PANEFUL_MANAGER_NO_WINDOWS_TASK=1  never create or remove the logon task (or -NoWindowsTask)
# No param() block and no 'exit' under 'irm | iex' (it would close the console). Steps that run wsl.exe interactively are
# never captured, so wsl.exe keeps the console (install.sh can ask for a sudo password); they report in $script:PmCode.

function Write-PmInfo([string]$Message) { Write-Host "==> $Message" }
function Write-PmSay([string]$Message) { Write-Host $Message }
function Write-PmWarn([string]$Message) { Write-Host "Warning: $Message" -ForegroundColor Yellow }
function Write-PmError([string]$Message) { Write-Host "Error: $Message" -ForegroundColor Red }

function Test-PmFlag([string]$Value) { return ($Value -eq '1' -or $Value -eq 'true' -or $Value -eq 'yes') }

# Reads the options from the environment, then from script arguments (-Uninstall, -Yes, -DryRun, -NoWindowsTask,
# -Distro <name>, -Port <port>, -Version <tag>).
function Get-PmOptions([object[]]$Arguments) {
  $options = @{
    Distro = $env:PANEFUL_MANAGER_DISTRO
    Port = $env:PANEFUL_MANAGER_PORT
    Version = $env:PANEFUL_MANAGER_VERSION
    Repo = $env:PANEFUL_MANAGER_REPO
    Uninstall = Test-PmFlag $env:PANEFUL_MANAGER_UNINSTALL
    Yes = Test-PmFlag $env:PANEFUL_MANAGER_YES
    DryRun = Test-PmFlag $env:PANEFUL_MANAGER_DRY_RUN
    NoWindowsTask = Test-PmFlag $env:PANEFUL_MANAGER_NO_WINDOWS_TASK
  }
  $i = 0
  while ($null -ne $Arguments -and $i -lt $Arguments.Count) {
    $arg = [string]$Arguments[$i]
    switch -regex ($arg) {
      '^-Uninstall$' { $options.Uninstall = $true }
      '^-Yes$' { $options.Yes = $true }
      '^-DryRun$' { $options.DryRun = $true }
      '^-NoWindowsTask$' { $options.NoWindowsTask = $true }
      '^-(Distro|Port|Version)$' {
        if ($i + 1 -ge $Arguments.Count) { throw "$arg needs a value" }
        $options[$arg.Substring(1)] = [string]$Arguments[$i + 1]
        $i++
      }
      default { throw "Unknown option: $arg" }
    }
    $i++
  }
  if ([string]::IsNullOrEmpty($options.Repo)) { $options.Repo = 'Dev-Sebi/Paneful-Manager' }
  if ($options.Repo -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') { throw 'PANEFUL_MANAGER_REPO must look like <owner>/<repo>' }
  if (-not [string]::IsNullOrEmpty($options.Port)) {
    $port = 0
    if (-not [int]::TryParse($options.Port, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'PANEFUL_MANAGER_PORT must be a number between 1 and 65535' }
  }
  if (-not [string]::IsNullOrEmpty($options.Version) -and $options.Version -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid release tag: '$($options.Version)'" }
  if (-not [string]::IsNullOrEmpty($options.Distro) -and $options.Distro -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid distro name: '$($options.Distro)'" }
  return $options
}

# confirm: -Yes answers yes, a dry run assumes yes, without a console the answer is no.
function Confirm-Pm([hashtable]$Options, [string]$Question, [bool]$Default) {
  if ($Options.Yes) { return $true }
  if ($Options.DryRun) {
    Write-PmSay "  (dry run) would ask: $Question -> assuming yes"
    return $true
  }
  $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
  try {
    $answer = Read-Host "$Question $hint"
  } catch {
    Write-PmSay "  $Question -> no (no console to ask). Set PANEFUL_MANAGER_YES=1 to accept every question."
    return $false
  }
  if ($answer -match '^[Yy]') { return $true }
  if ($answer -match '^[Nn]') { return $false }
  return $Default
}

# Runs wsl.exe and returns its output lines (UTF-16 from older wsl.exe is cleaned up); sets $LASTEXITCODE.
function Invoke-PmWslCapture([string[]]$WslArgs) {
  $previous = $env:WSL_UTF8
  $env:WSL_UTF8 = '1'
  try {
    $output = & wsl.exe @WslArgs 2>$null
  } finally {
    $env:WSL_UTF8 = $previous
  }
  $lines = @()
  foreach ($line in @($output)) {
    $clean = ([string]$line) -replace "`0", ''
    $clean = $clean.Trim()
    if ($clean.Length -gt 0) { $lines += $clean }
  }
  return $lines
}

# First output line of a wsl.exe call, or an empty string.
function Get-PmWslLine([string[]]$WslArgs) {
  $lines = @(Invoke-PmWslCapture $WslArgs)
  if ($lines.Count -eq 0) { return '' }
  return [string]$lines[0]
}

# Prints a wsl.exe command that changes the system, then runs it on the console unless dry run; sets $script:PmCode.
function Invoke-PmWslStep([hashtable]$Options, [string[]]$WslArgs) {
  Write-PmSay ("  + wsl.exe " + ($WslArgs -join ' '))
  $script:PmCode = 0
  if ($Options.DryRun) { return }
  & wsl.exe @WslArgs
  $script:PmCode = $LASTEXITCODE
}

function Test-PmAdmin {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

function Get-PmInstallShUrl([hashtable]$Options) {
  if ([string]::IsNullOrEmpty($Options.Version)) {
    return "https://github.com/$($Options.Repo)/releases/latest/download/install.sh"
  }
  return "https://github.com/$($Options.Repo)/releases/download/$($Options.Version)/install.sh"
}

# Runs install.sh from the release inside the distro on the console; sets $script:PmCode. Values travel in environment
# variables shared through WSLENV, so nothing needs quoting through wsl.exe's command line (the script has no double quotes).
function Invoke-PmInstallSh([hashtable]$Options, [string]$Distro, [string[]]$InstallArgs, [string]$User = '') {
  $saved = @{ WSLENV = $env:WSLENV; PM_INSTALL_URL = $env:PM_INSTALL_URL; PM_INSTALL_ARGS = $env:PM_INSTALL_ARGS; PANEFUL_MANAGER_REPO = $env:PANEFUL_MANAGER_REPO }
  $env:PM_INSTALL_URL = Get-PmInstallShUrl $Options
  $env:PM_INSTALL_ARGS = $InstallArgs -join ' '
  $env:PANEFUL_MANAGER_REPO = $Options.Repo
  $shared = 'PM_INSTALL_URL:PM_INSTALL_ARGS:PANEFUL_MANAGER_REPO'
  $env:WSLENV = if ([string]::IsNullOrEmpty($saved.WSLENV)) { $shared } else { "$($saved.WSLENV):$shared" }
  $wslArgs = @('-d', $Distro)
  if ($User -ne '') { $wslArgs += @('-u', $User) }
  # Downloaded to a file first: with 'curl | sh' a failed download would end as a successful empty script.
  $shell = 'f=$(mktemp) || exit 1; curl -fsSL --proto =https --tlsv1.2 -o $f $PM_INSTALL_URL && sh $f $PM_INSTALL_ARGS; c=$?; rm -f $f; exit $c'
  $wslArgs += @('--cd', '~', '-e', 'sh', '-c', $shell)
  try {
    Write-PmSay "  + wsl.exe -d $Distro$(if ($User -ne '') { " -u $User" }) -- sh install.sh $($env:PM_INSTALL_ARGS)   (from $($env:PM_INSTALL_URL))"
    & wsl.exe @wslArgs
    $script:PmCode = $LASTEXITCODE
  } finally {
    foreach ($key in $saved.Keys) {
      if ($null -eq $saved[$key]) {
        Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue
      } else {
        Set-Item -Path "Env:$key" -Value $saved[$key]
      }
    }
  }
}

function Get-PmTaskName([string]$Distro) { return "paneful-manager-$Distro" }

# True when %UserProfile%\.wslconfig sets instanceIdleTimeout=-1.
function Test-PmWslConfigKeepsDistro {
  if ([string]::IsNullOrEmpty($env:USERPROFILE)) { return $false }
  $file = Join-Path $env:USERPROFILE '.wslconfig'
  if (-not (Test-Path -LiteralPath $file)) { return $false }
  return [bool](Select-String -LiteralPath $file -Pattern '^\s*instanceIdleTimeout\s*=\s*-1\s*$' -Quiet)
}

function Install-PmWindowsTask([hashtable]$Options, [string]$Distro) {
  if ($Options.NoWindowsTask) { return }
  $task = Get-PmTaskName $Distro
  if (-not $Options.DryRun -and $null -ne (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) {
    Write-PmSay "  Windows logon task $task already exists"
    return
  }
  Write-PmInfo 'Windows logon task'
  Write-PmSay "  WSL does not start on its own after Windows boots. The task $task runs"
  Write-PmSay "  'wsl.exe -d $Distro --exec true' at your logon, so systemd starts Paneful Manager. No admin rights needed."
  if (Test-PmWslConfigKeepsDistro) {
    Write-PmSay '  Your .wslconfig already sets instanceIdleTimeout=-1, so the distro stays up after the task ran.'
  } else {
    Write-PmSay "  WSL stops an idle distro after instanceIdleTimeout (default 15 s). For the sessions to keep running, add"
    Write-PmSay "  'instanceIdleTimeout=-1' under [general] in %UserProfile%\.wslconfig, then run 'wsl --shutdown' once."
  }
  if (-not (Confirm-Pm $Options "Create the Windows logon task $task?" $true)) {
    Write-PmSay '  Skipped.'
    return
  }
  Write-PmSay "  + Register-ScheduledTask -TaskName '$task' (wsl.exe -d $Distro --exec true, at logon of $($env:USERDOMAIN)\$($env:USERNAME))"
  if ($Options.DryRun) { return }
  try {
    $action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro --exec true"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$($env:USERDOMAIN)\$($env:USERNAME)"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $task -Description "Boots the WSL distro $Distro for Paneful Manager" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  } catch {
    Write-PmWarn "Registering the task failed: $($_.Exception.Message). See docs/install.md (Windows logon task)."
  }
}

# remove: the current task and the one of the pre-rename agent-hub install.
function Remove-PmWindowsTasks([hashtable]$Options, [string]$Distro) {
  if ($Options.NoWindowsTask) { return }
  foreach ($task in @((Get-PmTaskName $Distro), "AgentHub-$Distro")) {
    if (-not $Options.DryRun -and $null -eq (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) { continue }
    Write-PmSay "  + Unregister-ScheduledTask -TaskName '$task'"
    if ($Options.DryRun) { continue }
    try {
      Unregister-ScheduledTask -TaskName $task -Confirm:$false
    } catch {
      Write-PmWarn "Removing the task $task failed; remove it in the Task Scheduler"
    }
  }
}

function Show-PmWslInstallSteps([hashtable]$Options) {
  Write-PmSay ''
  Write-PmSay 'Next steps:'
  Write-PmSay '  1. Open PowerShell as Administrator and run:  wsl --install'
  Write-PmSay '  2. Restart Windows when asked.'
  Write-PmSay '  3. Open Ubuntu from the Start menu once and create your Linux user.'
  Write-PmSay "  4. Run the installer again:  irm https://github.com/$($Options.Repo)/releases/latest/download/install.ps1 | iex"
}

# Sets $script:PmDistro to the distro to install into, or $null after printing what to do.
function Select-PmDistro([hashtable]$Options) {
  $script:PmDistro = $null
  $all = @(Invoke-PmWslCapture @('--list', '--quiet'))
  $names = @($all | Where-Object { $_ -notmatch '^docker-desktop' })
  if (-not [string]::IsNullOrEmpty($Options.Distro)) {
    if ($names -notcontains $Options.Distro) {
      Write-PmError "WSL distro '$($Options.Distro)' not found. Installed: $(if ($names.Count -gt 0) { $names -join ', ' } else { 'none' })"
      return
    }
    $script:PmDistro = $Options.Distro
    return
  }
  if ($names.Count -eq 0) {
    Write-PmInfo 'No Linux distro in WSL'
    Write-PmSay '  Paneful Manager needs a Linux distro with systemd; Ubuntu is recommended.'
    if (Confirm-Pm $Options 'Install Ubuntu now (wsl --install -d Ubuntu)?' $true) {
      Invoke-PmWslStep $Options @('--install', '-d', 'Ubuntu')
      if ($script:PmCode -ne 0) { Write-PmError "wsl --install -d Ubuntu failed (exit $($script:PmCode))"; return }
      Write-PmSay ''
      Write-PmSay 'Ubuntu is installed. Once you have created your Linux user in it, run the installer again.'
    } else {
      Write-PmSay '  Install one with:  wsl --install -d Ubuntu   then run the installer again.'
    }
    return
  }
  # The default distro answers without -d; WSL_DISTRO_NAME carries its name.
  $default = Get-PmWslLine @('-e', 'sh', '-c', 'echo $WSL_DISTRO_NAME')
  if ([string]::IsNullOrEmpty($default) -or $names -notcontains $default) { $default = $names[0] }
  $script:PmDistro = $default
  if ($names.Count -eq 1 -or $Options.Yes -or $Options.DryRun) { return }
  Write-PmSay "  WSL distros: $($names -join ', ')"
  try {
    $answer = Read-Host "Install into which distro? [$default]"
  } catch {
    return
  }
  if ([string]::IsNullOrEmpty($answer)) { return }
  $script:PmDistro = $null
  if ($names -notcontains $answer.Trim()) { Write-PmError "WSL distro '$answer' not found"; return }
  $script:PmDistro = $answer.Trim()
}

# Checks WSL 2, the default user and systemd; enables systemd when the user agrees. Sets $script:PmReady, false after
# printing what to do.
function Initialize-PmDistro([hashtable]$Options, [string]$Distro) {
  $script:PmReady = $false
  $kernel = Get-PmWslLine @('-d', $Distro, '-e', 'uname', '-r')
  if ($kernel -notmatch 'WSL2|microsoft-standard') {
    Write-PmError "$Distro runs under WSL 1 (kernel '$kernel'); Paneful Manager needs WSL 2 with systemd."
    Write-PmSay "  Convert it:  wsl --set-version $Distro 2   then run the installer again."
    return
  }
  $uid = Get-PmWslLine @('-d', $Distro, '-e', 'id', '-u')
  if ($uid -eq '0') {
    Write-PmWarn "The default user of $Distro is root. Paneful Manager should run as your normal Linux user."
    Write-PmSay "  Create one and make it the default (see 'Default user' in docs/install.md), or continue as root."
    if (-not (Confirm-Pm $Options "Install for root in $Distro anyway?" $false)) { return }
  }
  $init = Get-PmWslLine @('-d', $Distro, '-e', 'ps', '-p', '1', '-o', 'comm=')
  if ($init -eq 'systemd') {
    Write-PmSay "  systemd runs in $Distro"
    $script:PmReady = $true
    return
  }
  Write-PmInfo "systemd is not running in $Distro"
  Write-PmSay '  Paneful Manager runs as systemd user services. The installer can set [boot] systemd=true in'
  Write-PmSay "  /etc/wsl.conf of $Distro (as root, other settings are kept, a backup is written) and restart WSL."
  Write-PmSay '  Restarting WSL (wsl --shutdown) stops ALL running distros and ends their sessions.'
  if (-not (Confirm-Pm $Options "Enable systemd in $Distro and restart WSL now?" $true)) {
    Write-PmSay ''
    Write-PmSay 'Next steps:'
    Write-PmSay "  1. In $Distro add '[boot]' and 'systemd=true' to /etc/wsl.conf"
    Write-PmSay '  2. Run:  wsl --shutdown'
    Write-PmSay '  3. Run the installer again.'
    return
  }
  $installArgs = @('--enable-wsl-systemd', '--yes')
  if ($Options.DryRun) { $installArgs += '--dry-run' }
  Invoke-PmInstallSh $Options $Distro $installArgs 'root'
  if ($script:PmCode -ne 0) { Write-PmError "Enabling systemd in $Distro failed (exit $($script:PmCode))"; return }
  Invoke-PmWslStep $Options @('--shutdown')
  if ($Options.DryRun) { $script:PmReady = $true; return }
  if ($script:PmCode -ne 0) { Write-PmError "wsl --shutdown failed (exit $($script:PmCode))"; return }
  $init = Get-PmWslLine @('-d', $Distro, '-e', 'ps', '-p', '1', '-o', 'comm=')
  if ($init -ne 'systemd') {
    Write-PmError "systemd still does not run in $Distro (PID 1 is '$init'). Check /etc/wsl.conf there, run 'wsl --shutdown' and run the installer again."
    return
  }
  Write-PmSay "  systemd runs in $Distro"
  $script:PmReady = $true
}

function Invoke-PmUninstall([hashtable]$Options, [string]$Distro) {
  Write-PmInfo "Uninstalling Paneful Manager from $Distro"
  $installArgs = @('--uninstall', '--no-windows-task')
  if ($Options.Yes) { $installArgs += '--yes' }
  if ($Options.DryRun) { $installArgs += '--dry-run' }
  Invoke-PmInstallSh $Options $Distro $installArgs
  if ($script:PmCode -ne 0) { Write-PmError "install.sh --uninstall failed in $Distro (exit $($script:PmCode))"; return }
  Remove-PmWindowsTasks $Options $Distro
}

function Invoke-PmInstall([hashtable]$Options, [string]$Distro) {
  Initialize-PmDistro $Options $Distro
  if (-not $script:PmReady) { $script:PmCode = 1; return }
  $installArgs = @('--yes', '--no-wsl-conf', '--no-windows-task')
  if (-not [string]::IsNullOrEmpty($Options.Port)) { $installArgs += @('--port', $Options.Port) }
  if (-not [string]::IsNullOrEmpty($Options.Version)) { $installArgs += @('--version', $Options.Version) }
  if ($Options.DryRun) { $installArgs += '--dry-run' }
  Write-PmInfo "Installing Paneful Manager in $Distro"
  Invoke-PmInstallSh $Options $Distro $installArgs
  if ($script:PmCode -ne 0) { Write-PmError "install.sh failed in $Distro (exit $($script:PmCode)); its messages above say why."; return }
  # install.sh was told not to touch the task, so it is created here only once.
  Install-PmWindowsTask $Options $Distro
  Write-PmSay ''
  Write-PmSay 'Paneful Manager runs in WSL. Open the login URL printed above (http://127.0.0.1:<port>/#login=...) in your browser;'
  Write-PmSay 'it works once, within 10 minutes. For a new one (another browser, or later):'
  Write-PmSay "  wsl -d $Distro -- ~/.local/share/paneful-manager/current/install.sh --login-url"
}

# Sets $script:PmCode: 0 when done, otherwise the step that stopped printed why and what to do next.
function Invoke-PanefulManagerInstaller([object[]]$Arguments) {
  $script:PmCode = 1
  try {
    $options = Get-PmOptions $Arguments
  } catch {
    Write-PmError $_.Exception.Message
    $script:PmCode = 2
    return
  }
  if ($options.DryRun) { Write-PmInfo 'Dry run: nothing will be changed' }
  if ($env:OS -ne 'Windows_NT' -and -not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-PmError 'install.ps1 is for Windows. On Linux and macOS run: curl -fsSL https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.sh | sh'
    $script:PmCode = 2
    return
  }
  Write-PmInfo 'Checking WSL'
  $wslFound = $null -ne (Get-Command wsl.exe -ErrorAction SilentlyContinue)
  if ($wslFound) {
    $null = Invoke-PmWslCapture @('--status')
    $wslFound = ($LASTEXITCODE -eq 0)
  }
  if (-not $wslFound) {
    Write-PmSay '  WSL 2 is not installed (or too old for wsl --status). Paneful Manager runs inside WSL 2.'
    if ($options.Uninstall) { Write-PmSay '  Nothing to uninstall.'; $script:PmCode = 0; return }
    if (-not (Test-PmAdmin)) {
      Write-PmSay '  Installing WSL needs an administrator PowerShell and a restart of Windows.'
      Show-PmWslInstallSteps $options
      return
    }
    if (Confirm-Pm $options 'Install WSL now (wsl --install --no-distribution; needs a restart)?' $true) {
      Invoke-PmWslStep $options @('--install', '--no-distribution')
      if ($script:PmCode -ne 0) { Write-PmError "wsl --install failed (exit $($script:PmCode))"; return }
      $script:PmCode = 1
    }
    Show-PmWslInstallSteps $options
    return
  }
  Write-PmSay '  WSL found'
  Select-PmDistro $options
  if ($null -eq $script:PmDistro) { $script:PmCode = 1; return }
  Write-PmSay "  distro: $($script:PmDistro)"
  if ($options.Uninstall) {
    Invoke-PmUninstall $options $script:PmDistro
  } else {
    Invoke-PmInstall $options $script:PmDistro
  }
}

Invoke-PanefulManagerInstaller $args
$PanefulManagerResult = $script:PmCode
# Only a script file (powershell -File install.ps1) reports its result as exit code; under 'irm | iex' exit would close the console.
if ($MyInvocation.MyCommand.Path) { exit $PanefulManagerResult }
