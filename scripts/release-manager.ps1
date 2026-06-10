$ErrorActionPreference = 'Stop'

Set-StrictMode -Version Latest

$script:Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $script:Root

function Get-AppVersion {
    $pkg = Get-Content (Join-Path $script:Root 'package.json') -Raw | ConvertFrom-Json
    return [string]$pkg.version
}

function Write-Title {
    Clear-Host
    $version = Get-AppVersion
    Write-Host '===================================================' -ForegroundColor Cyan
    Write-Host ' MMO Auto Review - Quản Lý Bản Phát Hành (Máy Chính)' -ForegroundColor Cyan
    Write-Host '===================================================' -ForegroundColor Cyan
    Write-Host " Phiên bản hiện tại: $version" -ForegroundColor Yellow
    Write-Host ''
}

function Confirm-YesNo {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [bool]$DefaultYes = $true
    )

    $suffix = if ($DefaultYes) { '[Y/n] (Mặc định chọn Y)' } else { '[y/N] (Mặc định chọn N)' }
    $input = Read-Host "$Message $suffix"
    if ([string]::IsNullOrWhiteSpace($input)) {
        return $DefaultYes
    }

    $value = $input.Trim().ToLowerInvariant()
    return $value -in @('y', 'yes')
}

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][string]$Command
    )

    Write-Host ''
    Write-Host ">> $Description" -ForegroundColor Green
    Write-Host "   $Command" -ForegroundColor DarkGray

    & cmd /c $Command
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed ($Description). Exit code: $LASTEXITCODE"
    }
}

function Ensure-GitHubToken {
    if (-not [string]::IsNullOrWhiteSpace($env:GH_TOKEN)) {
        Write-Host 'Đã tìm thấy GH_TOKEN.' -ForegroundColor Green
        return
    }

    Write-Host 'Không tìm thấy GH_TOKEN.' -ForegroundColor Yellow
    $token = Read-Host 'Vui lòng dán mã GH_TOKEN của bạn vào đây'
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw 'GH_TOKEN không được để trống.'
    }

    $env:GH_TOKEN = $token.Trim()
    Write-Host 'Đã thiết lập GH_TOKEN tạm thời.' -ForegroundColor Green

    if (Confirm-YesNo -Message 'Bạn có muốn lưu GH_TOKEN này vĩnh viễn vào Windows để dùng cho lần sau không?' -DefaultYes:$false) {
        & setx GH_TOKEN $env:GH_TOKEN | Out-Null
        Write-Host 'Đã lưu thành công. Vui lòng TẮT CỬA SỔ NÀY và MỞ LẠI công cụ để sử dụng GH_TOKEN đã lưu.' -ForegroundColor Green
        pause
        exit
    }
}

function Show-Menu {
    Write-Host 'Vui lòng đưa ra lựa chọn (gõ số):' -ForegroundColor Green
    Write-Host '1) CẬP NHẬT VERSION MỚI (Tăng mã version) + Build file .exe + Upload cho Khách + Backup Tự Động' -ForegroundColor Cyan
    Write-Host '2) CHỈ UPLOAD LÊN CHO KHÁCH (Giữ nguyên version hiện tại) + Backup Tự Động' -ForegroundColor Cyan
    Write-Host '3) Build File .EXE ra thư mục Release (KHÔNG Upload lên mạng)' -ForegroundColor Cyan
    Write-Host '4) Backup file bộ cài hiện tại (Lưu vào thư mục release-history)' -ForegroundColor Cyan
    Write-Host '5) Cài đặt lại / Đổi mã GH_TOKEN' -ForegroundColor White
    Write-Host '6) Xem danh sách thư mục các bản Cũ Đã Backup' -ForegroundColor White
    Write-Host '7) Mở trang Quản lý phát hành trên GitHub' -ForegroundColor White
    Write-Host '0) Thoát' -ForegroundColor DarkGray
    Write-Host ''
}

function Run-Action {
    param([Parameter(Mandatory = $true)][string]$Choice)

    switch ($Choice) {
        '1' {
            Ensure-GitHubToken
            if (-not (Confirm-YesNo -Message 'Bạn có CHẮC CHẮN muốn tự động TĂNG VERSION và UPLOAD cho khách?' -DefaultYes:$true)) { return }
            Invoke-Step -Description 'Đang Tăng Số Phiên Bản (Version Bump)' -Command 'npm version patch --no-git-tag-version'
            Invoke-Step -Description 'Đang Tạo App, Upload Lên Mạng và Backup' -Command 'npm run release:github'
            Write-Host ''
            Write-Host 'Tuyệt vời! Bản cập nhật mới đã tới tay Khách Hàng.' -ForegroundColor Green
        }
        '2' {
            Ensure-GitHubToken
            if (-not (Confirm-YesNo -Message 'Tải TOÀN BỘ bản hiện tại lên cho khách (không thay đổi số Version)?' -DefaultYes:$false)) { return }
            Invoke-Step -Description 'Đang Tạo App, Upload Lên Mạng và Backup' -Command 'npm run release:github'
            Write-Host ''
            Write-Host 'Tuyệt vời! Đã tải lên thành công.' -ForegroundColor Green
        }
        '3' {
            Invoke-Step -Description 'Đang đóng gói chế độ Offline (Installer Build)' -Command 'npm run build:installer'
            Write-Host ''
            Write-Host 'Đã tạo xong file cài đặt .EXE trong thư mục release!' -ForegroundColor Green
        }
        '4' {
            Invoke-Step -Description 'Đang lưu dự án hiện tại vào kho sao lưu' -Command 'npm run release:archive-local'
            Write-Host ''
            Write-Host 'Sao lưu (Archive) thành công!' -ForegroundColor Green
        }
        '5' {
            $env:GH_TOKEN = ''
            Ensure-GitHubToken
        }
        '6' {
            $folder = Join-Path $script:Root 'release-history'
            if (-not (Test-Path $folder)) {
                New-Item -ItemType Directory -Path $folder | Out-Null
            }
            Start-Process explorer.exe $folder
            Write-Host 'Đã mở thư mục phiên bản lưu trữ (Backup).' -ForegroundColor Green
        }
        '7' {
            Start-Process 'https://github.com/dotuanbn/mmo-auto-review-releases/releases'
            Write-Host 'Đã mở liên kết quản lý trên Trình Duyệt.' -ForegroundColor Green
        }
        '0' {
            return 'EXIT'
        }
        default {
            Write-Host 'Lựa chọn của bạn không hợp lệ. Vui lòng nhập số từ 0 đến 7.' -ForegroundColor Red
        }
    }
}

while ($true) {
    try {
        Write-Title
        Show-Menu
        $choice = Read-Host 'Mời bạn nhập số tương ứng'
        $result = Run-Action -Choice ($choice.Trim())
        if ($result -eq 'EXIT') { break }
    } catch {
        Write-Host ''
        Write-Host ("Lỗi: " + $_.Exception.Message) -ForegroundColor Red
    }

    Write-Host ''
    Read-Host 'Nhấn nút Enter để Menu chạy lại'
}
