# NetWatch PowerShell Proxy Server
# Usage: powershell -ExecutionPolicy Bypass -File server.ps1

$Port = 5500
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Add-Type -AssemblyName System.Web

$mime = @{}
$mime['.html'] = 'text/html; charset=utf-8'
$mime['.css']  = 'text/css; charset=utf-8'
$mime['.js']   = 'application/javascript; charset=utf-8'

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

Write-Host ''
Write-Host '  NetWatch proxy server running!' -ForegroundColor Green
Write-Host "  Dashboard: http://localhost:$Port/" -ForegroundColor Cyan
Write-Host '  Press Ctrl+C to stop.' -ForegroundColor Yellow
Write-Host ''

Start-Sleep -Milliseconds 600
Start-Process "http://localhost:$Port/"

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $res.Headers.Add('Access-Control-Allow-Origin', '*')
    $res.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    $res.Headers.Add('Access-Control-Allow-Headers', 'Content-Type')
    $urlPath = $req.Url.AbsolutePath

    if ($req.HttpMethod -eq 'OPTIONS') {
        $res.StatusCode = 204
        $res.Close()
        continue
    }

    if ($urlPath -eq '/proxy') {
        $qs = [System.Web.HttpUtility]::ParseQueryString($req.Url.Query)
        $targetUrl = $qs['url']
        $authB64   = $qs['auth']
        if (-not $targetUrl) {
            $b = [System.Text.Encoding]::UTF8.GetBytes('missing url')
            $res.StatusCode = 400
            $res.OutputStream.Write($b, 0, $b.Length)
            $res.Close()
            continue
        }
        try {
            $wc = New-Object System.Net.WebClient
            $wc.CachePolicy = New-Object System.Net.Cache.RequestCachePolicy([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)
            $wc.Headers.Add('User-Agent', 'NetWatch/1.0')
            if ($authB64) {
                $wc.Headers.Add('Authorization', "Basic $authB64")
            }
            if ($req.ContentType) {
                $wc.Headers.Add('Content-Type', $req.ContentType)
            }
            
            if ($req.HttpMethod -eq 'POST' -and $req.HasEntityBody) {
                $stream = $req.InputStream
                $reader = New-Object System.IO.MemoryStream
                $stream.CopyTo($reader)
                $reqData = $reader.ToArray()
                $data = $wc.UploadData($targetUrl, "POST", $reqData)
            } else {
                $data = $wc.DownloadData($targetUrl)
            }
            
            $ct = $wc.ResponseHeaders['Content-Type']
            if (-not $ct) { $ct = 'text/html; charset=utf-8' }
            $res.ContentType = $ct
            $res.StatusCode = 200
            $res.ContentLength64 = $data.Length
            $res.OutputStream.Write($data, 0, $data.Length)
        } catch {
            $errMsg = $_.Exception.Message
            $b = [System.Text.Encoding]::UTF8.GetBytes("proxy error: $errMsg")
            $res.StatusCode = 502
            $res.OutputStream.Write($b, 0, $b.Length)
        }
        $res.Close()
        continue
    }

    if ($urlPath -eq '/api/save' -and $req.HttpMethod -eq 'POST') {
        $stream = $req.InputStream
        $reader = New-Object System.IO.MemoryStream
        $stream.CopyTo($reader)
        $reqData = $reader.ToArray()
        $jsonStr = [System.Text.Encoding]::UTF8.GetString($reqData)
        $devicesPath = Join-Path $root 'devices.json'
        [System.IO.File]::WriteAllText($devicesPath, $jsonStr)
        $b = [System.Text.Encoding]::UTF8.GetBytes('{"success":true}')
        $res.ContentType = 'application/json'
        $res.StatusCode = 200
        $res.OutputStream.Write($b, 0, $b.Length)
        $res.Close()
        continue
    }

    if ($urlPath -eq '/api/load' -and $req.HttpMethod -eq 'GET') {
        $devicesPath = Join-Path $root 'devices.json'
        if (Test-Path $devicesPath) {
            $data = [System.IO.File]::ReadAllBytes($devicesPath)
        } else {
            $data = [System.Text.Encoding]::UTF8.GetBytes('[]')
        }
        $res.ContentType = 'application/json'
        $res.StatusCode = 200
        $res.ContentLength64 = $data.Length
        $res.OutputStream.Write($data, 0, $data.Length)
        $res.Close()
        continue
    }

    $rel = $urlPath.TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $filePath = Join-Path $root $rel

    if (Test-Path $filePath -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($filePath)
        $data = [System.IO.File]::ReadAllBytes($filePath)
        $ct = $mime[$ext]
        if (-not $ct) { $ct = 'text/plain' }
        $res.ContentType = $ct
        $res.StatusCode = 200
        $res.ContentLength64 = $data.Length
        $res.OutputStream.Write($data, 0, $data.Length)
    } else {
        $b = [System.Text.Encoding]::UTF8.GetBytes('not found')
        $res.StatusCode = 404
        $res.OutputStream.Write($b, 0, $b.Length)
    }
    $res.Close()
}
