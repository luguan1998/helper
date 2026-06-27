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
$QueryCount      = 20         # messages fetched per poll
$PollIntervalMs  = 1000       # poll interval in ms
# Optional (uncomment to override):
# $WELINK_BIN         = "welink-cli"
# $CHROMIUM_PATH      = "C:\Program Files\Google\Chrome\Application\chrome.exe"
# $BOT_STATE_DIR      = "$env:USERPROFILE\.claude-bot"
# $BOT_PICTURE_OUTPUT = "image"   # image | html
# -------------------------------

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$env:WELINK_GROUP_IDS     = $GroupIds
$env:BOT_INCLUDE_THINKING = $IncludeThinking
$env:WELINK_QUERY_COUNT   = $QueryCount
$env:BOT_POLL_INTERVAL_MS = $PollIntervalMs
if ($WELINK_BIN)         { $env:WELINK_BIN         = $WELINK_BIN }
if ($CHROMIUM_PATH)      { $env:CHROMIUM_PATH      = $CHROMIUM_PATH }
if ($BOT_STATE_DIR)      { $env:BOT_STATE_DIR      = $BOT_STATE_DIR }
if ($BOT_PICTURE_OUTPUT) { $env:BOT_PICTURE_OUTPUT = $BOT_PICTURE_OUTPUT }

Write-Host ("[start] groups={0} think={1} query={2} poll={3}ms" -f $GroupIds,$IncludeThinking,$QueryCount,$PollIntervalMs) -ForegroundColor Cyan
npm run dev
