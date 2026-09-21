// react-syntax-highlighter v15 ships no TypeScript declarations. This
// declares only the slice Hyperion uses: PrismAsyncLight plus the prism
// language deep-imports registered in markdown.tsx.

declare module 'react-syntax-highlighter' {
  import type { ComponentType, CSSProperties, ReactNode } from 'react'

  export interface SyntaxHighlighterProps {
    language?: string
    style?: Record<string, CSSProperties>
    customStyle?: CSSProperties
    codeTagProps?: Record<string, unknown>
    PreTag?: string | ComponentType<Record<string, unknown>>
    CodeTag?: string | ComponentType<Record<string, unknown>>
    wrapLongLines?: boolean
    wrapLines?: boolean
    showLineNumbers?: boolean
    children?: ReactNode
    [key: string]: unknown
  }

  export const PrismAsyncLight: ComponentType<SyntaxHighlighterProps> & {
    registerLanguage: (name: string, language: unknown) => void
  }
  export const PrismLight: ComponentType<SyntaxHighlighterProps> & {
    registerLanguage: (name: string, language: unknown) => void
  }
  export const Prism: ComponentType<SyntaxHighlighterProps>
  export const PrismAsync: ComponentType<SyntaxHighlighterProps>
}

declare module 'react-syntax-highlighter/dist/esm/languages/prism/*' {
  const language: unknown
  export default language
}
