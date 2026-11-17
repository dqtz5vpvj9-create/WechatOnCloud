Add-Type -AssemblyName System.Windows.Forms
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { Write-Output '{"image":false}'; exit 0 }
$image = [System.Windows.Forms.Clipboard]::GetImage()
try {
    $pixel = ([System.Drawing.Bitmap]$image).GetPixel(0, 0)
    @{ image = $true; width = $image.Width; height = $image.Height; pixel = @($pixel.R, $pixel.G, $pixel.B, $pixel.A) } | ConvertTo-Json -Compress
} finally { $image.Dispose() }
