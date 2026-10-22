/** Download URL for one loop file. Each path segment is encoded independently so
 * the name continues to match the catch-all route. */
export function downloadHref(loopId: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  return `/api/artifact/${encodeURIComponent(loopId)}/${encodedPath}`
}

export function inlineHref(loopId: string, path: string): string {
  return `${downloadHref(loopId, path)}?view=inline`
}
