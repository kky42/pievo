import { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'

/** Render a Markdown artifact through the shared sanitized GFM pipeline. */
export function MarkdownView({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content])
  return <div className="artifact-markdown px-5 py-4" dangerouslySetInnerHTML={{ __html: html }} />
}
