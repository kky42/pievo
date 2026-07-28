/** Download URL for one artifact. Each path segment is encoded independently so
 * nested artifact paths continue to match the catch-all route. */
export function downloadHref(loopId: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  return `/api/artifact/${encodeURIComponent(loopId)}/${encodedPath}`
}

export function inlineHref(loopId: string, path: string): string {
  return `${downloadHref(loopId, path)}?view=inline`
}
