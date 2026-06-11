# Auto Update via GitHub Releases (NSIS)

## 1) Muc tieu
- May A build/publish version moi len GitHub Releases.
- May B (ban cai NSIS) bam cap nhat trong app de tai va cai.

## 2) Cau hinh can chinh 1 lan
- Mo `package.json`, cap nhat:
  - `build.publish[0].owner`
  - `build.publish[0].repo`
  - `repository.url`
- Chac chan repo release la public (chi chua artifact phat hanh).

## 3) Quy trinh phat hanh tren may A
1. Tang version trong `package.json` theo semver (vd `1.0.1`).
2. Dat GitHub token:
   - PowerShell: `$env:GH_TOKEN = \"<your_token>\"`
3. Chay lenh:
   - `npm run release:github`
4. Kiem tra release da co cac file:
   - `MMO-Auto-Review-Setup-<version>.exe`
   - `latest.yml`
   - `*.blockmap`
5. Ban local tren may A duoc luu tu dong vao:
   - `release-history/v<version>/...`
   - `release-history/index.json` (danh sach version da luu)

## 3.2) Cach dung bang click (khong can go lenh)
- O thu muc goc project, bam dup:
  - `Release-Manager.bat`
- Menu se hien cac lua chon:
  - `1`: Tang patch + publish GitHub + archive local
  - `2`: Publish version hien tai + archive local
  - `3`: Build installer local (khong publish)
  - `4`: Archive local only
  - `5`: Nhap/cap nhat GH_TOKEN
  - `6`: Mo folder `release-history`
  - `7`: Mo trang GitHub Releases

## 3.1) Luu version local thu cong (neu can)
- Neu ban chi muon luu archive local ma khong publish:
  - `npm run release:archive-local`
- Moi folder version co:
  - binary installer/blockmap/latest.yml
  - `package.json.snapshot`
  - `metadata.json` (size + sha256 de truy vet)

## 4) Hanh vi tren may B
- App chi auto-update khi dang chay ban NSIS da cai dat.
- Trong Settings:
  - Nut `Kiem tra & Tai cap nhat`
  - Sau khi tai xong: `Khoi dong lai de cap nhat`
- Neu campaign dang chay:
  - Update van tai nen
  - Cai dat bi hoan den khi campaign dung.

## 5) Luu y quan trong
- Ban portable / `win-unpacked` khong ho tro auto-update.
- Khi loi feed/publish, kiem tra:
  - `build.publish` trong `package.json`
  - Quyen token `GH_TOKEN`
  - Asset `latest.yml` trong release version moi.
