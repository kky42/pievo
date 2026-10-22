import DOMPurify, { type Config } from 'dompurify'
import { marked } from 'marked'

/**
 * marked (GFM) → DOMPurify with one allowlisted prose subset (no scripts or
 * handlers) for every loop-file markdown surface, so viewers cannot drift.
 */
const MD_SANITIZE: Config = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i',
    'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'span',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt'],
}

export function renderMarkdown(content: string): string {
  return DOMPurify.sanitize(marked.parse(content, { async: false, gfm: true }) as string, MD_SANITIZE)
}
