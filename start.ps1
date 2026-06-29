#Requires -Version 5
<#
start.ps1 - launch the customer-service bot against real welink-cli groups.
Edit the CONFIG block below, then run:  ./start.ps1
Prereqs: claude/opencc on PATH; chromium available (set CHROMIUM_PATH);
         welink-cli on PATH (or set WELINK_BIN).
#>

# --- CONFIG (edit as needed) ---
$GroupIds        = "100001,100002"    # group IDs to monitor, comma-separated
$IncludeThinking = "0"        # 1 = stream thinking blocks before final reply; 0 = off
$QueryCount      = 5         # messages fetched per poll
$PollIntervalMs  = 5000       # poll interval in ms
$WELINK_ACCOUNT  = "bot01"    # bot's welink login account (self-msg filter; @ this name) - set to your REAL account
$AddDirs         = ""        # extra dirs Claude can access per conversation via --add-dir (comma-sep, e.g. "D:\logs,D:\proj"); empty = none
# Optional (uncomment to override):
# $WELINK_BIN         = "welink-cli"
# $CHROMIUM_PATH      = "C:\Program Files\Google\Chrome\Application\chrome.exe"
# $BOT_STATE_DIR      = "$env:USERPROFILE\.claude-bot"
# $BOT_PICTURE_OUTPUT = "image"   # image | html
# $env:BOT_DEBUG        = "1"     # log each received msg + route decision (id/sender/at/state)
# -------------------------------

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$env:WELINK_GROUP_IDS     = $GroupIds
$env:WELINK_ACCOUNT       = $WELINK_ACCOUNT
$env:BOT_INCLUDE_THINKING = $IncludeThinking
$env:WELINK_QUERY_COUNT   = $QueryCount
$env:BOT_POLL_INTERVAL_MS = $PollIntervalMs
if ($AddDirs)            { $env:BOT_ADD_DIRS       = $AddDirs }
if ($WELINK_BIN)         { $env:WELINK_BIN         = $WELINK_BIN }
if ($CHROMIUM_PATH)      { $env:CHROMIUM_PATH      = $CHROMIUM_PATH }
if ($BOT_STATE_DIR)      { $env:BOT_STATE_DIR      = $BOT_STATE_DIR }
if ($BOT_PICTURE_OUTPUT) { $env:BOT_PICTURE_OUTPUT = $BOT_PICTURE_OUTPUT }

Write-Host ("[start] account={0} groups={1} think={2} query={3} poll={4}ms" -f $WELINK_ACCOUNT,$GroupIds,$IncludeThinking,$QueryCount,$PollIntervalMs) -ForegroundColor Cyan
if ($AddDirs) { Write-Host ("[start] add-dirs={0}" -f $AddDirs) -ForegroundColor Cyan }
npm run dev
