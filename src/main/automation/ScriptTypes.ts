/**
 * Automation Script Types
 * Cho phép người dùng tự định nghĩa kịch bản automation
 */

// Các loại action có thể thực hiện
export type ScriptActionType =
    | 'navigate'        // Điều hướng đến URL
    | 'click'           // Click element
    | 'type'            // Nhập text
    | 'wait'            // Chờ (thời gian hoặc element)
    | 'scroll'          // Scroll trang
    | 'screenshot'      // Chụp ảnh
    | 'keyboard'        // Nhấn phím (Enter, Tab, etc.)
    | 'select'          // Chọn option từ dropdown
    | 'hover'           // Di chuột qua element
    | 'upload'          // Upload file
    | 'extract'         // Trích xuất text từ element
    | 'condition'       // Điều kiện if/else
    | 'loop'            // Lặp lại các bước
    | 'variable'        // Đặt biến
    | 'random_delay'    // Delay ngẫu nhiên
    | 'human_type'      // Gõ như người thật (delay giữa các ký tự)
    | 'random_scroll'   // Scroll ngẫu nhiên
    | 'google_search'   // Tìm kiếm Google
    | 'maps_click'      // Click vào kết quả Maps
    | 'write_review'    // Viết review
    | 'set_rating'      // Đặt rating (sao)
    | 'go_back'         // Quay lại trang trước
    | 'refresh_page'    // Tải lại trang

// Cấu hình cho mỗi action
export interface ScriptAction {
    id: string
    type: ScriptActionType
    name: string  // Tên hiển thị
    description?: string
    enabled: boolean

    // Params tùy theo type
    params: ScriptActionParams

    // Điều kiện chạy action này
    condition?: {
        variable: string
        operator: 'equals' | 'not_equals' | 'contains' | 'exists'
        value: string
    }

    // Xử lý lỗi
    onError?: 'stop' | 'continue' | 'retry'
    maxRetries?: number
}

export interface ScriptActionParams {
    // navigate
    url?: string

    // click, type, hover, extract
    selector?: string
    selectorType?: 'css' | 'xpath' | 'text' | 'placeholder' | 'label'

    // type
    text?: string
    clearFirst?: boolean

    // human_type
    minDelay?: number  // ms giữa các ký tự
    maxDelay?: number

    // wait
    waitType?: 'time' | 'element' | 'navigation'
    waitTime?: number  // ms
    waitSelector?: string
    timeout?: number

    // scroll
    scrollDirection?: 'up' | 'down' | 'left' | 'right'
    scrollAmount?: number  // pixels
    scrollToElement?: string  // selector

    // random_scroll
    minScrolls?: number
    maxScrolls?: number

    // random_delay
    minDelayMs?: number
    maxDelayMs?: number

    // keyboard
    key?: string  // 'Enter', 'Tab', 'Escape', etc.
    modifiers?: ('Shift' | 'Control' | 'Alt')[]

    // screenshot
    screenshotName?: string
    fullPage?: boolean

    // upload
    filePath?: string
    inputSelector?: string

    // select
    selectValue?: string
    selectByText?: boolean

    // variable
    variableName?: string
    variableValue?: string
    extractFrom?: string  // selector to extract text from

    // google_search
    searchQuery?: string  // hỗ trợ biến như {{location_name}}

    // write_review
    reviewText?: string  // hỗ trợ spintax và biến

    // set_rating
    rating?: number  // 1-5

    // loop
    loopCount?: number
    loopActions?: ScriptAction[]

    // condition
    thenActions?: ScriptAction[]
    elseActions?: ScriptAction[]
}

// Template script - kịch bản mẫu đã được định nghĩa sẵn
export interface AutomationScript {
    id: string
    name: string
    description: string
    version: string
    createdAt: Date
    updatedAt: Date

    // Các biến có thể truyền vào script
    variables: ScriptVariable[]

    // Các bước thực hiện
    actions: ScriptAction[]

    // Cấu hình chung
    settings: {
        headless: boolean
        defaultTimeout: number
        viewport: { width: number; height: number }
        userAgent?: string
        locale?: string
        timezone?: string
    }
}

export interface ScriptVariable {
    name: string
    type: 'string' | 'number' | 'boolean' | 'list'
    defaultValue?: string
    description?: string
    required?: boolean
}

// Kết quả thực thi
export interface ScriptExecutionResult {
    success: boolean
    startTime: Date
    endTime: Date
    totalActions: number
    completedActions: number
    failedActions: number
    errors: ScriptError[]
    variables: Record<string, any>
    screenshots: string[]
}

export interface ScriptError {
    actionId: string
    actionName: string
    error: string
    timestamp: Date
}

// Tạo script mẫu cho Google Maps Review
export function createDefaultReviewScript(): AutomationScript {
    return {
        id: 'default-review-script',
        name: 'Google Maps Review Script',
        description: 'Kịch bản tự động review Google Maps chuẩn',
        version: '1.0.0',
        createdAt: new Date(),
        updatedAt: new Date(),

        variables: [
            { name: 'location_name', type: 'string', required: true, description: 'Tên địa điểm' },
            { name: 'review_text', type: 'string', required: true, description: 'Nội dung review' },
            { name: 'rating', type: 'number', defaultValue: '5', description: 'Số sao (1-5)' },
        ],

        actions: [
            {
                id: 'step-1',
                type: 'navigate',
                name: 'Mở Google',
                enabled: true,
                params: { url: 'https://www.google.com' }
            },
            {
                id: 'step-2',
                type: 'random_delay',
                name: 'Chờ ngẫu nhiên',
                enabled: true,
                params: { minDelayMs: 1000, maxDelayMs: 3000 }
            },
            {
                id: 'step-3',
                type: 'google_search',
                name: 'Tìm kiếm địa điểm',
                enabled: true,
                params: { searchQuery: '{{location_name}}' }
            },
            {
                id: 'step-4',
                type: 'random_delay',
                name: 'Chờ kết quả',
                enabled: true,
                params: { minDelayMs: 2000, maxDelayMs: 4000 }
            },
            {
                id: 'step-5',
                type: 'random_scroll',
                name: 'Scroll ngẫu nhiên',
                enabled: true,
                params: { minScrolls: 1, maxScrolls: 3 }
            },
            {
                id: 'step-6',
                type: 'maps_click',
                name: 'Click vào Maps',
                enabled: true,
                params: {}
            },
            {
                id: 'step-7',
                type: 'wait',
                name: 'Chờ Maps load',
                enabled: true,
                params: { waitType: 'time', waitTime: 3000 }
            },
            {
                id: 'step-8',
                type: 'click',
                name: 'Click nút Write Review',
                enabled: true,
                params: {
                    selector: 'button:has-text("Viết đánh giá"), button:has-text("Write a review")',
                    selectorType: 'css'
                }
            },
            {
                id: 'step-9',
                type: 'set_rating',
                name: 'Đặt số sao',
                enabled: true,
                params: { rating: 5 }
            },
            {
                id: 'step-10',
                type: 'human_type',
                name: 'Nhập review',
                enabled: true,
                params: {
                    selector: 'textarea[aria-label*="review"], textarea[placeholder*="review"]',
                    text: '{{review_text}}',
                    minDelay: 50,
                    maxDelay: 150
                }
            },
            {
                id: 'step-11',
                type: 'random_delay',
                name: 'Chờ trước khi đăng',
                enabled: true,
                params: { minDelayMs: 1000, maxDelayMs: 2000 }
            },
            {
                id: 'step-12',
                type: 'screenshot',
                name: 'Chụp ảnh kết quả',
                enabled: true,
                params: { screenshotName: 'review-{{location_name}}', fullPage: false }
            },
        ],

        settings: {
            headless: true,
            defaultTimeout: 30000,
            viewport: { width: 1366, height: 768 },
            locale: 'vi-VN',
            timezone: 'Asia/Ho_Chi_Minh'
        }
    }
}

// Các script mẫu
export const SCRIPT_TEMPLATES: Partial<AutomationScript>[] = [
    {
        name: 'Warm-up Script',
        description: 'Làm nóng trình duyệt trước khi review',
        actions: [
            { id: '1', type: 'navigate', name: 'Mở Google', enabled: true, params: { url: 'https://www.google.com' } },
            { id: '2', type: 'random_delay', name: 'Chờ', enabled: true, params: { minDelayMs: 2000, maxDelayMs: 5000 } },
            { id: '3', type: 'google_search', name: 'Tìm kiếm ngẫu nhiên', enabled: true, params: { searchQuery: 'tin tức hôm nay' } },
            { id: '4', type: 'random_scroll', name: 'Scroll trang', enabled: true, params: { minScrolls: 3, maxScrolls: 7 } },
            { id: '5', type: 'random_delay', name: 'Đọc tin', enabled: true, params: { minDelayMs: 5000, maxDelayMs: 15000 } },
        ]
    },
    {
        name: 'Simple Review Script',
        description: 'Kịch bản review đơn giản nhất',
        actions: [
            { id: '1', type: 'navigate', name: 'Mở Maps', enabled: true, params: { url: '{{location_url}}' } },
            { id: '2', type: 'wait', name: 'Chờ load', enabled: true, params: { waitType: 'time', waitTime: 3000 } },
            { id: '3', type: 'click', name: 'Click Review', enabled: true, params: { selector: 'button:has-text("Write")' } },
            { id: '4', type: 'set_rating', name: 'Rating', enabled: true, params: { rating: 5 } },
            { id: '5', type: 'human_type', name: 'Viết review', enabled: true, params: { text: '{{review_text}}' } },
            { id: '6', type: 'screenshot', name: 'Chụp ảnh', enabled: true, params: { screenshotName: 'result' } },
        ]
    }
]
