import { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'

export function MarkdownView({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content])
  return <div className="artifact-markdown px-5 py-4" dangerouslySetInnerHTML={{ __html: html }} />
}
