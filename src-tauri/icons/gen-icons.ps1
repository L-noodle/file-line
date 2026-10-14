# 生成晾衣绳图标：icon.png（应用）+ tray.png（托盘）
Add-Type -AssemblyName System.Drawing

$dir = "e:\Desktop\windows-版本\src-tauri\icons"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function New-Canvas([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    return , @($bmp, $g)
}

function Get-RoundRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
    $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
    $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Draw-Design($g, [double]$size, [bool]$bg) {
    $u = $size / 128.0
    if ($bg) {
        $path = Get-RoundRectPath (8*$u) (8*$u) (112*$u) (112*$u) (26*$u)
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.Point(0, 0)),
            (New-Object System.Drawing.Point([int]$size, [int]$size)),
            [System.Drawing.Color]::FromArgb(255, 79, 140, 255),
            [System.Drawing.Color]::FromArgb(255, 155, 92, 255))
        $g.FillPath($brush, $path)
        $penB = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(80, 255, 255, 255), [float](1.4*$u))
        $g.DrawPath($penB, $path)
    }

    # 绳子（下垂贝塞尔）
    $ropeColor = if ($bg) {
        [System.Drawing.Color]::FromArgb(235, 255, 255, 255)
    } else {
        [System.Drawing.Color]::FromArgb(235, 110, 94, 74)
    }
    $pen = New-Object System.Drawing.Pen($ropeColor, [float](5.5*$u))
    $g.DrawBezier($pen,
        [float](10*$u), [float](36*$u),
        [float](64*$u), [float](80*$u),
        [float](64*$u), [float](80*$u),
        [float](118*$u), [float](36*$u))

    # 三张卡片 + 衣夹
    $cards = @(
        @{ x = 20; y = 54; c = [System.Drawing.Color]::FromArgb(255, 76, 194, 255) },
        @{ x = 51; y = 64; c = [System.Drawing.Color]::FromArgb(255, 108, 203, 95) },
        @{ x = 82; y = 54; c = [System.Drawing.Color]::FromArgb(255, 255, 179, 92) }
    )
    foreach ($c in $cards) {
        $w = 26 * $u; $h = 38 * $u
        $path = Get-RoundRectPath ($c.x*$u) ($c.y*$u) $w $h (6*$u)
        $brush = New-Object System.Drawing.SolidBrush($c.c)
        $g.FillPath($brush, $path)
        $penC = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 255, 255, 255), [float](1.7*$u))
        $g.DrawPath($penC, $path)

        # 衣夹（水平金属渐变）
        $pw = 6 * $u; $ph = 13 * $u
        $px = $c.x*$u + $w/2 - $pw/2
        $py = ($c.y - 9) * $u
        $pinPath = Get-RoundRectPath $px $py $pw $ph (2.2*$u)
        $pinRect = New-Object System.Drawing.RectangleF([float]$px, [float]$py, [float]$pw, [float]$ph)
        $pinBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            $pinRect,
            [System.Drawing.Color]::FromArgb(255, 235, 235, 235),
            [System.Drawing.Color]::FromArgb(255, 150, 150, 150),
            [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
        $g.FillPath($pinBrush, $pinPath)
    }
}

# 应用图标 512（渐变背景）
$c = New-Canvas 512
Draw-Design $c[1] 512 $true
$c[0].Save("$dir\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$c[1].Dispose(); $c[0].Dispose()

# 托盘 64（透明背景，深色可见）
$c = New-Canvas 64
Draw-Design $c[1] 64 $false
$c[0].Save("$dir\tray.png", [System.Drawing.Imaging.ImageFormat]::Png)
$c[1].Dispose(); $c[0].Dispose()

Write-Host "icons generated:"
Get-ChildItem $dir | Select-Object Name, Length | Format-Table | Out-String
