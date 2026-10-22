/**
 * Display kind and inline-image MIME allowlist by file extension, shared by the
 * viewer and the byte-serving route so they cannot disagree on what renders how.
 */

export type ArtifactKind = 'image' | 'html' | 'markdown' | 'text'

/** Extension → MIME for the image types we serve inline. This is an ALLOWLIST:
 *  the route serves an inline content-type only for these, everything else stays
 *  a download. SVG is included but is only ever rendered via <img> (never inline
 *  markup) and served with a sandbox CSP so a direct navigation can't script. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

export function ext(path: string): string {
  return (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
}

export function imageMime(path: string): string | null {
  return IMAGE_MIME[ext(path)] ?? null
}

export const isImagePath = (path: string): boolean => imageMime(path) !== null
export const isHtmlPath = (path: string): boolean => ext(path) === 'html' || ext(path) === 'htm'
export const isMarkdownPath = (path: string): boolean => ext(path) === 'md' || ext(path) === 'markdown'

export function artifactKind(path: string): ArtifactKind {
  if (isImagePath(path)) return 'image'
  if (isHtmlPath(path)) return 'html'
  if (isMarkdownPath(path)) return 'markdown'
  return 'text'
}
