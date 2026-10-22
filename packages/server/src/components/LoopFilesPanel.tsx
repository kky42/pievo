import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArtifactSummary } from '../types'
import { fmt, humanBytes } from '../lib/format'
import { getArtifacts } from '../server/loopApi'
import { ArtifactBody, ViewerHead } from './artifactView'

export function LoopFilesPanel({ loopId, configuredPaths, running }: { loopId: string; configuredPaths: string[]; running?: boolean }) {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const list = await getArtifacts({ data: { loopId } })
      if (mine === seq.current) setArtifacts(list)
    } catch {
      if (mine === seq.current) setArtifacts((current) => current ?? [])
    }
  }, [loopId])

  useEffect(() => {
    setArtifacts(null)
    setSelected(null)
    void refresh()
  }, [loopId, refresh])

  useEffect(() => {
    const timer = setInterval(() => void refresh(), running ? 4_000 : 12_000)
    return () => clearInterval(timer)
  }, [running, refresh])

  const files = artifacts ?? []
  const activePath = selected && files.some((file) => file.path === selected) ? selected : files[0]?.path ?? null
  const active = files.find((file) => file.path === activePath) ?? null

  return (
    <section id="files" className="min-w-0">
      <div className="mb-2.5 flex items-end justify-between gap-3 border-b border-hairline pb-1.5">
        <h2 className="text-label font-semibold text-secondary">Files{artifacts ? ` (${files.length})` : ''}</h2>
        <span className="text-caption font-medium text-disabled">MEMORY.md + {configuredPaths.length} artifact{configuredPaths.length === 1 ? '' : 's'}</span>
      </div>

      {files.length === 0 ? (
        <div className="rounded-card border border-hairline bg-surface px-5 py-10 text-center text-body text-disabled shadow-card">
          {artifacts == null ? 'Loading…' : 'No files are available for this loop.'}
        </div>
      ) : (
        <div className="grid h-[min(600px,68vh)] grid-cols-1 overflow-hidden rounded-card border border-hairline bg-surface shadow-card sm:grid-cols-[210px_1fr]">
          <nav className="max-h-44 overflow-y-auto border-b border-hairline sm:max-h-none sm:border-b-0 sm:border-r">
            <ul className="py-1.5">
              {files.map((file) => {
                const activeRow = file.path === activePath
                return (
                  <li key={file.path}>
                    <button type="button" onClick={() => setSelected(file.path)} className={`flex w-full items-center border-l-2 px-3 py-2 text-left transition-colors ${activeRow ? 'border-display bg-raised' : 'border-transparent hover:bg-raised/60'}`}>
                      <span className={`block min-w-0 flex-1 truncate font-mono text-label ${activeRow ? 'text-display' : 'text-primary'}`} title={file.path}>{file.path}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>
          <div className="min-w-0 overflow-y-auto">
            {active && (
              <>
                <ViewerHead path={active.path} meta={[active.size != null ? humanBytes(active.size) : '', `updated ${fmt(active.updatedAt)}`].filter(Boolean).join(' · ')} />
                <ArtifactBody loopId={loopId} file={active} />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
