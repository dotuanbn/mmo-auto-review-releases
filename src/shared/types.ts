// Shared types between main and renderer processes

// Account types
export interface Account {
    id: number
    email: string
    password: string
    recoveryEmail?: string
    recoveryPhone?: string
    loginType: 'auto' | 'manual'
    cookies?: string
    profilePath?: string
    status: 'active' | 'banned' | 'pending' | 'suspended' | 'checking'
    lastUsed?: Date
    totalReviews: number
    createdAt: Date
}

export interface AccountCreate {
    email: string
    password: string
    recoveryEmail?: string
    recoveryPhone?: string
}

// Proxy types
export interface Proxy {
    id: number
    host: string
    port: number
    username?: string
    password?: string
    type: 'http' | 'https' | 'socks5'
    country?: string
    status: 'active' | 'dead' | 'checking'
    lastCheck?: Date
    responseTime?: number
}

export interface ProxyCreate {
    host: string
    port: number
    username?: string
    password?: string
    type: 'http' | 'https' | 'socks5'
    country?: string
}

// Location types
export interface Location {
    id: number
    name: string
    placeId?: string
    address?: string
    phone?: string
    website?: string
    url: string
    category?: string
    targetRating: number
    targetReviews: number
    currentReviews: number
    status: 'pending' | 'in_progress' | 'done'
    // Strong identifiers persisted from URL for deterministic target verification
    cid?: string
    featureHex?: string
}

export interface LocationCreate {
    name: string
    url: string
    placeId?: string
    address?: string
    phone?: string
    website?: string
    category?: string
    targetRating?: number
    targetReviews?: number
    cid?: string
    featureHex?: string
}

// Campaign types
export interface Campaign {
    id: number
    name: string
    locationIds: number[]
    accountIds: number[]
    proxyIds: number[]
    reviewTemplates: string[]
    rating: number
    delayMin: number
    delayMax: number
    maxReviewsPerAccountPerDay: number
    workingHoursStart: string
    workingHoursEnd: string
    status: 'pending' | 'running' | 'paused' | 'done' | 'error'
    createdAt: Date
    progress: number
    totalReviews: number
    successReviews: number
    failedReviews: number
}

export interface CampaignCreate {
    name: string
    locationIds: number[]
    accountIds?: number[]
    proxyIds?: number[]
    reviewTemplates: string[]
    rating: number
    delayMin?: number
    delayMax?: number
    maxReviewsPerAccountPerDay?: number
    workingHoursStart?: string
    workingHoursEnd?: string
}

// Review history types
export interface ReviewHistory {
    id: number
    campaignId: number
    accountId: number
    locationId: number
    proxyId?: number
    rating: number
    reviewText: string
    status: 'success' | 'failed'
    errorMessage?: string
    screenshot?: string
    createdAt: Date
}

// Statistics types
export interface ReviewStats {
    totalReviews: number
    successfulReviews: number
    failedReviews: number
    successRate: number
    reviewsToday: number
    reviewsThisWeek: number
    reviewsThisMonth: number
    activeCampaigns: number
    activeAccounts: number
    activeProxies: number
}

// Settings types
export interface AppSettings {
    headless: boolean
    defaultDelay: { min: number; max: number }
    profilesPath: string
    screenshotsPath: string
    autoStartCampaign: boolean
    notificationsEnabled: boolean
    theme: 'light' | 'dark' | 'system'
}

// IPC Event types
export interface ReviewProgressEvent {
    campaignId: number
    accountId: number
    locationId: number
    status: 'started' | 'writing' | 'submitted' | 'success' | 'failed'
    message: string
    progress: number
}

export interface CampaignUpdateEvent {
    campaignId: number
    status: Campaign['status']
    progress: number
    message: string
}

// Electron API exposed to renderer
export interface ElectronAPI {
    getVersion: () => Promise<string>

    // Accounts
    getAccounts: () => Promise<Account[]>
    addAccount: (data: AccountCreate) => Promise<Account>
    updateAccount: (id: number, data: Partial<Account>) => Promise<Account>
    deleteAccount: (id: number) => Promise<void>
    testAccountLogin: (id: number) => Promise<{ success: boolean; message: string }>

    // Proxies
    getProxies: () => Promise<Proxy[]>
    addProxy: (data: ProxyCreate) => Promise<Proxy>
    updateProxy: (id: number, data: Partial<Proxy>) => Promise<Proxy>
    deleteProxy: (id: number) => Promise<void>
    checkProxy: (id: number) => Promise<{ alive: boolean; responseTime: number }>
    checkAllProxies: () => Promise<void>

    // Locations
    getLocations: () => Promise<Location[]>
    addLocation: (data: LocationCreate) => Promise<Location>
    updateLocation: (id: number, data: Partial<Location>) => Promise<Location>
    deleteLocation: (id: number) => Promise<void>
    addFromUrl: (url: string, targetReviews?: number, phone?: string, website?: string) => Promise<Location>
    parseGoogleMapsUrl: (url: string) => Promise<{ name: string; placeId?: string; address?: string; cid?: string; featureHex?: string }>

    // Campaigns
    getCampaigns: () => Promise<Campaign[]>
    createCampaign: (data: CampaignCreate) => Promise<Campaign>
    updateCampaign: (id: number, data: Partial<Campaign>) => Promise<Campaign>
    deleteCampaign: (id: number) => Promise<void>
    startCampaign: (id: number) => Promise<void>
    pauseCampaign: (id: number) => Promise<void>
    stopCampaign: (id: number) => Promise<void>

    // Reviews
    getReviewHistory: (filters?: Partial<ReviewHistory>) => Promise<ReviewHistory[]>
    getReviewStats: () => Promise<ReviewStats>

    // Settings
    getSettings: () => Promise<AppSettings>
    updateSettings: (data: Partial<AppSettings>) => Promise<AppSettings>

    // Event listeners
    onReviewProgress: (callback: (data: ReviewProgressEvent) => void) => () => void
    onCampaignUpdate: (callback: (data: CampaignUpdateEvent) => void) => () => void
    onAccountUpdate: (callback: (data: Account) => void) => () => void
}

// Window typing is declared in src/preload/index.ts to avoid duplicate global declarations.
