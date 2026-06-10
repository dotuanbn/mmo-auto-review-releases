import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import en from './en.json'
import vi from './vi.json'

type Language = 'en' | 'vi'

type TranslationKeys = typeof en

interface I18nContextType {
    language: Language
    setLanguage: (lang: Language) => void
    t: (key: string, fallbackText?: string) => string
    translations: TranslationKeys
}

const translations = { en, vi }

const I18nContext = createContext<I18nContextType | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
    const [language, setLanguageState] = useState<Language>(() => {
        const saved = localStorage.getItem('language')
        return (saved as Language) || 'en'
    })

    const setLanguage = (lang: Language) => {
        setLanguageState(lang)
        localStorage.setItem('language', lang)
    }

    // Get nested translation by dot notation
    const t = (key: string, fallbackText?: string): string => {
        const keys = key.split('.')
        let value: any = translations[language]

        for (const k of keys) {
            if (value && typeof value === 'object' && k in value) {
                value = value[k]
            } else {
                // Try falling back to English
                let fallback: any = translations.en
                for (const fk of keys) {
                    if (fallback && typeof fallback === 'object' && fk in fallback) {
                        fallback = fallback[fk]
                    } else {
                        return fallbackText ?? key // Return fallback or key if not found
                    }
                }
                return typeof fallback === 'string' ? fallback : (fallbackText ?? key)
            }
        }

        return typeof value === 'string' ? value : (fallbackText ?? key)
    }

    useEffect(() => {
        document.documentElement.lang = language
    }, [language])

    return (
        <I18nContext.Provider value={{
            language,
            setLanguage,
            t,
            translations: translations[language] as TranslationKeys
        }}>
            {children}
        </I18nContext.Provider>
    )
}

export function useI18n() {
    const context = useContext(I18nContext)
    if (!context) {
        throw new Error('useI18n must be used within an I18nProvider')
    }
    return context
}

export function useTranslation() {
    const { t, language, setLanguage } = useI18n()
    return { t, language, setLanguage }
}
