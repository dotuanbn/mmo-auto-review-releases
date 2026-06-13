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
    Write-Host ' Release mới: Bump -> Tag -> CI (win+mac publish)  | macOS BẮT BUỘC qua GitHub Actions' -ForegroundColor DarkGray
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

function Ensure-GitHubAuth {
    Write-Host 'Kiem tra gh auth status...' -ForegroundColor Yellow
    & gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        try {
            $user = & gh api user --jq .login 2>$null
            if ([string]::IsNullOrWhiteSpace($user)) { $user = 'unknown' }
            Write-Host "GitHub: da dang nhap ($user)" -ForegroundColor Green
        } catch {
            Write-Host 'GitHub: da dang nhap' -ForegroundColor Green
        }
        return
    }

    Write-Host ''
    Write-Host 'CHUA DANG NHAP GitHub (gh auth status khong ok).' -ForegroundColor Yellow
    Write-Host 'Can dang nhap GitHub 1 lan (de git push qua HTTPS khong can nhap tay).' -ForegroundColor Yellow
    Write-Host 'Interactive: chon GitHub.com + HTTPS + login qua trinh duyet hoac device code.' -ForegroundColor DarkGray
    & gh auth login
    if ($LASTEXITCODE -ne 0) {
        throw 'Dang nhap GitHub that bai.'
    }

    Write-Host 'Dang chay gh auth setup-git (de git dung gh lam credential helper)...' -ForegroundColor Yellow
    & gh auth setup-git

    & gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Chua dang nhap GitHub, khong the push.'
    }

    try {
        $user = & gh api user --jq .login 2>$null
        if ([string]::IsNullOrWhiteSpace($user)) { $user = 'unknown' }
        Write-Host "GitHub: da dang nhap ($user)" -ForegroundColor Green
    } catch {
        Write-Host 'GitHub: da dang nhap' -ForegroundColor Green
    }
}

function Show-Menu {
    Write-Host 'Vui lòng đưa ra lựa chọn (gõ số):' -ForegroundColor Green
    Write-Host '1) CẬP NHẬT VERSION MỚI + Commit + Tag + Push -> CI build Windows (nsis+portable) + macOS (dmg+zip) + Publish Release' -ForegroundColor Cyan
    Write-Host '2) CHỈ UPLOAD WIN (giữ version hiện tại, local build) + Archive' -ForegroundColor Cyan
    Write-Host '3) Build File .EXE (nsis) ra thư mục Release (KHÔNG Upload)' -ForegroundColor Cyan
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
            if (-not (Confirm-YesNo -Message 'BẮT ĐẦU RA VERSION MỚI: Tăng version + commit + tag + push (KÍCH HOẠT CI build CẢ Windows + macOS publish)?' -DefaultYes:$true)) { return }

            Write-Host ''
            Write-Host 'Chọn loại bump version:' -ForegroundColor Yellow
            Write-Host '  1 = patch (1.0.7 -> 1.0.8)   [mặc định]'
            Write-Host '  2 = minor (1.0.7 -> 1.1.0)'
            Write-Host '  3 = major (1.0.7 -> 2.0.0)'
            Write-Host '  4 = nhập tay (ví dụ 1.2.3)'
            $bumpChoice = (Read-Host 'Nhập 1/2/3/4 (Enter = patch)').Trim()
            if ([string]::IsNullOrWhiteSpace($bumpChoice)) { $bumpChoice = '1' }

            $bumpArg = 'patch'
            switch ($bumpChoice) {
                '1' { $bumpArg = 'patch' }
                '2' { $bumpArg = 'minor' }
                '3' { $bumpArg = 'major' }
                '4' {
                    $manual = (Read-Host 'Nhập version đầy đủ (ví dụ 1.2.3)').Trim()
                    if (-not [string]::IsNullOrWhiteSpace($manual)) {
                        & npm version $manual --no-git-tag-version | Out-Null
                        $bumpArg = $null
                    }
                }
                default { $bumpArg = 'patch' }
            }
            if ($bumpArg) {
                Invoke-Step -Description 'Đang Tăng Số Phiên Bản (Version Bump)' -Command "npm version $bumpArg --no-git-tag-version"
            }
            $newVer = Get-AppVersion
            Write-Host "Version mới: $newVer" -ForegroundColor Green

            if (Confirm-YesNo -Message 'Build Windows LOCAL ngay (nsis) để có .exe trong release/ ngay (macOS sẽ do CI qua tag)?' -DefaultYes:$true) {
                Invoke-Step -Description 'Build Windows installer local (bản ngay)' -Command 'npm run build:installer'
                if (Confirm-YesNo -Message 'Archive bản local vừa build vào release-history?' -DefaultYes:$true) {
                    Invoke-Step -Description 'Archive local artifacts' -Command 'npm run release:archive-local'
                }
            }

            Write-Host ''
            Write-Host 'TIẾP THEO: Commit package.json + git tag + push để GitHub Actions build CẢ 2 nền tảng và publish.' -ForegroundColor Yellow
            if (-not (Confirm-YesNo -Message "XÁC NHẬN: Commit + tag v$newVer + push (branch + tag) -> Kích hoạt CI (win+mac) publish GitHub Release?" -DefaultYes:$true)) {
                Write-Host 'Đã hủy push. Version đã bump trong package.json (chưa commit/tag).' -ForegroundColor Yellow
                return
            }

            Ensure-GitHubAuth

            $branch = git rev-parse --abbrev-ref HEAD
            git add package.json
            & git commit -m "chore(release): v$newVer"
            & git tag "v$newVer"

            Write-Host 'Kiem tra quyen push (gh auth + ls-remote origin)...' -ForegroundColor Yellow
            & git ls-remote --exit-code origin HEAD 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host 'Loi mang hoac khong co quyen push toi origin.' -ForegroundColor Red
                Write-Host "Da bump + commit + tao tag local v$newVer. De xoa tag local: git tag -d v$newVer ; git reset --soft HEAD~1 (neu muon undo commit)" -ForegroundColor Yellow
                throw 'Khong the push. Dang nhap gh roi chay lai Option 1.'
            }

            & git push origin $branch --tags
            if ($LASTEXITCODE -ne 0) {
                Write-Host ''
                Write-Host 'PUSH THAT BAI.' -ForegroundColor Red
                Write-Host "Da bump version + commit + tag local: v$newVer (branch: $branch)" -ForegroundColor Yellow
                Write-Host "De xoa tag local (neu can): git tag -d v$newVer" -ForegroundColor Yellow
                Write-Host 'Sau khi chay "gh auth login" + "gh auth setup-git", chay lai Option 1 (hoac thu: git push origin $branch --tags).' -ForegroundColor Yellow
                throw "Push that bai sau khi da tao tag local v$newVer."
            }

            Write-Host ''
            Write-Host '============================================================' -ForegroundColor Green
            Write-Host "ĐÃ PUSH TAG v$newVer (branch: $branch)" -ForegroundColor Green
            Write-Host 'GitHub Actions đang build Windows (nsis + portable) + macOS (dmg + zip) và publish.' -ForegroundColor Green
            Write-Host 'Theo dõi tiến độ: tab Actions (trong repo).' -ForegroundColor Cyan
            Write-Host 'Release (cả 2 nền tảng + latest.yml / latest-mac.yml cho auto-update) sẽ xuất hiện tại:' -ForegroundColor Cyan
            Write-Host '  https://github.com/dotuanbn/mmo-auto-review-releases/releases' -ForegroundColor White
            Write-Host '============================================================' -ForegroundColor Green
            Write-Host 'Lưu ý: Bản mac .dmg/.zip CHỈ có từ CI (macOS runner). Bản Windows local (nếu build) chỉ để test ngay.' -ForegroundColor Yellow
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
