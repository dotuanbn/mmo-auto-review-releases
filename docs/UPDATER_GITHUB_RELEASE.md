# Auto Update via GitHub Releases (NSIS)

## Phát hành unsigned được cho phép riêng — 2026-10-23

Người dùng đã yêu cầu đưa v1.0.19 lên GitHub để khách cập nhật, mở rộng quyết định unsigned trước đó sang lần phát hành Windows này. Dùng nhánh phát hành riêng và tag trỏ đúng source 1.0.19; không thay thế asset v1.0.18.

Luồng lần này: build local bằng `--publish never`, kiểm tra typecheck/lint/unit, sidecar, unpacked, NSIS và nâng cấp trong TEMP; đối chiếu size/SHA512 của `latest.yml`, rồi tải installer + blockmap + metadata lên draft. Chỉ bỏ draft và chọn Latest sau khi đủ asset và QA; kiểm tra lại GitHub feed bằng client 1.0.18.

Đây là ngoại lệ unsigned có chủ đích cho lần phát hành đã được yêu cầu; không sửa gate ký số mặc định của `release:github`/Windows CI hoặc tắt kiểm tra chữ ký trong updater. Không chạy menu tự bump/tag/publish song song với luồng draft thủ công.

Kết quả đã xác minh: v1.0.19 được publish Latest lúc 2026-10-23 10:32 +07, tag trỏ `05b21d8c0dbd1034c6fc6ce7e6d75a3adbf08854`. Client v1.0.18 dùng feed GitHub thật, không có token, đã tải đúng bộ cài mới; nâng cấp NSIS và kiểm tra cài đặt/dữ liệu thử đã đạt. Xem `docs/releases/v1.0.19.md` và `memory/sessions/2026-10-23-v1.0.19-release.md`. Không thay thế asset v1.0.18.

## 0) Phạm vi ký số — cập nhật 2026-10-23

- Theo yêu cầu của chủ dự án, tạm gác Authenticode signing và chấp nhận bộ cài Windows unsigned để phân phối thủ công. Thiếu chứng thư không chặn việc phát triển hoặc đóng gói unsigned; không đồng nghĩa đã đạt QA trên máy khách.
- Nhánh đóng gói local hiện có là `npm run release:unsigned`; lệnh này build, chạy smoke và archive, không publish. Chỉ chạy khi cần kiểm tra/đóng gói, không tự cài đè bản đang dùng.
- Khách chỉ nên tiếp tục khi nhận đúng bộ cài từ nguồn của dự án và đã kiểm tra thông tin file. Với cảnh báo SmartScreen về ứng dụng chưa được nhận diện, có thể chọn `More info` → `Run anyway` nếu Windows cho phép.
- Không hứa mọi máy đều có nút tiếp tục: chính sách doanh nghiệp có thể cấm bỏ qua; Smart App Control trên Windows 11 có thể chặn ứng dụng unsigned và không có ngoại lệ cho từng app.
- Không hướng dẫn tắt Defender/SmartScreen hoặc bỏ qua cảnh báo phát hiện mã độc. Giữ kiểm thử cài đặt/nâng cấp, đối chiếu checksum và kiểm tra tính toàn vẹn.
- Quyết định này không sửa cơ chế OTA: `release:github` và Windows CI mặc định vẫn yêu cầu chữ ký sidecar; không tắt kiểm tra chữ ký cập nhật. Cài thủ công một bộ cài unsigned không tự chứng minh OTA; v1.0.19 có thêm bằng chứng tải qua updater thật và nâng cấp thực tế.
- Giai đoạn chỉ đóng gói local đã được mở rộng bởi yêu cầu publish v1.0.19 của chủ dự án; không coi ghi chú no-publish trước đó là trạng thái hiện tại.

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
