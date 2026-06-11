import { useState, useEffect, useRef, useCallback } from 'react'
import { useI18n } from '../i18n'
import {
    Play,
    Plus,
    Trash2,
    Save,
    MoveUp,
    MoveDown,
    ChevronDown,
    ChevronRight,
    Zap,
    Clock,
    Type,
    Navigation,
    Camera,
    Star,
    MessageSquare,
    Repeat,
    GitBranch,
    HelpCircle,
    Copy,
    FileText,
    Search,
    Map,
    MousePointerClick,
    Keyboard,
    Timer,
    Scroll,
    Eye,
    Users,
    Upload,
    ArrowLeft,
    RefreshCw,
    Hash,
    GripVertical,
    ChevronsUp,
    ChevronsDown,
    List,
    MousePointer2,
    Download,
    Settings,
    X,
    AlertTriangle,
    ChevronLeft
} from 'lucide-react'
import {
    PageShell,
    PageHeader,
    Panel,
    PrimaryButton,
    IconButton,
    Modal,
    EmptyState,
    AlertBanner,
    ProgressBar,
    Badge,
} from '../components/ui/surface'

// ==================== TYPE DEFINITIONS ====================
interface ScriptAction {
    id: string
    type: string
    name: string
    enabled: boolean
    params: Record<string, any>
    expanded?: boolean
}

interface ScriptVariable {
    name: string
    type: 'string' | 'number' | 'boolean'
    defaultValue: any
    description?: string
}

interface AutomationScript {
    id: string
    name: string
    description: string
    version?: string
    createdAt?: Date
    updatedAt?: Date
    variables: ScriptVariable[]
    actions: ScriptAction[]
    settings: {
        headless: boolean
        defaultTimeout: number
        viewport: { width: number; height: number }
    }
}

// ==================== ACTION CATEGORIES ====================
const ACTION_CATEGORIES = [
    {
        name: 'Dieu huong',
        emoji: '🌐',
        description: 'Mở trang web, tìm kiếm',
        actions: [
            {
                type: 'navigate',
                label: 'Mở URL',
                icon: Navigation,
                color: 'blue',
                description: 'Mở một trang web cụ thể',
                example: 'https://www.google.com'
            },
            {
                type: 'google_search',
                label: 'Tìm kiếm Google',
                icon: Search,
                color: 'red',
                description: 'Tìm kiếm trên Google',
                example: '{{location_name}} - Nhập tên địa điểm'
            },
            {
                type: 'go_back',
                label: 'Quay lại trang trước',
                icon: ArrowLeft,
                color: 'blue',
                description: 'Quay lại trang web trước đó',
                example: 'Giống nút Back trên trình duyệt'
            },
            {
                type: 'refresh_page',
                label: 'Tải lại trang',
                icon: RefreshCw,
                color: 'blue',
                description: 'Refresh trang web hiện tại',
                example: 'Giống nhấn F5'
            },
        ]
    },
    {
        name: 'Tuong tac',
        emoji: '🖱️',
        description: 'Click, nhập text, scroll',
        actions: [
            {
                type: 'click',
                label: 'Click element',
                icon: MousePointerClick,
                color: 'green',
                description: 'Click vào một element trên trang',
                example: 'button.submit hoặc #myButton'
            },
            {
                type: 'type',
                label: 'Nhập text nhanh',
                icon: Keyboard,
                color: 'purple',
                description: 'Nhập text vào ô input nhanh',
                example: 'Dùng cho search box, form input'
            },
            {
                type: 'human_type',
                label: 'Gõ như người thật',
                icon: Type,
                color: 'purple',
                description: 'Gõ từng ký tự như người thật (tránh bị phát hiện bot)',
                example: 'Dùng cho review, comment'
            },
            {
                type: 'scroll',
                label: 'Scroll trang',
                icon: Scroll,
                color: 'cyan',
                description: 'Cuộn trang lên/xuống',
                example: 'Scroll xuống 300px'
            },
            {
                type: 'random_scroll',
                label: 'Scroll ngẫu nhiên',
                icon: Scroll,
                color: 'cyan',
                description: 'Scroll nhiều lần ngẫu nhiên (giống người thật)',
                example: 'Scroll 2-5 lần ngẫu nhiên'
            },
            {
                type: 'hover',
                label: 'Di chuột qua element',
                icon: MousePointer2,
                color: 'green',
                description: 'Di chuột qua một element (hover)',
                example: 'Hover vào menu dropdown'
            },
            {
                type: 'select',
                label: 'Chọn dropdown',
                icon: List,
                color: 'purple',
                description: 'Chọn option từ dropdown select',
                example: 'Chọn giá trị trong select box'
            },
            {
                type: 'keyboard',
                label: 'Nhấn phím',
                icon: Keyboard,
                color: 'purple',
                description: 'Nhấn một phím (Enter, Tab, Escape...)',
                example: 'Nhấn Enter để submit form'
            },
        ]
    },
    {
        name: 'Cho doi',
        emoji: '⏰',
        description: 'Delay, chờ element',
        actions: [
            {
                type: 'wait',
                label: 'Chờ cố định',
                icon: Clock,
                color: 'yellow',
                description: 'Chờ một khoảng thời gian cố định',
                example: 'Chờ 2 giây'
            },
            {
                type: 'random_delay',
                label: 'Chờ ngẫu nhiên',
                icon: Timer,
                color: 'yellow',
                description: 'Chờ ngẫu nhiên trong khoảng thời gian (tránh bị phát hiện)',
                example: 'Chờ 1-3 giây ngẫu nhiên'
            },
        ]
    },
    {
        name: 'Google Maps',
        emoji: '⭐',
        description: 'Review, rating trên Maps',
        actions: [
            {
                type: 'maps_click',
                label: 'Click kết quả Maps',
                icon: Map,
                color: 'green',
                description: 'Click vào kết quả đầu tiên trên Google Maps',
                example: 'Tự động tìm và click'
            },
            {
                type: 'set_rating',
                label: 'Đặt số sao',
                icon: Star,
                color: 'yellow',
                description: 'Chọn số sao đánh giá (1-5)',
                example: '5 sao'
            },
            {
                type: 'write_review',
                label: 'Viết review',
                icon: MessageSquare,
                color: 'blue',
                description: 'Viết nội dung đánh giá',
                example: 'Dịch vụ tuyệt vời!'
            },
        ]
    },
    {
        name: 'Du lieu',
        emoji: '📊',
        description: 'Trích xuất dữ liệu, gán biến',
        actions: [
            {
                type: 'extract',
                label: 'Trích xuất text',
                icon: Eye,
                color: 'teal',
                description: 'Lấy text từ element và lưu vào biến',
                example: 'Lấy tên cửa hàng từ trang'
            },
            {
                type: 'variable',
                label: 'Gán biến',
                icon: Hash,
                color: 'teal',
                description: 'Đặt hoặc thay đổi giá trị biến',
                example: 'Gán my_var = "Hello"'
            },
        ]
    },
    {
        name: 'Nang cao',
        emoji: '🔧',
        description: 'Logic, điều kiện, upload',
        actions: [
            {
                type: 'screenshot',
                label: 'Chụp ảnh màn hình',
                icon: Camera,
                color: 'orange',
                description: 'Lưu ảnh chụp màn hình',
                example: 'screenshot_review.png'
            },
            {
                type: 'upload',
                label: 'Upload file',
                icon: Upload,
                color: 'orange',
                description: 'Upload file (ảnh, tài liệu) vào input',
                example: 'Upload ảnh review'
            },
            {
                type: 'loop',
                label: 'Vòng lặp',
                icon: Repeat,
                color: 'pink',
                description: 'Lặp lại các action nhiều lần',
                example: 'Lặp 3 lần'
            },
            {
                type: 'condition',
                label: 'Điều kiện If/Else',
                icon: GitBranch,
                color: 'orange',
                description: 'Thực hiện action dựa trên điều kiện',
                example: 'Nếu rating = 5 thì...'
            },
        ]
    },
]

// ==================== AVAILABLE VARIABLES ====================
const AVAILABLE_VARIABLES = [
    { name: '{{location_name}}', description: 'Tên địa điểm cần review', example: 'Nhà hàng ABC, Cafe XYZ' },
    { name: '{{location_url}}', description: 'URL Google Maps của địa điểm', example: 'https://maps.google.com/...' },
    { name: '{{review_text}}', description: 'Nội dung review từ template', example: 'Dịch vụ tuyệt vời!' },
    { name: '{{rating}}', description: 'Số sao đánh giá (1-5)', example: '5' },
    { name: '{{account_email}}', description: 'Email tài khoản đang dùng', example: 'user@gmail.com' },
    { name: '{{account_name}}', description: 'Tên tài khoản đang dùng', example: 'Nguyễn Văn A' },
    { name: '{{loop_index}}', description: 'Số thứ tự vòng lặp hiện tại', example: '0, 1, 2...' },
    { name: '{{timestamp}}', description: 'Thời gian hiện tại (epoch ms)', example: '1708752000000' },
    { name: '{{random_delay}}', description: 'Delay ngẫu nhiên tự động', example: '1000-3000ms' },
]

// ==================== SCRIPT TEMPLATES ====================
const SCRIPT_TEMPLATES = [
    {
        id: 'google-maps-review',
        name: 'Review Google Maps',
        description: 'Tự động tìm kiếm và đánh giá địa điểm trên Google Maps',
        actions: [
            { id: '1', type: 'navigate', name: 'Mở Google', enabled: true, params: { url: 'https://www.google.com' } },
            { id: '2', type: 'random_delay', name: 'Chờ trang load', enabled: true, params: { minDelayMs: 2000, maxDelayMs: 4000 } },
            { id: '3', type: 'google_search', name: 'Tìm kiếm địa điểm', enabled: true, params: { searchQuery: '{{location_name}}' } },
            { id: '4', type: 'random_delay', name: 'Chờ kết quả', enabled: true, params: { minDelayMs: 3000, maxDelayMs: 5000 } },
            { id: '5', type: 'maps_click', name: 'Click vào kết quả Maps', enabled: true, params: {} },
            { id: '6', type: 'random_delay', name: 'Chờ Maps load', enabled: true, params: { minDelayMs: 3000, maxDelayMs: 5000 } },
            { id: '7', type: 'random_scroll', name: 'Scroll xem địa điểm', enabled: true, params: { minScrolls: 2, maxScrolls: 4 } },
            { id: '8', type: 'set_rating', name: 'Đặt 5 sao', enabled: true, params: { rating: 5 } },
            { id: '9', type: 'random_delay', name: 'Chờ sau rating', enabled: true, params: { minDelayMs: 1000, maxDelayMs: 2000 } },
            { id: '10', type: 'write_review', name: 'Viết review', enabled: true, params: { reviewText: '{{review_text}}' } },
            { id: '11', type: 'screenshot', name: 'Chụp ảnh kết quả', enabled: true, params: { screenshotName: 'review_done', fullPage: false } },
        ]
    },
    {
        id: 'warm-up',
        name: 'Warm-up Account',
        description: 'Làm nóng tài khoản, lướt web tự nhiên trước khi review',
        actions: [
            { id: '1', type: 'navigate', name: 'Mở Google', enabled: true, params: { url: 'https://www.google.com' } },
            { id: '2', type: 'random_delay', name: 'Chờ', enabled: true, params: { minDelayMs: 2000, maxDelayMs: 4000 } },
            { id: '3', type: 'google_search', name: 'Tìm kiếm ngẫu nhiên', enabled: true, params: { searchQuery: 'thời tiết hôm nay' } },
            { id: '4', type: 'random_delay', name: 'Đọc kết quả', enabled: true, params: { minDelayMs: 3000, maxDelayMs: 6000 } },
            { id: '5', type: 'random_scroll', name: 'Scroll đọc tin', enabled: true, params: { minScrolls: 3, maxScrolls: 6 } },
            { id: '6', type: 'navigate', name: 'Mở YouTube', enabled: true, params: { url: 'https://www.youtube.com' } },
            { id: '7', type: 'random_delay', name: 'Xem YouTube', enabled: true, params: { minDelayMs: 5000, maxDelayMs: 10000 } },
            { id: '8', type: 'random_scroll', name: 'Scroll YouTube', enabled: true, params: { minScrolls: 2, maxScrolls: 4 } },
        ]
    },
    {
        id: 'simple-search',
        name: 'Tìm kiếm đơn giản',
        description: 'Chỉ tìm kiếm và xem kết quả, không thao tác gì thêm',
        actions: [
            { id: '1', type: 'navigate', name: 'Mở Google', enabled: true, params: { url: 'https://www.google.com' } },
            { id: '2', type: 'random_delay', name: 'Chờ trang load', enabled: true, params: { minDelayMs: 1000, maxDelayMs: 2000 } },
            { id: '3', type: 'google_search', name: 'Tìm kiếm', enabled: true, params: { searchQuery: '{{location_name}}' } },
            { id: '4', type: 'random_delay', name: 'Xem kết quả', enabled: true, params: { minDelayMs: 3000, maxDelayMs: 5000 } },
            { id: '5', type: 'screenshot', name: 'Chụp màn hình', enabled: true, params: { screenshotName: 'search_result', fullPage: false } },
        ]
    },
    {
        id: 'social-media-browse',
        name: 'Lướt mạng xã hội',
        description: 'Lướt Facebook/Instagram tự nhiên để warm-up tài khoản',
        actions: [
            { id: '1', type: 'navigate', name: 'Mở Facebook', enabled: true, params: { url: 'https://www.facebook.com' } },
            { id: '2', type: 'random_delay', name: 'Chờ load', enabled: true, params: { minDelayMs: 3000, maxDelayMs: 5000 } },
            { id: '3', type: 'random_scroll', name: 'Lướt News Feed', enabled: true, params: { minScrolls: 3, maxScrolls: 7 } },
            { id: '4', type: 'random_delay', name: 'Đọc bài viết', enabled: true, params: { minDelayMs: 5000, maxDelayMs: 10000 } },
            { id: '5', type: 'random_scroll', name: 'Scroll tiếp', enabled: true, params: { minScrolls: 2, maxScrolls: 5 } },
            { id: '6', type: 'navigate', name: 'Mở Instagram', enabled: true, params: { url: 'https://www.instagram.com' } },
            { id: '7', type: 'random_delay', name: 'Chờ Instagram', enabled: true, params: { minDelayMs: 3000, maxDelayMs: 5000 } },
            { id: '8', type: 'random_scroll', name: 'Lướt Instagram', enabled: true, params: { minScrolls: 3, maxScrolls: 6 } },
            { id: '9', type: 'random_delay', name: 'Xem ảnh', enabled: true, params: { minDelayMs: 4000, maxDelayMs: 8000 } },
            { id: '10', type: 'screenshot', name: 'Chụp kết quả', enabled: true, params: { screenshotName: 'social_browse', fullPage: false } },
        ]
    },
    {
        id: 'form-auto-fill',
        name: 'Điền form tự động',
        description: 'Tự động điền form đăng ký, liên hệ, khảo sát',
        actions: [
            { id: '1', type: 'navigate', name: 'Mở trang form', enabled: true, params: { url: '{{form_url}}' } },
            { id: '2', type: 'random_delay', name: 'Chờ form load', enabled: true, params: { minDelayMs: 2000, maxDelayMs: 3000 } },
            { id: '3', type: 'human_type', name: 'Nhập tên', enabled: true, params: { selector: 'input[name="name"]', text: '{{account_name}}', minDelay: 50, maxDelay: 150 } },
            { id: '4', type: 'random_delay', name: 'Nghỉ tay', enabled: true, params: { minDelayMs: 500, maxDelayMs: 1500 } },
            { id: '5', type: 'human_type', name: 'Nhập email', enabled: true, params: { selector: 'input[name="email"]', text: '{{account_email}}', minDelay: 40, maxDelay: 120 } },
            { id: '6', type: 'random_delay', name: 'Nghỉ tay', enabled: true, params: { minDelayMs: 500, maxDelayMs: 1000 } },
            { id: '7', type: 'human_type', name: 'Nhập nội dung', enabled: true, params: { selector: 'textarea', text: '{{review_text}}', minDelay: 60, maxDelay: 180 } },
            { id: '8', type: 'random_delay', name: 'Kiểm tra lại', enabled: true, params: { minDelayMs: 1000, maxDelayMs: 2000 } },
            { id: '9', type: 'screenshot', name: 'Chụp form', enabled: true, params: { screenshotName: 'form_filled', fullPage: false } },
            { id: '10', type: 'click', name: 'Submit form', enabled: true, params: { selector: 'button[type="submit"]' } },
        ]
    },
    {
        id: 'web-scraping',
        name: 'Thu thập dữ liệu',
        description: 'Trích xuất thông tin từ trang web (tên, giá, địa chỉ...)',
        actions: [
            { id: '1', type: 'navigate', name: 'Mở trang', enabled: true, params: { url: '{{target_url}}' } },
            { id: '2', type: 'random_delay', name: 'Chờ load', enabled: true, params: { minDelayMs: 2000, maxDelayMs: 4000 } },
            { id: '3', type: 'extract', name: 'Lấy tiêu đề', enabled: true, params: { selector: 'h1', variableName: 'page_title' } },
            { id: '4', type: 'extract', name: 'Lấy mô tả', enabled: true, params: { selector: 'meta[name="description"]', variableName: 'page_description' } },
            { id: '5', type: 'random_scroll', name: 'Scroll xem nội dung', enabled: true, params: { minScrolls: 2, maxScrolls: 4 } },
            { id: '6', type: 'extract', name: 'Lấy nội dung chính', enabled: true, params: { selector: '.content, article, main', variableName: 'main_content' } },
            { id: '7', type: 'screenshot', name: 'Chụp trang', enabled: true, params: { screenshotName: 'scraped_page', fullPage: true } },
        ]
    },
    {
        id: 'seo-traffic-boost',
        name: 'Tăng traffic SEO',
        description: 'Giả lập traffic tìm kiếm tự nhiên, click vào kết quả mục tiêu',
        actions: [
            { id: '1', type: 'navigate', name: 'Mở Google', enabled: true, params: { url: 'https://www.google.com' } },
            { id: '2', type: 'random_delay', name: 'Chờ Google', enabled: true, params: { minDelayMs: 1000, maxDelayMs: 3000 } },
            { id: '3', type: 'google_search', name: 'Tìm từ khóa SEO', enabled: true, params: { searchQuery: '{{seo_keyword}}' } },
            { id: '4', type: 'random_delay', name: 'Xem kết quả', enabled: true, params: { minDelayMs: 3000, maxDelayMs: 6000 } },
            { id: '5', type: 'random_scroll', name: 'Scroll tìm kết quả', enabled: true, params: { minScrolls: 1, maxScrolls: 3 } },
            { id: '6', type: 'click', name: 'Click vào kết quả mục tiêu', enabled: true, params: { selector: '{{target_selector}}' } },
            { id: '7', type: 'random_delay', name: 'Ở lại trang', enabled: true, params: { minDelayMs: 10000, maxDelayMs: 30000 } },
            { id: '8', type: 'random_scroll', name: 'Đọc nội dung', enabled: true, params: { minScrolls: 3, maxScrolls: 8 } },
            { id: '9', type: 'random_delay', name: 'Đọc thêm', enabled: true, params: { minDelayMs: 5000, maxDelayMs: 15000 } },
            { id: '10', type: 'screenshot', name: 'Chụp bằng chứng', enabled: true, params: { screenshotName: 'seo_visit', fullPage: false } },
        ]
    },
]

// ==================== HELPER FUNCTIONS ====================
const generateId = () => `action-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

const getDefaultParams = (type: string): Record<string, any> => {
    switch (type) {
        case 'navigate': return { url: 'https://www.google.com' }
        case 'click': return { selector: '' }
        case 'type': return { selector: '', text: '' }
        case 'human_type': return { selector: '', text: '', minDelay: 50, maxDelay: 150 }
        case 'wait': return { waitType: 'time', waitTime: 2000 }
        case 'random_delay': return { minDelayMs: 1000, maxDelayMs: 3000 }
        case 'scroll': return { scrollDirection: 'down', scrollAmount: 300 }
        case 'random_scroll': return { minScrolls: 2, maxScrolls: 5 }
        case 'screenshot': return { screenshotName: 'screenshot', fullPage: false }
        case 'google_search': return { searchQuery: '{{location_name}}' }
        case 'maps_click': return {}
        case 'set_rating': return { rating: 5 }
        case 'write_review': return { reviewText: '{{review_text}}' }
        case 'loop': return { loopCount: 3 }
        case 'condition': return { variable: '', operator: 'equals', value: '' }
        case 'hover': return { selector: '' }
        case 'select': return { selector: '', selectValue: '', selectByText: false }
        case 'keyboard': return { key: 'Enter', modifiers: [] }
        case 'upload': return { selector: '', filePath: '' }
        case 'extract': return { selector: '', variableName: '' }
        case 'variable': return { variableName: '', variableValue: '' }
        case 'go_back': return {}
        case 'refresh_page': return {}
        default: return {}
    }
}

const getActionColor = (type: string) => {
    const colorMap: Record<string, string> = {
        navigate: 'bg-blue-50 text-blue-600 border-blue-200',
        google_search: 'bg-rose-50 text-rose-600 border-rose-200',
        go_back: 'bg-blue-50 text-blue-600 border-blue-200',
        refresh_page: 'bg-blue-50 text-blue-600 border-blue-200',
        click: 'bg-emerald-50 text-emerald-600 border-emerald-200',
        type: 'bg-violet-50 text-violet-600 border-violet-200',
        human_type: 'bg-violet-50 text-violet-600 border-violet-200',
        hover: 'bg-emerald-50 text-emerald-600 border-emerald-200',
        select: 'bg-violet-50 text-violet-600 border-violet-200',
        keyboard: 'bg-violet-50 text-violet-600 border-violet-200',
        wait: 'bg-amber-50 text-amber-600 border-amber-200',
        random_delay: 'bg-amber-50 text-amber-600 border-amber-200',
        scroll: 'bg-cyan-50 text-cyan-600 border-cyan-200',
        random_scroll: 'bg-cyan-50 text-cyan-600 border-cyan-200',
        screenshot: 'bg-orange-50 text-orange-600 border-orange-200',
        upload: 'bg-orange-50 text-orange-600 border-orange-200',
        maps_click: 'bg-emerald-50 text-emerald-600 border-emerald-200',
        set_rating: 'bg-amber-50 text-amber-600 border-amber-200',
        write_review: 'bg-blue-50 text-blue-600 border-blue-200',
        extract: 'bg-teal-50 text-teal-600 border-teal-200',
        variable: 'bg-teal-50 text-teal-600 border-teal-200',
        loop: 'bg-pink-50 text-pink-600 border-pink-200',
        condition: 'bg-orange-50 text-orange-600 border-orange-200',
    }
    return colorMap[type] || 'bg-[#f7f7f9] text-[#5f5a6d] border-[#e9e4f2]'
}

const getActionIcon = (type: string) => {
    const iconMap: Record<string, any> = {
        navigate: Navigation,
        google_search: Search,
        go_back: ArrowLeft,
        refresh_page: RefreshCw,
        click: MousePointerClick,
        type: Keyboard,
        human_type: Type,
        hover: MousePointer2,
        select: List,
        keyboard: Keyboard,
        wait: Clock,
        random_delay: Timer,
        scroll: Scroll,
        random_scroll: Scroll,
        screenshot: Camera,
        upload: Upload,
        maps_click: Map,
        set_rating: Star,
        write_review: MessageSquare,
        extract: Eye,
        variable: Hash,
        loop: Repeat,
        condition: GitBranch,
    }
    return iconMap[type] || Zap
}

// ==================== MAIN COMPONENT ====================
export function Scripts() {
    const { t } = useI18n()
    const [scripts, setScripts] = useState<AutomationScript[]>([])
    const [currentScript, setCurrentScript] = useState<AutomationScript | null>(null)
    const [isRunning, setIsRunning] = useState(false)
    const [runStatus, setRunStatus] = useState<{ message: string; progress: number } | null>(null)
    const [showTemplates, setShowTemplates] = useState(false)
    const [showHelp, setShowHelp] = useState(false)
    const [showRunModal, setShowRunModal] = useState(false)
    const [systemAccounts, setSystemAccounts] = useState<any[]>([])
    const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([])
    const [runResults, setRunResults] = useState<any[] | null>(null)
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null)
    const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null)
    const [showSettings, setShowSettings] = useState(false)
    const [showVarManager, setShowVarManager] = useState(false)
    const [showScriptList, setShowScriptList] = useState(true)

    useEffect(() => {
        loadScripts()
        loadAccounts()
    }, [])

    // Toast auto-dismiss
    useEffect(() => {
        if (toast) {
            const timer = setTimeout(() => setToast(null), 3000)
            return () => clearTimeout(timer)
        }
    }, [toast])

    const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
        setToast({ message, type })
    }

    const loadAccounts = async () => {
        try {
            const data = await (window as any).electronAPI?.accounts?.getAll?.() || []
            setSystemAccounts(data.filter((a: any) => a.status === 'active'))
        } catch (error) {
            console.error('Failed to load accounts:', error)
        }
    }

    const loadScripts = async () => {
        try {
            const data = await (window as any).electronAPI?.scripts?.getAll?.() || []
            setScripts(data)
            if (data.length > 0 && !currentScript) {
                setCurrentScript(data[0])
            } else if (!currentScript) {
                createNewScript()
            }
        } catch (error) {
            console.error('Failed to load scripts:', error)
            createNewScript()
        }
    }

    const createNewScript = () => {
        const newScript: AutomationScript = {
            id: generateId(),
            name: 'Kịch bản mới',
            description: 'Mô tả kịch bản của bạn',
            version: '1.0.0',
            createdAt: new Date(),
            updatedAt: new Date(),
            variables: [],
            actions: [],
            settings: {
                headless: false,
                defaultTimeout: 30000,
                viewport: { width: 1366, height: 768 }
            }
        }
        setCurrentScript(newScript)
        setScripts(prev => [...prev, newScript])
    }

    const loadTemplate = (template: typeof SCRIPT_TEMPLATES[0]) => {
        const newScript: AutomationScript = {
            id: generateId(),
            name: template.name,
            description: template.description,
            version: '1.0.0',
            createdAt: new Date(),
            updatedAt: new Date(),
            variables: [],
            actions: template.actions.map(a => ({ ...a, id: generateId() })),
            settings: { headless: false, defaultTimeout: 30000, viewport: { width: 1366, height: 768 } }
        }
        setCurrentScript(newScript)
        setScripts(prev => [...prev, newScript])
        setShowTemplates(false)
    }

    const saveScript = async () => {
        if (!currentScript) return
        try {
            await (window as any).electronAPI?.scripts?.save?.(currentScript)
            setScripts(prev => {
                const exists = prev.find(s => s.id === currentScript.id)
                if (exists) return prev.map(s => s.id === currentScript.id ? currentScript : s)
                return [...prev, currentScript]
            })
            showToast('Đã lưu kịch bản thành công!')
        } catch (error) {
            console.error('Failed to save script:', error)
            setScripts(scripts.map(s => s.id === currentScript.id ? currentScript : s))
            showToast('Đã lưu local (lỗi DB)', 'info')
        }
    }

    const deleteScript = async (scriptId: string) => {
        try {
            await (window as any).electronAPI?.scripts?.delete?.(scriptId)
            const remaining = scripts.filter(s => s.id !== scriptId)
            setScripts(remaining)
            if (currentScript?.id === scriptId) {
                setCurrentScript(remaining.length > 0 ? remaining[0] : null)
                if (remaining.length === 0) createNewScript()
            }
            showToast('Đã xóa kịch bản')
        } catch (error) {
            console.error('Failed to delete script:', error)
            showToast('Lỗi xóa kịch bản', 'error')
        }
        setShowDeleteConfirm(null)
    }

    const exportScript = () => {
        if (!currentScript) return
        const data = JSON.stringify(currentScript, null, 2)
        const blob = new Blob([data], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${currentScript.name.replace(/[^a-zA-Z0-9]/g, '_')}.json`
        a.click()
        URL.revokeObjectURL(url)
        showToast('Đã xuất kịch bản')
    }

    const importScript = () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json'
        input.onchange = (e) => {
            const file = (e.target as HTMLInputElement).files?.[0]
            if (!file) return
            const reader = new FileReader()
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target?.result as string)
                    const imported: AutomationScript = { ...data, id: generateId(), createdAt: new Date(), updatedAt: new Date() }
                    setCurrentScript(imported)
                    setScripts(prev => [...prev, imported])
                    showToast('Đã nhập kịch bản: ' + imported.name)
                } catch {
                    showToast('File JSON không hợp lệ', 'error')
                }
            }
            reader.readAsText(file)
        }
        input.click()
    }

    const addVariable = () => {
        if (!currentScript) return
        const newVar: ScriptVariable = { name: `var_${currentScript.variables.length + 1}`, type: 'string', defaultValue: '', description: 'Biến mới' }
        setCurrentScript({ ...currentScript, variables: [...currentScript.variables, newVar] })
    }

    const updateVariable = (index: number, updates: Partial<ScriptVariable>) => {
        if (!currentScript) return
        setCurrentScript({ ...currentScript, variables: currentScript.variables.map((v, i) => i === index ? { ...v, ...updates } : v) })
    }

    const deleteVariable = (index: number) => {
        if (!currentScript) return
        setCurrentScript({ ...currentScript, variables: currentScript.variables.filter((_, i) => i !== index) })
    }

    const addAction = (type: string, actionDef: any) => {
        if (!currentScript) return
        const newAction: ScriptAction = { id: generateId(), type, name: actionDef?.label || type, enabled: true, params: getDefaultParams(type), expanded: true }
        setCurrentScript({ ...currentScript, actions: [...currentScript.actions, newAction] })
    }

    const updateAction = (actionId: string, updates: Partial<ScriptAction>) => {
        if (!currentScript) return
        setCurrentScript({ ...currentScript, actions: currentScript.actions.map(a => a.id === actionId ? { ...a, ...updates } : a) })
    }

    const updateActionParam = (actionId: string, paramKey: string, value: any) => {
        if (!currentScript) return
        setCurrentScript({ ...currentScript, actions: currentScript.actions.map(a => a.id === actionId ? { ...a, params: { ...a.params, [paramKey]: value } } : a) })
    }

    const deleteAction = (actionId: string) => {
        if (!currentScript) return
        setCurrentScript({ ...currentScript, actions: currentScript.actions.filter(a => a.id !== actionId) })
    }

    const moveAction = (actionId: string, direction: 'up' | 'down') => {
        if (!currentScript) return
        const idx = currentScript.actions.findIndex(a => a.id === actionId)
        if (idx === -1) return
        if (direction === 'up' && idx === 0) return
        if (direction === 'down' && idx === currentScript.actions.length - 1) return
        const newActions = [...currentScript.actions]
        const targetIdx = direction === 'up' ? idx - 1 : idx + 1
            ;[newActions[idx], newActions[targetIdx]] = [newActions[targetIdx], newActions[idx]]
        setCurrentScript({ ...currentScript, actions: newActions })
    }

    const duplicateAction = (actionId: string) => {
        if (!currentScript) return
        const action = currentScript.actions.find(a => a.id === actionId)
        if (!action) return
        const idx = currentScript.actions.findIndex(a => a.id === actionId)
        const newAction = { ...action, id: generateId(), name: `${action.name} (copy)` }
        const newActions = [...currentScript.actions]
        newActions.splice(idx + 1, 0, newAction)
        setCurrentScript({ ...currentScript, actions: newActions })
    }

    const toggleAllActions = (expanded: boolean) => {
        if (!currentScript) return
        setCurrentScript({ ...currentScript, actions: currentScript.actions.map(a => ({ ...a, expanded })) })
    }

    // Drag and drop
    const draggedActionRef = useRef<string | null>(null)
    const handleDragStart = useCallback((actionId: string) => { draggedActionRef.current = actionId }, [])
    const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }, [])
    const handleDrop = useCallback((targetActionId: string) => {
        if (!currentScript || !draggedActionRef.current) return
        if (draggedActionRef.current === targetActionId) return
        const actions = [...currentScript.actions]
        const fromIdx = actions.findIndex(a => a.id === draggedActionRef.current)
        const toIdx = actions.findIndex(a => a.id === targetActionId)
        if (fromIdx === -1 || toIdx === -1) return
        const [moved] = actions.splice(fromIdx, 1)
        actions.splice(toIdx, 0, moved)
        setCurrentScript({ ...currentScript, actions })
        draggedActionRef.current = null
    }, [currentScript])

    const handleRunClick = () => {
        if (!currentScript || isRunning) return
        setRunResults(null)
        setSelectedAccountIds([])
        setShowRunModal(true)
    }

    const runScriptDirect = async () => {
        if (!currentScript || isRunning) return
        setShowRunModal(false)
        setIsRunning(true)
        setRunStatus({ message: t('scripts.startingBrowser'), progress: 0 })
        try {
            const result = await (window as any).electronAPI?.scripts?.run?.(currentScript)
            if (result?.success) {
                setRunStatus({ message: t('scripts.completed'), progress: 100 })
            } else {
                setRunStatus({ message: `${t('scripts.error')}: ${result?.errors?.[0]?.error || 'Unknown'}`, progress: 0 })
            }
        } catch (error) {
            setRunStatus({ message: `${t('scripts.error')}: ${error}`, progress: 0 })
        } finally {
            setIsRunning(false)
        }
    }

    const runScriptWithAccounts = async () => {
        if (!currentScript || isRunning || selectedAccountIds.length === 0) return
        setShowRunModal(false)
        setIsRunning(true)
        setRunStatus({ message: `Chạy script cho ${selectedAccountIds.length} tài khoản...`, progress: 0 })
        try {
            const result = await (window as any).electronAPI?.scripts?.runWithAccounts?.(currentScript, selectedAccountIds)
            if (result?.success) {
                setRunResults(result.results)
                setRunStatus({ message: `Hoàn tất cho ${result.results?.length || 0} tài khoản`, progress: 100 })
            } else {
                setRunResults(result?.results || null)
                const failedCount = result?.results?.filter((r: any) => !r.success)?.length || 0
                setRunStatus({ message: `${failedCount} tài khoản thất bại`, progress: 0 })
            }
        } catch (error) {
            setRunStatus({ message: `${t('scripts.error')}: ${error}`, progress: 0 })
        } finally {
            setIsRunning(false)
        }
    }

    const toggleAccountSelection = (accountId: number) => {
        setSelectedAccountIds(prev => prev.includes(accountId) ? prev.filter(id => id !== accountId) : [...prev, accountId])
    }

    // ==================== RENDER ACTION PARAMS ====================
    const renderActionParams = (action: ScriptAction) => {
        const { type, params } = action
        const inputClass = "w-full h-10 px-4 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] placeholder:text-[#908a9e] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3]"
        const textareaClass = "w-full px-4 py-3 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] placeholder:text-[#908a9e] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3]"
        const labelClass = "block text-xs font-semibold text-[#6f697c] mb-1"
        const hintClass = "text-xs text-[#908a9e] mt-1"

        switch (type) {
            case 'navigate':
                return (<div className="space-y-2"><div><label className={labelClass}>URL trang web</label><input type="text" value={params.url || ''} onChange={(e) => updateActionParam(action.id, 'url', e.target.value)} className={inputClass} placeholder="https://www.google.com" /><p className={hintClass}>Nhập địa chỉ trang web đầy đủ</p></div></div>)
            case 'click':
                return (<div className="space-y-2"><div><label className={labelClass}>CSS Selector của element</label><input type="text" value={params.selector || ''} onChange={(e) => updateActionParam(action.id, 'selector', e.target.value)} className={inputClass} placeholder="button.submit, #myButton, .btn-primary" /><p className={hintClass}>Mẹo: Click chuột phải vào element - Inspect - Copy selector</p></div></div>)
            case 'type': case 'human_type':
                return (<div className="space-y-3"><div><label className={labelClass}>CSS Selector của ô input</label><input type="text" value={params.selector || ''} onChange={(e) => updateActionParam(action.id, 'selector', e.target.value)} className={inputClass} placeholder="input[name='q'], textarea#review" /><p className={hintClass}>Để trống nếu muốn type vào element đang focus</p></div><div><label className={labelClass}>Nội dung muốn nhập</label><textarea value={params.text || ''} onChange={(e) => updateActionParam(action.id, 'text', e.target.value)} className={`${textareaClass} h-24`} placeholder="Nhập text vào đây... Có thể dùng biến {{location_name}}" /><p className={hintClass}>Dùng biến như {'{{location_name}}'} để tự động thay thế</p></div>{type === 'human_type' && (<div className="grid grid-cols-2 gap-3 p-3 bg-[#f7f7f9] rounded-[14px] border border-[#e9e4f2]"><div><label className={labelClass}>Delay tối thiểu (ms)</label><input type="number" value={params.minDelay || 50} onChange={(e) => updateActionParam(action.id, 'minDelay', parseInt(e.target.value))} className={inputClass} /></div><div><label className={labelClass}>Delay tối đa (ms)</label><input type="number" value={params.maxDelay || 150} onChange={(e) => updateActionParam(action.id, 'maxDelay', parseInt(e.target.value))} className={inputClass} /></div><p className={`${hintClass} col-span-2`}>50-150ms giống người gõ bình thường</p></div>)}</div>)
            case 'wait':
                return (<div className="space-y-3"><div><label className={labelClass}>Loại chờ</label><select value={params.waitType || 'time'} onChange={(e) => updateActionParam(action.id, 'waitType', e.target.value)} className={inputClass}><option value="time">Chờ theo thời gian</option><option value="element">Chờ element xuất hiện</option><option value="navigation">Chờ trang load xong</option></select></div>{params.waitType === 'time' && (<div><label className={labelClass}>Thời gian chờ (ms)</label><input type="number" value={params.waitTime || 2000} onChange={(e) => updateActionParam(action.id, 'waitTime', parseInt(e.target.value))} className={inputClass} /><p className={hintClass}>1000ms = 1 giây</p></div>)}{params.waitType === 'element' && (<div><label className={labelClass}>CSS Selector element cần chờ</label><input type="text" value={params.waitSelector || ''} onChange={(e) => updateActionParam(action.id, 'waitSelector', e.target.value)} className={inputClass} placeholder=".review-form, #submit-btn" /></div>)}</div>)
            case 'random_delay':
                return (<div className="space-y-3"><div className="grid grid-cols-2 gap-3"><div><label className={labelClass}>Tối thiểu (ms)</label><input type="number" value={params.minDelayMs || 1000} onChange={(e) => updateActionParam(action.id, 'minDelayMs', parseInt(e.target.value))} className={inputClass} /></div><div><label className={labelClass}>Tối đa (ms)</label><input type="number" value={params.maxDelayMs || 3000} onChange={(e) => updateActionParam(action.id, 'maxDelayMs', parseInt(e.target.value))} className={inputClass} /></div></div><p className={hintClass}>Khuyến nghị: 2000-5000ms cho delay tự nhiên</p></div>)
            case 'random_scroll':
                return (<div className="space-y-3"><div className="grid grid-cols-2 gap-3"><div><label className={labelClass}>Số lần scroll tối thiểu</label><input type="number" value={params.minScrolls || 2} onChange={(e) => updateActionParam(action.id, 'minScrolls', parseInt(e.target.value))} className={inputClass} /></div><div><label className={labelClass}>Số lần scroll tối đa</label><input type="number" value={params.maxScrolls || 5} onChange={(e) => updateActionParam(action.id, 'maxScrolls', parseInt(e.target.value))} className={inputClass} /></div></div><p className={hintClass}>Scroll ngẫu nhiên giúp giống người thật hơn</p></div>)
            case 'scroll':
                return (<div className="space-y-3"><div className="grid grid-cols-2 gap-3"><div><label className={labelClass}>Hướng scroll</label><select value={params.scrollDirection || 'down'} onChange={(e) => updateActionParam(action.id, 'scrollDirection', e.target.value)} className={inputClass}><option value="down">Xuống</option><option value="up">Lên</option></select></div><div><label className={labelClass}>Khoảng cách (px)</label><input type="number" value={params.scrollAmount || 300} onChange={(e) => updateActionParam(action.id, 'scrollAmount', parseInt(e.target.value))} className={inputClass} /></div></div></div>)
            case 'screenshot':
                return (<div className="space-y-3"><div><label className={labelClass}>Tên file ảnh</label><input type="text" value={params.screenshotName || ''} onChange={(e) => updateActionParam(action.id, 'screenshotName', e.target.value)} className={inputClass} placeholder="screenshot_review" /></div><label className="flex items-center gap-2 text-sm text-[#5f5a6d] cursor-pointer"><input type="checkbox" checked={params.fullPage || false} onChange={(e) => updateActionParam(action.id, 'fullPage', e.target.checked)} className="h-4 w-4 rounded accent-[#8d74e8]" />Chụp toàn bộ trang (full page)</label></div>)
            case 'google_search':
                return (<div className="space-y-2"><div><label className={labelClass}>Từ khóa tìm kiếm</label><input type="text" value={params.searchQuery || ''} onChange={(e) => updateActionParam(action.id, 'searchQuery', e.target.value)} className={inputClass} placeholder="{{location_name}}" /><p className={hintClass}>Dùng {'{{location_name}}'} để tự động lấy tên địa điểm</p></div></div>)
            case 'set_rating':
                return (<div className="space-y-2"><div><label className={labelClass}>Số sao đánh giá</label><select value={params.rating || 5} onChange={(e) => updateActionParam(action.id, 'rating', parseInt(e.target.value))} className={inputClass}><option value={5}>5 sao - Tuyệt vời</option><option value={4}>4 sao - Tốt</option><option value={3}>3 sao - Bình thường</option><option value={2}>2 sao - Không tốt</option><option value={1}>1 sao - Rất tệ</option></select></div></div>)
            case 'write_review':
                return (<div className="space-y-2"><div><label className={labelClass}>Nội dung review</label><textarea value={params.reviewText || ''} onChange={(e) => updateActionParam(action.id, 'reviewText', e.target.value)} className={`${textareaClass} h-32`} placeholder="{{review_text}} hoặc nhập nội dung trực tiếp" /><p className={hintClass}>Dùng {'{{review_text}}'} để lấy từ template hoặc nhập trực tiếp</p></div></div>)
            case 'maps_click':
                return (<AlertBanner type="success" className="!rounded-[14px]"><p className="text-sm font-medium">Action này tự động!</p><p className="text-xs mt-0.5">Sẽ tự động click vào kết quả Google Maps đầu tiên</p></AlertBanner>)
            case 'loop':
                return (<div className="space-y-2"><div><label className={labelClass}>Số lần lặp</label><input type="number" value={params.loopCount || 3} onChange={(e) => updateActionParam(action.id, 'loopCount', parseInt(e.target.value))} className={inputClass} min={1} max={100} /></div></div>)
            case 'hover':
                return (<div className="space-y-2"><div><label className={labelClass}>CSS Selector element cần hover</label><input type="text" value={params.selector || ''} onChange={(e) => updateActionParam(action.id, 'selector', e.target.value)} className={inputClass} placeholder=".menu-item, #dropdown-trigger" /><p className={hintClass}>Di chuột qua element để kích hoạt dropdown, tooltip...</p></div></div>)
            case 'select':
                return (<div className="space-y-3"><div><label className={labelClass}>CSS Selector của select box</label><input type="text" value={params.selector || ''} onChange={(e) => updateActionParam(action.id, 'selector', e.target.value)} className={inputClass} placeholder="select#country, select[name='category']" /></div><div><label className={labelClass}>Giá trị cần chọn</label><input type="text" value={params.selectValue || ''} onChange={(e) => updateActionParam(action.id, 'selectValue', e.target.value)} className={inputClass} placeholder="Nhập value hoặc text của option" /></div><label className="flex items-center gap-2 text-sm text-[#5f5a6d] cursor-pointer"><input type="checkbox" checked={params.selectByText || false} onChange={(e) => updateActionParam(action.id, 'selectByText', e.target.checked)} className="h-4 w-4 rounded accent-[#8d74e8]" />Chọn theo text hiển thị (thay vì value)</label></div>)
            case 'keyboard':
                return (<div className="space-y-3"><div><label className={labelClass}>Phím cần nhấn</label><select value={params.key || 'Enter'} onChange={(e) => updateActionParam(action.id, 'key', e.target.value)} className={inputClass}><option value="Enter">Enter</option><option value="Tab">Tab</option><option value="Escape">Escape</option><option value="Space">Space</option><option value="Backspace">Backspace</option><option value="Delete">Delete</option><option value="ArrowUp">Arrow Up</option><option value="ArrowDown">Arrow Down</option><option value="ArrowLeft">Arrow Left</option><option value="ArrowRight">Arrow Right</option><option value="Home">Home</option><option value="End">End</option><option value="PageUp">Page Up</option><option value="PageDown">Page Down</option><option value="F5">F5 (Refresh)</option></select></div><div><label className={labelClass}>Phím bổ trợ (giữ khi nhấn)</label><div className="flex gap-3">{['Control', 'Shift', 'Alt'].map(mod => (<label key={mod} className="flex items-center gap-1 text-sm text-[#5f5a6d] cursor-pointer"><input type="checkbox" checked={(params.modifiers || []).includes(mod)} onChange={(e) => { const mods = params.modifiers || []; updateActionParam(action.id, 'modifiers', e.target.checked ? [...mods, mod] : mods.filter((m: string) => m !== mod)) }} className="h-4 w-4 rounded accent-[#8d74e8]" />{mod}</label>))}</div></div></div>)
            case 'upload':
                return (<div className="space-y-3"><div><label className={labelClass}>CSS Selector input file</label><input type="text" value={params.selector || ''} onChange={(e) => updateActionParam(action.id, 'selector', e.target.value)} className={inputClass} placeholder="input[type='file'], #upload-input" /></div><div><label className={labelClass}>Đường dẫn file</label><input type="text" value={params.filePath || ''} onChange={(e) => updateActionParam(action.id, 'filePath', e.target.value)} className={inputClass} placeholder="C:\Users\photo.jpg" /><p className={hintClass}>Nhập đường dẫn đầy đủ đến file cần upload</p></div></div>)
            case 'extract':
                return (<div className="space-y-3"><div><label className={labelClass}>CSS Selector element chứa text</label><input type="text" value={params.selector || ''} onChange={(e) => updateActionParam(action.id, 'selector', e.target.value)} className={inputClass} placeholder="h1.title, .store-name, #price" /></div><div><label className={labelClass}>Lưu vào biến</label><input type="text" value={params.variableName || ''} onChange={(e) => updateActionParam(action.id, 'variableName', e.target.value)} className={inputClass} placeholder="store_name" /><p className={hintClass}>Sau đó dùng {'{{store_name}}'} ở các bước sau</p></div></div>)
            case 'variable':
                return (<div className="space-y-3"><div><label className={labelClass}>Tên biến</label><input type="text" value={params.variableName || ''} onChange={(e) => updateActionParam(action.id, 'variableName', e.target.value)} className={inputClass} placeholder="my_variable" /></div><div><label className={labelClass}>Giá trị</label><input type="text" value={params.variableValue || ''} onChange={(e) => updateActionParam(action.id, 'variableValue', e.target.value)} className={inputClass} placeholder="Hello World hoặc {{location_name}}" /><p className={hintClass}>Có thể dùng biến khác trong giá trị</p></div></div>)
            case 'go_back':
                return (<AlertBanner type="info" className="!rounded-[14px]"><p className="text-sm font-medium">Action này tự động!</p><p className="text-xs mt-0.5">Quay lại trang trước (giống nút Back trên trình duyệt)</p></AlertBanner>)
            case 'refresh_page':
                return (<AlertBanner type="info" className="!rounded-[14px]"><p className="text-sm font-medium">Action này tự động!</p><p className="text-xs mt-0.5">Tải lại trang hiện tại (giống nhấn F5)</p></AlertBanner>)
            default:
                return (<div className="p-3 bg-[#f7f7f9] rounded-[14px] border border-[#e9e4f2]"><p className="text-xs text-[#908a9e]">Không có cài đặt cho action này</p></div>)
        }
    }

    // ==================== RENDER ====================
    return (
        <PageShell>
            {/* Toast Notification */}
            {toast && (
                <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-[18px] shadow-[0_18px_48px_rgba(40,36,54,0.12)] border flex items-center gap-2 animate-[slideIn_0.3s_ease] ${toast.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                    toast.type === 'error' ? 'bg-rose-50 border-rose-200 text-rose-700' :
                        'bg-blue-50 border-blue-200 text-blue-700'
                    }`}>
                    <span className="text-sm font-semibold">{toast.message}</span>
                    <button onClick={() => setToast(null)} className="ml-2 opacity-60 hover:opacity-100">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            <Modal
                open={!!showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(null)}
                title="Xác nhận xóa"
                size="sm"
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowDeleteConfirm(null)}>Hủy</PrimaryButton>
                        <PrimaryButton tone="rose" onClick={() => showDeleteConfirm && deleteScript(showDeleteConfirm)}>Xóa</PrimaryButton>
                    </>
                }
            >
                <div className="flex items-center gap-3 mb-3">
                    <div className="p-2 bg-rose-50 rounded-full"><AlertTriangle className="w-5 h-5 text-rose-500" /></div>
                    <p className="text-sm text-[#5f5a6d]">Bạn có chắc muốn xóa kịch bản <strong className="text-[#17171f]">{scripts.find(s => s.id === showDeleteConfirm)?.name}</strong>? Hành động này không thể hoàn tác.</p>
                </div>
            </Modal>

            {/* Header */}
            <PageHeader icon={Zap} tone="violet" title={t('scripts.title')} subtitle={t('scripts.subtitle')}>
                <IconButton icon={HelpCircle} label="Hướng dẫn" onClick={() => setShowHelp(!showHelp)} />
                <IconButton icon={Upload} label="Nhập kịch bản JSON" onClick={importScript} />
                <IconButton icon={Download} label="Xuất kịch bản JSON" onClick={exportScript} />
                <PrimaryButton icon={FileText} onClick={() => setShowTemplates(true)}>
                    {t('scripts.templatesAvailable')}
                </PrimaryButton>
                <PrimaryButton variant="quiet" icon={Plus} onClick={createNewScript}>
                    {t('scripts.newScript')}
                </PrimaryButton>
                <PrimaryButton icon={Save} tone="emerald" onClick={saveScript}>
                    {t('common.save')}
                </PrimaryButton>
                <PrimaryButton icon={Play} tone="blue" onClick={handleRunClick} disabled={isRunning}>
                    {isRunning ? t('scripts.running') : t('scripts.run')}
                </PrimaryButton>
            </PageHeader>

            {/* Help Panel */}
            {showHelp && (
                <Panel tone="violet" className="p-5">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-base font-semibold text-[#24222c]">Hướng dẫn sử dụng</h3>
                        <IconButton icon={X} label="Close" onClick={() => setShowHelp(false)} />
                    </div>
                    <div className="grid grid-cols-4 gap-3 text-sm">
                        {[
                            { step: '1', title: 'Chọn mẫu', desc: 'Click "Mẫu có sẵn" hoặc "Tạo mới"', tone: 'blue' },
                            { step: '2', title: 'Thêm bước', desc: 'Chọn action từ panel bên phải', tone: 'emerald' },
                            { step: '3', title: 'Cấu hình', desc: 'Click action để mở rộng cấu hình', tone: 'amber' },
                            { step: '4', title: 'Chạy', desc: 'Nhấn "Chạy" và chọn tài khoản', tone: 'violet' },
                        ].map(item => (
                            <div key={item.step} className="bg-white rounded-[14px] border border-[#e9e4f2] p-3">
                                <h4 className={`font-semibold text-${item.tone === 'blue' ? 'blue' : item.tone === 'emerald' ? 'emerald' : item.tone === 'amber' ? 'amber' : '[#8d74e8]'}-600 mb-1`}>{item.step}. {item.title}</h4>
                                <p className="text-[#908a9e] text-xs">{item.desc}</p>
                            </div>
                        ))}
                    </div>
                </Panel>
            )}

            {/* Run Status */}
            {runStatus && (
                <AlertBanner
                    type={runStatus.progress === 100 ? 'success' : runStatus.message.includes('lỗi') || runStatus.message.includes('thất bại') ? 'error' : 'info'}
                    onDismiss={() => setRunStatus(null)}
                >
                    <p className="text-sm font-medium">{runStatus.message}</p>
                    <ProgressBar value={runStatus.progress} tone={runStatus.progress === 100 ? 'emerald' : 'blue'} className="mt-2" />
                </AlertBanner>
            )}

            {/* Main Layout: Script List + Editor + Action Panel */}
            <div className="grid grid-cols-12 gap-4" style={{ minHeight: 'calc(100vh - 280px)' }}>
                {/* Script List Sidebar */}
                {showScriptList && (
                    <div className="col-span-2 space-y-2">
                        <Panel tone="slate" className="p-3">
                            <div className="flex items-center justify-between mb-3">
                                <h3 className="text-sm font-bold text-[#24222c]">Kịch bản</h3>
                                <Badge tone="slate">{scripts.length}</Badge>
                            </div>
                            <div className="space-y-1 max-h-[calc(100vh-400px)] overflow-y-auto">
                                {scripts.map(script => (
                                    <div
                                        key={script.id}
                                        className={`group flex items-center gap-2 p-2 rounded-[12px] cursor-pointer transition-all text-sm ${currentScript?.id === script.id
                                            ? 'bg-[#f4f0ff] border border-[#e6e0fb] text-[#735bd6]'
                                            : 'hover:bg-[#f7f7f9] text-[#5f5a6d] border border-transparent'
                                            }`}
                                        onClick={() => setCurrentScript(script)}
                                    >
                                        <span className="flex-1 truncate text-xs font-medium">{script.name}</span>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(script.id) }}
                                            className="opacity-0 group-hover:opacity-100 p-0.5 text-[#908a9e] hover:text-rose-500 transition-all"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </Panel>
                    </div>
                )}

                {/* Center: Script Editor */}
                {currentScript && (
                    <div className={`${showScriptList ? 'col-span-7' : 'col-span-9'} space-y-3`}>
                        {/* Script Info + Settings */}
                        <Panel tone="slate" className="p-4">
                            <div className="flex items-start gap-3">
                                <div className="flex-1">
                                    <input
                                        type="text"
                                        value={currentScript.name}
                                        onChange={(e) => setCurrentScript({ ...currentScript, name: e.target.value })}
                                        className="w-full text-lg font-bold bg-transparent text-[#17171f] border-b border-transparent hover:border-[#e9e4f2] focus:border-[#8d74e8] focus:outline-none"
                                    />
                                    <input
                                        type="text"
                                        value={currentScript.description}
                                        onChange={(e) => setCurrentScript({ ...currentScript, description: e.target.value })}
                                        className="w-full text-sm mt-1 bg-transparent text-[#908a9e] border-b border-transparent hover:border-[#e9e4f2] focus:border-[#8d74e8] focus:outline-none"
                                        placeholder={t('scripts.descPlaceholder')}
                                    />
                                </div>
                                <div className="flex items-center gap-1">
                                    <IconButton icon={ChevronLeft} label={showScriptList ? 'Ẩn sidebar' : 'Hiện sidebar'} onClick={() => setShowScriptList(!showScriptList)} className={showScriptList ? '' : '[&>svg]:rotate-180'} />
                                    <IconButton icon={Settings} label="Cài đặt Script" onClick={() => setShowSettings(!showSettings)} className={showSettings ? '!bg-[#f4f0ff] !text-[#8d74e8]' : ''} />
                                    <IconButton icon={Hash} label="Quản lý biến" onClick={() => setShowVarManager(!showVarManager)} className={showVarManager ? '!bg-emerald-50 !text-emerald-600' : ''} />
                                </div>
                            </div>

                            {/* Settings Panel */}
                            {showSettings && (
                                <div className="mt-3 pt-3 border-t border-[#e9e4f2] grid grid-cols-3 gap-3">
                                    <div>
                                        <label className="block text-xs font-semibold text-[#6f697c] mb-1">Viewport Width</label>
                                        <input type="number" value={currentScript.settings.viewport.width}
                                            onChange={(e) => setCurrentScript({ ...currentScript, settings: { ...currentScript.settings, viewport: { ...currentScript.settings.viewport, width: parseInt(e.target.value) || 1366 } } })}
                                            className="w-full h-9 px-3 rounded-[12px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15" />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold text-[#6f697c] mb-1">Viewport Height</label>
                                        <input type="number" value={currentScript.settings.viewport.height}
                                            onChange={(e) => setCurrentScript({ ...currentScript, settings: { ...currentScript.settings, viewport: { ...currentScript.settings.viewport, height: parseInt(e.target.value) || 768 } } })}
                                            className="w-full h-9 px-3 rounded-[12px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15" />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold text-[#6f697c] mb-1">Timeout (ms)</label>
                                        <input type="number" value={currentScript.settings.defaultTimeout}
                                            onChange={(e) => setCurrentScript({ ...currentScript, settings: { ...currentScript.settings, defaultTimeout: parseInt(e.target.value) || 30000 } })}
                                            className="w-full h-9 px-3 rounded-[12px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15" />
                                    </div>
                                    <div className="col-span-3">
                                        <label className="flex items-center gap-2 text-sm text-[#5f5a6d] cursor-pointer font-medium">
                                            <input type="checkbox" checked={currentScript.settings.headless}
                                                onChange={(e) => setCurrentScript({ ...currentScript, settings: { ...currentScript.settings, headless: e.target.checked } })}
                                                className="h-4 w-4 rounded accent-[#8d74e8]" />
                                            Chạy ẩn (headless) - không hiện trình duyệt
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* Variable Manager */}
                            {showVarManager && (
                                <div className="mt-3 pt-3 border-t border-[#e9e4f2]">
                                    <div className="flex items-center justify-between mb-2">
                                        <h4 className="text-sm font-semibold text-[#24222c]">Biến tùy chỉnh</h4>
                                        <button onClick={addVariable} className="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700 font-semibold">
                                            <Plus className="w-3 h-3" /> Thêm biến
                                        </button>
                                    </div>
                                    {currentScript.variables.length === 0 ? (
                                        <p className="text-xs text-[#908a9e] py-2">Chưa có biến tùy chỉnh. Click "Thêm biến" để tạo.</p>
                                    ) : (
                                        <div className="space-y-2">
                                            {currentScript.variables.map((v, i) => (
                                                <div key={i} className="flex items-center gap-2 p-2 bg-[#f7f7f9] rounded-[12px] border border-[#e9e4f2]">
                                                    <input type="text" value={v.name} onChange={(e) => updateVariable(i, { name: e.target.value })}
                                                        className="w-28 px-2 py-1 bg-white border border-[#e9e4f2] rounded-lg text-xs text-emerald-600 font-mono focus:outline-none focus:ring-1 focus:ring-[#8d74e8]/20" placeholder="tên_biến" />
                                                    <select value={v.type} onChange={(e) => updateVariable(i, { type: e.target.value as any })}
                                                        className="px-2 py-1 bg-white border border-[#e9e4f2] rounded-lg text-xs text-[#17171f] focus:outline-none">
                                                        <option value="string">String</option><option value="number">Number</option><option value="boolean">Boolean</option>
                                                    </select>
                                                    <input type="text" value={v.defaultValue || ''} onChange={(e) => updateVariable(i, { defaultValue: e.target.value })}
                                                        className="flex-1 px-2 py-1 bg-white border border-[#e9e4f2] rounded-lg text-xs text-[#17171f] focus:outline-none focus:ring-1 focus:ring-[#8d74e8]/20" placeholder="Giá trị mặc định" />
                                                    <button onClick={() => deleteVariable(i)} className="p-1 text-[#908a9e] hover:text-rose-500"><Trash2 className="w-3 h-3" /></button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </Panel>

                        {/* Actions Header */}
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-[#908a9e] font-medium">{currentScript.actions.length} bước</span>
                            {currentScript.actions.length > 0 && (
                                <div className="flex items-center gap-1">
                                    <IconButton icon={ChevronsUp} label="Thu gọn tất cả" onClick={() => toggleAllActions(false)} />
                                    <IconButton icon={ChevronsDown} label="Mở rộng tất cả" onClick={() => toggleAllActions(true)} />
                                </div>
                            )}
                        </div>

                        {/* Action List */}
                        <div className="space-y-2">
                            {currentScript.actions.length === 0 ? (
                                <EmptyState
                                    icon={Zap}
                                    title={t('scripts.noStepsYet')}
                                    subtitle={t('scripts.addFromPanel')}
                                />
                            ) : (
                                currentScript.actions.map((action, index) => {
                                    const Icon = getActionIcon(action.type)
                                    return (
                                        <Panel
                                            key={action.id}
                                            tone="slate"
                                            className={`p-0 overflow-hidden transition-all ${action.enabled ? '' : 'opacity-50'}`}
                                        >
                                            <div
                                                draggable
                                                onDragStart={() => handleDragStart(action.id)}
                                                onDragOver={handleDragOver}
                                                onDrop={() => handleDrop(action.id)}
                                            >
                                                {/* Action Header */}
                                                <div
                                                    className="flex items-center gap-2 p-3 cursor-pointer hover:bg-[#f8f6fc] transition-colors"
                                                    onClick={() => updateAction(action.id, { expanded: !action.expanded })}
                                                >
                                                    <span className="text-[#cbbff3] cursor-grab active:cursor-grabbing" onMouseDown={(e) => e.stopPropagation()}>
                                                        <GripVertical className="w-4 h-4" />
                                                    </span>
                                                    <span className="text-[#908a9e] text-sm font-mono w-6">{index + 1}</span>
                                                    <div className={`p-1.5 rounded-lg border ${getActionColor(action.type)}`}>
                                                        <Icon className="w-4 h-4" />
                                                    </div>
                                                    <input
                                                        type="text"
                                                        value={action.name}
                                                        onChange={(e) => { e.stopPropagation(); updateAction(action.id, { name: e.target.value }) }}
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="flex-1 bg-transparent text-[#17171f] text-sm font-medium focus:outline-none"
                                                    />
                                                    <label className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                                        <input type="checkbox" checked={action.enabled} onChange={(e) => updateAction(action.id, { enabled: e.target.checked })} className="h-4 w-4 rounded accent-[#8d74e8]" />
                                                    </label>
                                                    <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                                                        <button onClick={() => moveAction(action.id, 'up')} className="p-1 text-[#908a9e] hover:text-[#5f5a6d]" disabled={index === 0}><MoveUp className="w-4 h-4" /></button>
                                                        <button onClick={() => moveAction(action.id, 'down')} className="p-1 text-[#908a9e] hover:text-[#5f5a6d]" disabled={index === currentScript.actions.length - 1}><MoveDown className="w-4 h-4" /></button>
                                                        <button onClick={() => deleteAction(action.id)} className="p-1 text-[#908a9e] hover:text-rose-500"><Trash2 className="w-4 h-4" /></button>
                                                        <button onClick={() => duplicateAction(action.id)} className="p-1 text-[#908a9e] hover:text-[#8d74e8]" title="Nhân bản"><Copy className="w-4 h-4" /></button>
                                                    </div>
                                                    {action.expanded ? <ChevronDown className="w-4 h-4 text-[#908a9e]" /> : <ChevronRight className="w-4 h-4 text-[#908a9e]" />}
                                                </div>

                                                {/* Action Params */}
                                                {action.expanded && (
                                                    <div className="px-4 pb-4 pt-2 bg-[#f8f6fc] border-t border-[#e9e4f2]" onClick={(e) => e.stopPropagation()}>
                                                        {renderActionParams(action)}
                                                    </div>
                                                )}
                                            </div>
                                        </Panel>
                                    )
                                })
                            )}
                        </div>
                    </div>
                )}

                {/* Right: Add Action Panel */}
                <div className="col-span-3 space-y-4 max-h-[calc(100vh-280px)] overflow-y-auto">
                    {/* Action Categories */}
                    <Panel tone="slate" className="p-4">
                        <h3 className="text-[#24222c] font-bold mb-3">{t('scripts.addActionTitle')}</h3>
                        <div className="space-y-4">
                            {ACTION_CATEGORIES.map((category) => (
                                <div key={category.name}>
                                    <h4 className="text-xs font-bold text-[#908a9e] uppercase tracking-wider mb-2">{category.emoji} {category.description}</h4>
                                    <div className="space-y-1">
                                        {category.actions.map((actionDef) => {
                                            const Icon = actionDef.icon
                                            return (
                                                <button
                                                    key={actionDef.type}
                                                    onClick={() => addAction(actionDef.type, actionDef)}
                                                    className={`w-full flex items-center gap-2 p-2 rounded-[12px] text-left text-sm hover:shadow-sm transition-all border ${getActionColor(actionDef.type)}`}
                                                    title={actionDef.description}
                                                >
                                                    <Icon className="w-4 h-4" />
                                                    <span className="flex-1 font-medium">{actionDef.label}</span>
                                                </button>
                                            )
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </Panel>

                    {/* Variables Info */}
                    <Panel tone="slate" className="p-4">
                        <h3 className="text-[#24222c] font-bold mb-3">{t('scripts.availableVars')}</h3>
                        <div className="space-y-2">
                            {AVAILABLE_VARIABLES.map((variable) => (
                                <div key={variable.name} className="p-2 bg-white rounded-[12px] border border-[#e9e4f2]">
                                    <code className="text-xs text-emerald-600 font-mono font-semibold">{variable.name}</code>
                                    <p className="text-xs text-[#908a9e] mt-1">{variable.description}</p>
                                </div>
                            ))}
                        </div>
                    </Panel>
                </div>
            </div>

            {/* Templates Modal */}
            <Modal open={showTemplates} onClose={() => setShowTemplates(false)} title={t('scripts.templatesAvailable')} size="lg">
                <div className="space-y-2 max-h-96 overflow-y-auto">
                    {SCRIPT_TEMPLATES.map(template => (
                        <div
                            key={template.id}
                            className="p-4 bg-[#f7f7f9] hover:bg-[#f4f0ff] border border-[#e9e4f2] rounded-[16px] cursor-pointer transition-colors"
                            onClick={() => loadTemplate(template)}
                        >
                            <h4 className="font-bold text-[#17171f]">{template.name}</h4>
                            <p className="text-sm text-[#908a9e] mt-1">{template.description}</p>
                            <Badge tone="slate" className="mt-2">{template.actions.length} {t('scripts.steps')}</Badge>
                        </div>
                    ))}
                </div>
            </Modal>

            {/* Run Modal - Account Picker */}
            <Modal open={showRunModal} onClose={() => setShowRunModal(false)} title="Chạy Script" description={currentScript?.name} size="md">
                {/* Option 1: Run without account */}
                <div className="mb-4">
                    <button
                        onClick={runScriptDirect}
                        className="w-full flex items-center gap-3 p-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-[16px] transition-colors"
                    >
                        <Play className="w-5 h-5 text-blue-600" />
                        <div className="text-left">
                            <div className="text-[#17171f] font-semibold">Chạy trực tiếp</div>
                            <div className="text-xs text-[#908a9e]">Không dùng tài khoản, chạy trình duyệt mới</div>
                        </div>
                    </button>
                </div>

                {/* Divider */}
                <div className="flex items-center gap-3 mb-4">
                    <div className="flex-1 h-px bg-[#e9e4f2]" />
                    <span className="text-xs text-[#908a9e]">hoặc chọn tài khoản</span>
                    <div className="flex-1 h-px bg-[#e9e4f2]" />
                </div>

                {/* Option 2: Run with accounts */}
                {systemAccounts.length === 0 ? (
                    <EmptyState
                        icon={Users}
                        title="Chưa có tài khoản nào"
                        subtitle="Thêm tài khoản trong mục Accounts"
                    />
                ) : (
                    <>
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-sm text-[#5f5a6d] font-medium">
                                <Users className="w-4 h-4 inline mr-1" />
                                {systemAccounts.length} tài khoản ({selectedAccountIds.length} đã chọn)
                            </span>
                            <div className="flex gap-2">
                                <button onClick={() => setSelectedAccountIds(systemAccounts.map(a => a.id))} className="text-xs text-[#8d74e8] hover:text-[#735bd6] font-semibold">Chọn tất cả</button>
                                <button onClick={() => setSelectedAccountIds([])} className="text-xs text-[#908a9e] hover:text-[#5f5a6d] font-semibold">Bỏ chọn</button>
                            </div>
                        </div>
                        <div className="max-h-60 overflow-y-auto space-y-1 mb-4 pr-1">
                            {systemAccounts.map((account) => (
                                <label
                                    key={account.id}
                                    className={`flex items-center gap-3 p-2.5 rounded-[12px] cursor-pointer transition-colors ${selectedAccountIds.includes(account.id)
                                        ? 'bg-emerald-50 border border-emerald-200'
                                        : 'bg-[#f7f7f9] border border-transparent hover:bg-[#f4f1fa]'
                                        }`}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedAccountIds.includes(account.id)}
                                        onChange={() => toggleAccountSelection(account.id)}
                                        className="h-4 w-4 rounded accent-[#8d74e8]"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm text-[#17171f] font-medium truncate">{account.email}</div>
                                        <div className="text-xs text-[#908a9e]">
                                            {account.status === 'active' ? 'Active' : 'Inactive'}
                                            {account.totalReviews > 0 && ` -- ${account.totalReviews} reviews`}
                                        </div>
                                    </div>
                                </label>
                            ))}
                        </div>
                        <PrimaryButton
                            className="w-full"
                            icon={Users}
                            tone="emerald"
                            onClick={runScriptWithAccounts}
                            disabled={selectedAccountIds.length === 0}
                        >
                            Chạy cho {selectedAccountIds.length} tài khoản
                        </PrimaryButton>
                    </>
                )}

                <button onClick={() => setShowRunModal(false)} className="w-full mt-3 p-2 text-sm text-[#908a9e] hover:text-[#5f5a6d] transition-colors font-medium">
                    Huỷ
                </button>
            </Modal>

            {/* Run Results */}
            {runResults && runResults.length > 0 && (
                <div className="fixed bottom-4 right-4 z-40">
                    <Panel tone="slate" className="p-4 max-w-sm shadow-[0_32px_70px_rgba(27,24,38,0.22)]">
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-bold text-[#24222c]">Kết quả chạy</h3>
                            <button onClick={() => setRunResults(null)} className="text-[#908a9e] hover:text-[#5f5a6d]"><X className="w-4 h-4" /></button>
                        </div>
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                            {runResults.map((r: any, i: number) => (
                                <div key={i} className={`text-xs p-2 rounded-[10px] font-medium ${r.success ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`}>
                                    {r.success ? 'OK' : 'FAIL'} {r.email}
                                </div>
                            ))}
                        </div>
                    </Panel>
                </div>
            )}
        </PageShell>
    )
}
