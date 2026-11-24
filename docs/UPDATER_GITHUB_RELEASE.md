# Auto Update via GitHub Releases (NSIS)

## Phát hành unsigned được cho phép riêng — Cập nhật v1.0.20

Người dùng đã cho phép phát hành bản cập nhật ổn định v1.0.20 cho khách hàng, tiếp tục áp dụng quyết định chấp nhận bộ cài unsigned cho Windows. Dùng nhánh phát hành riêng và tag trỏ đúng commit source của phiên bản 1.0.20; không thay thế asset của các phiên bản trước.

Luồng chuẩn bị và phát hành:
- Thực hiện clean artifact build (`npm run clean:artifacts`) trước khi build để dọn dẹp toàn bộ bundle/chunk cũ, đảm bảo không lẫn tài nguyên thừa.
- Build local bằng `--publish never`, kiểm tra typecheck/lint/unit, unpacked, NSIS và nâng cấp trong thư mục TEMP độc lập.
- Đối chiếu kích thước và mã SHA512 trong `latest.yml`.
- Tải installer + blockmap + metadata lên GitHub Releases dưới dạng **Draft** (draft-first verification). Thử nghiệm và xác minh quy trình tải cập nhật được thực hiện trước qua loopback fixture feed cục bộ (`scripts/ota-download-smoke.cjs` với loopback HTTP server trong harness kiểm thử); feed GitHub Releases công khai thật không nhìn thấy bản draft và chỉ được dùng để xác minh sau khi bản phát hành đã được chuyển sang Latest (công bố công khai).
- Chỉ bỏ draft và chọn **Latest** sau khi đã đủ asset và vượt qua toàn bộ QA; sau khi công bố mới kiểm tra lại feed cập nhật GitHub công khai bằng client phiên bản trước.

## 0) Phạm vi ký số & Tính toàn vẹn cập nhật

- Theo yêu cầu của chủ dự án, tạm gác Authenticode signing và chấp nhận bộ cài Windows unsigned để phân phối. Thiếu chứng thư ký số không chặn việc phát triển hoặc đóng gói unsigned; tuy nhiên không đồng nghĩa đã tự động đạt QA trên máy khách.
- Nhánh đóng gói local hiện có là `npm run release:unsigned`; lệnh này build, chạy smoke và archive, không publish. Chỉ chạy khi cần kiểm tra/đóng gói, không tự cài đè bản đang dùng.
- Khách chỉ nên tiếp tục khi nhận đúng bộ cài từ nguồn chính thức của dự án và đã kiểm tra thông tin file. Với cảnh báo SmartScreen về ứng dụng chưa được nhận diện, có thể chọn `More info` → `Run anyway` nếu Windows cho phép.
- Không hứa mọi máy đều có nút tiếp tục: chính sách doanh nghiệp có thể cấm bỏ qua; Smart App Control trên Windows 11 có thể chặn ứng dụng unsigned và không có ngoại lệ cho từng app.
- Không hướng dẫn tắt Defender/SmartScreen hoặc bỏ qua cảnh báo phát hiện mã độc. Giữ kiểm thử cài đặt/nâng cấp, đối chiếu checksum và kiểm tra tính toàn vẹn.
- **Cơ chế OTA & Chữ ký**: Đã loại bỏ hoàn toàn các yêu cầu build/ký số sidecar Laya do tính năng Laya AI đã được gỡ bỏ khỏi ứng dụng. Quyết định này không làm suy yếu tính toàn vẹn của OTA: cơ chế kiểm tra tính toàn vẹn cập nhật của `electron-updater` vẫn được giữ nguyên, không tắt kiểm tra chữ ký cập nhật. Cài thủ công một bộ cài unsigned không tự chứng minh OTA; các bản phát hành đều cần bằng chứng tải qua updater thật và nâng cấp thực tế trong môi trường cô lập.
- Giai đoạn đóng gói local đã được mở rộng theo yêu cầu phát hành bản cập nhật ổn định v1.0.20 cho người dùng; không coi ghi chú no-publish trước đó là trạng thái hiện tại.

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
1. Tang version trong `package.json` theo semver (vd `1.0.20`).
2. Xac thuc GitHub:
   - Khuyen nghi su dung phien dang nhap co san cua GitHub CLI (`gh auth status` / `gh auth login`) hoac truyen bien moi truong `GH_TOKEN` trong runtime session an toan (khong luu token truc tiep vao tep tin, khong mo rong credential).
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
