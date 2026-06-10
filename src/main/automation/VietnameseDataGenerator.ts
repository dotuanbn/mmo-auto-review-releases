/**
 * Generate realistic Vietnamese customer data for form filling
 */
export class VietnameseDataGenerator {
    private static readonly FIRST_NAMES_MALE = [
        'Minh', 'Hùng', 'Đức', 'Thành', 'Tuấn', 'Hoàng', 'Nam', 'Long', 'Quang', 'Phúc',
        'Dũng', 'Trung', 'Kiên', 'Tùng', 'Hải', 'Bình', 'Khoa', 'Nghĩa', 'Sơn', 'Việt',
        'Toàn', 'Hiếu', 'Anh', 'Trí', 'Phong', 'Tân', 'Hưng', 'Thiên', 'Lộc', 'Khánh',
    ]
    private static readonly FIRST_NAMES_FEMALE = [
        'Linh', 'Hương', 'Lan', 'Hoa', 'Mai', 'Ngọc', 'Thảo', 'Trang', 'Yến', 'Hạnh',
        'Nga', 'Phương', 'Thuỷ', 'Dung', 'Vân', 'Uyên', 'Nhung', 'Giang', 'Thanh', 'Chi',
        'Trâm', 'Tuyết', 'Hiền', 'Quỳnh', 'Nhi', 'Thy', 'Diệu', 'Thư', 'Trinh', 'Hằng',
    ]
    private static readonly MIDDLE_NAMES = [
        'Văn', 'Thị', 'Hữu', 'Đình', 'Thanh', 'Minh', 'Đức', 'Quốc', 'Ngọc', 'Hoàng',
        'Xuân', 'Thu', 'Công', 'Bảo', 'Phước', 'Anh', 'Kim', 'Tiến', 'Trọng', 'Hồng',
    ]
    private static readonly LAST_NAMES = [
        'Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng',
        'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý', 'Đào', 'Đinh', 'Trương', 'Lương',
    ]
    private static readonly CITIES = [
        { city: 'Hà Nội', districts: ['Ba Đình', 'Hoàn Kiếm', 'Cầu Giấy', 'Đống Đa', 'Thanh Xuân', 'Hai Bà Trưng', 'Long Biên', 'Hoàng Mai', 'Nam Từ Liêm', 'Bắc Từ Liêm', 'Hà Đông', 'Tây Hồ'] },
        { city: 'TP. Hồ Chí Minh', districts: ['Quận 1', 'Quận 3', 'Quận 5', 'Quận 7', 'Quận 10', 'Bình Thạnh', 'Phú Nhuận', 'Tân Bình', 'Gò Vấp', 'Thủ Đức', 'Bình Tân', 'Tân Phú'] },
        { city: 'Đà Nẵng', districts: ['Hải Châu', 'Thanh Khê', 'Sơn Trà', 'Ngũ Hành Sơn', 'Liên Chiểu', 'Cẩm Lệ'] },
        { city: 'Hải Phòng', districts: ['Hồng Bàng', 'Ngô Quyền', 'Lê Chân', 'Kiến An', 'Đồ Sơn', 'Dương Kinh'] },
        { city: 'Cần Thơ', districts: ['Ninh Kiều', 'Bình Thuỷ', 'Cái Răng', 'Ô Môn', 'Thốt Nốt'] },
        { city: 'Nha Trang', districts: ['Vĩnh Hải', 'Vĩnh Phước', 'Lộc Thọ', 'Phước Hải', 'Tân Lập'] },
        { city: 'Huế', districts: ['Phú Hội', 'Vĩnh Ninh', 'Phú Nhuận', 'Xuân Phú', 'An Cựu'] },
        { city: 'Bắc Ninh', districts: ['Suối Hoa', 'Võ Cường', 'Kinh Bắc', 'Đại Phúc', 'Tiên Du'] },
        { city: 'Biên Hòa', districts: ['Trảng Dài', 'Tân Phong', 'Long Bình Tân', 'Thanh Bình', 'Bửu Hòa'] },
        { city: 'Vũng Tàu', districts: ['Phường 1', 'Phường 2', 'Phường 5', 'Thắng Nhì', 'Thắng Tam'] },
    ]
    private static readonly STREETS = [
        'Nguyễn Trãi', 'Lê Lợi', 'Trần Hưng Đạo', 'Hai Bà Trưng', 'Lý Thường Kiệt',
        'Nguyễn Huệ', 'Phan Đình Phùng', 'Hoàng Văn Thụ', 'Nguyễn Văn Cừ', 'Lê Duẩn',
        'Trường Chinh', 'Cách Mạng Tháng 8', 'Điện Biên Phủ', 'Nguyễn Thị Minh Khai',
        'Phạm Văn Đồng', 'Võ Văn Tần', 'Pasteur', 'Nam Kỳ Khởi Nghĩa', 'Bà Triệu',
        'Nguyễn Du', 'Trần Phú', 'Lê Hồng Phong', 'Nguyễn Đình Chiểu', 'Lạc Long Quân',
    ]
    private static readonly EMAIL_DOMAINS = [
        'gmail.com', 'yahoo.com.vn', 'outlook.com', 'hotmail.com', 'yahoo.com',
    ]

    private static pick<T>(arr: T[]): T {
        return arr[Math.floor(Math.random() * arr.length)]
    }

    static generateFullName(): { fullName: string; firstName: string; lastName: string } {
        const isMale = Math.random() > 0.5
        const lastName = this.pick(this.LAST_NAMES)
        const middleName = isMale ? this.pick(['Văn', 'Đình', 'Hữu', 'Quốc', 'Minh', 'Đức', 'Công', 'Trọng', 'Tiến', 'Bảo']) : this.pick(['Thị', 'Ngọc', 'Thu', 'Kim', 'Hồng', 'Thanh', 'Xuân', 'Anh', 'Phương', 'Bích'])
        const firstName = isMale ? this.pick(this.FIRST_NAMES_MALE) : this.pick(this.FIRST_NAMES_FEMALE)
        return {
            fullName: `${lastName} ${middleName} ${firstName}`,
            firstName,
            lastName: `${lastName} ${middleName}`,
        }
    }

    static generatePhone(): string {
        const prefixes = ['032', '033', '034', '035', '036', '037', '038', '039', '056', '058', '059', '070', '076', '077', '078', '079', '081', '082', '083', '084', '085', '086', '088', '089', '090', '091', '092', '093', '094', '096', '097', '098', '099']
        const prefix = this.pick(prefixes)
        const number = Math.floor(Math.random() * 9000000) + 1000000
        return `${prefix}${number}`
    }

    static generateEmail(name?: string): string {
        const base = name
            ? name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/\s+/g, '.').replace(/[^a-z0-9.]/g, '')
            : 'user' + Math.floor(Math.random() * 9999)
        const suffix = Math.floor(Math.random() * 99)
        return `${base}${suffix}@${this.pick(this.EMAIL_DOMAINS)}`
    }

    static generateAddress(): { full: string; street: string; district: string; city: string } {
        const cityData = this.pick(this.CITIES)
        const houseNumber = Math.floor(Math.random() * 300) + 1
        const alley = Math.random() > 0.6 ? `/${Math.floor(Math.random() * 50) + 1}` : ''
        const street = this.pick(this.STREETS)
        const district = this.pick(cityData.districts)
        return {
            full: `${houseNumber}${alley} ${street}, ${district}, ${cityData.city}`,
            street: `${houseNumber}${alley} ${street}`,
            district,
            city: cityData.city,
        }
    }

    /** Generate all customer info at once */
    static generateCustomer() {
        const { fullName, firstName, lastName } = this.generateFullName()
        const phone = this.generatePhone()
        const email = this.generateEmail(firstName)
        const address = this.generateAddress()
        return { fullName, firstName, lastName, phone, email, address }
    }
}
