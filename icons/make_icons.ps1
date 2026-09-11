Add-Type -AssemblyName System.Drawing

function New-RoundedRectPath {
    param([float]$X, [float]$Y, [float]$W, [float]$H, [float]$Radius)
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    if ($d -gt $W) { $d = $W }
    if ($d -gt $H) { $d = $H }
    $gp.AddArc($X, $Y, $d, $d, 180, 90)
    $gp.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
    $gp.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
    $gp.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
    $gp.CloseFigure()
    return $gp
}

function New-Icon {
    param(
        [int]$Size,
        [string]$OutPath
    )

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # colBg: white background. filmLight/filmDark: dark-brown gradient endpoints (light source top-left).
    $colBg      = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
    $filmLight  = [System.Drawing.Color]::FromArgb(255, 120, 96, 78)
    $filmDark   = [System.Drawing.Color]::FromArgb(255, 40, 32, 26)
    $colHole    = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

    # background rounded square (white)
    $bgPath = New-RoundedRectPath -X 0 -Y 0 -W $Size -H $Size -Radius ($Size * 0.22)
    $g.SetClip($bgPath)
    $bgBrush = New-Object System.Drawing.SolidBrush $colBg
    $g.FillPath($bgBrush, $bgPath)

    # film strip: 4 pieces in a straight row, ratio 3:3:3:1, small left/right gaps
    $bandLeft   = $Size * 0.09
    $bandRight  = $Size * 0.91
    $bandTop    = $Size * 0.16
    $bandBottom = $Size * 0.84
    $bandWidth  = $bandRight - $bandLeft
    $bandHeight = $bandBottom - $bandTop

    $gapWidth   = $Size * 0.018
    $ratios     = @(3, 3, 3, 1)
    $ratioSum   = 10
    $usableWidth = $bandWidth - ($gapWidth * ($ratios.Count - 1))

    # one gradient brush across the whole band, so all pieces share one light source (top-left)
    $bandRect = New-Object System.Drawing.RectangleF $bandLeft, $bandTop, $bandWidth, $bandHeight
    $filmBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($bandRect, $filmLight, $filmDark, [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
    $holeBrush = New-Object System.Drawing.SolidBrush $colHole

    # hole size is fixed (same for every piece, including the narrow 1-ratio piece)
    $holeSize = $Size * 0.045
    $holeMarginY = $Size * 0.035

    $x = $bandLeft
    for ($i = 0; $i -lt $ratios.Count; $i++) {
        $pw = $usableWidth * ($ratios[$i] / $ratioSum)

        $piecePath = New-RoundedRectPath -X $x -Y $bandTop -W $pw -H $bandHeight -Radius ($Size * 0.02)
        $g.FillPath($filmBrush, $piecePath)

        $holeCount = [Math]::Max(1, [Math]::Round($pw / ($Size * 0.14)))
        for ($h = 0; $h -lt $holeCount; $h++) {
            $hx = $x + ($pw / ($holeCount + 1)) * ($h + 1) - $holeSize/2
            $topY = $bandTop + $holeMarginY
            $botY = $bandBottom - $holeMarginY - $holeSize
            $holeTopPath = New-RoundedRectPath -X $hx -Y $topY -W $holeSize -H $holeSize -Radius ($holeSize*0.3)
            $holeBotPath = New-RoundedRectPath -X $hx -Y $botY -W $holeSize -H $holeSize -Radius ($holeSize*0.3)
            $g.FillPath($holeBrush, $holeTopPath)
            $g.FillPath($holeBrush, $holeBotPath)
        }

        $x += $pw + $gapWidth
    }

    $g.ResetClip()
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Icon -Size 180 -OutPath (Join-Path $dir "icon-180.png")
New-Icon -Size 192 -OutPath (Join-Path $dir "icon-192.png")
New-Icon -Size 512 -OutPath (Join-Path $dir "icon-512.png")
Write-Output "done"
