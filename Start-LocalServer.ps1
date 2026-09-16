# Start-LocalServer.ps1 — start a local HTTP server, auto-pick a free port, open browser
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File Start-LocalServer.ps1

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# 1. Find a free port (starting from 8080)
function Test-Port([int]$port) {
    $l = $null
    try {
        $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        $l.Start()
        $l.Stop()
        return $true
    } catch {
        if ($l) { $l.Stop() }
        return $false
    }
}

$port = 8080
while (-not (Test-Port $port)) { $port++ }

# 2. MIME types
$mime = @{
    ".html"   = "text/html; charset=utf-8"
    ".css"    = "text/css; charset=utf-8"
    ".js"     = "text/javascript; charset=utf-8"
    ".mjs"    = "text/javascript; charset=utf-8"
    ".json"   = "application/json; charset=utf-8"
    ".txt"    = "text/plain; charset=utf-8"
    ".wasm"   = "application/wasm"
    ".task"   = "application/octet-stream"
    ".tflite" = "application/octet-stream"
    ".png"    = "image/png"
    ".jpg"    = "image/jpeg"
    ".svg"    = "image/svg+xml"
}

# 3. Start server (TcpListener, no http.sys ACL required)
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
$listener.Start()
$url = "http://localhost:$port/"
Write-Host ("Local server started: {0}  (close this window to stop)" -f $url) -ForegroundColor Green

# 4. Open browser
$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($chrome) { Start-Process $chrome $url }
else { Start-Process $url }

# 5. Request loop
while ($true) {
    $client = $null
    try {
        $client = $listener.AcceptTcpClient()
    } catch {
        break
    }
    try {
        $stream = $client.GetStream()
        $client.ReceiveTimeout = 5000
        $buf = New-Object byte[] 8192
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { continue }

        $reqText = [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
        $firstLine = ($reqText -split "`r?`n")[0]
        $path = ($firstLine -split " ")[1]
        if (-not $path) { $path = "/" }
        $path = [System.Uri]::UnescapeDataString($path)
        if ($path -eq "/") { $path = "/index.html" }

        $rel = $path.TrimStart("/").Replace("/", "\")
        $file = Join-Path $root $rel

        # block parent-directory traversal
        if ($rel -match '(^|\\)\.\.') { $file = $null }

        if ($file -and (Test-Path $file -PathType Leaf)) {
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $ext = [System.IO.Path]::GetExtension($file).ToLower()
            $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
            $head = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
        } else {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            $head = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
        }

        $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
        $stream.Write($headBytes, 0, $headBytes.Length)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    } catch {
        # per-request errors must not kill the server
    } finally {
        if ($client) { $client.Close() }
    }
}

$listener.Stop()
