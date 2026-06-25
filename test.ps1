$html = Get-Content 'PageCompre.html' -Raw
$regex = 'Current Utility Line Voltage[\s\S]*?<TABLE[^>]*>[\s\S]*?<TD>\s*([\d.]+)\s*</TD>'
$m = [regex]::Match($html, $regex, 'IgnoreCase')
if ($m.Success) {
    Write-Output "Found: $($m.Groups[1].Value)"
} else {
    Write-Output "FAIL"
}
