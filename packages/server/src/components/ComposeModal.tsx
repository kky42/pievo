import { useEffect, useState } from 'react'
import { getConfig, mintClaim } from '../server/loopApi'
import { daemonConnectCommand } from '../lib/daemonCommands'
import { Modal, ModalHead } from './Modal'
import { btnSm } from './ui'

export function ComposeModal({
  open,
  onClose,
  teamId,
}: {
  open: boolean
  onClose: () => void
  teamId?: string
}) {
  const [token, setToken] = useState<string | null>(null)
  const [config, setConfig] = useState<{ pievoCli: string; customCli: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configError, setConfigError] = useState(false)

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const command = token && config
    ? daemonConnectCommand(origin, token, config.pievoCli, config.customCli)
    : ''

  useEffect(() => {
    if (!open) return
    setToken(null)
    setConfig(null)
    setCopied(false)
    setError(null)
    setConfigError(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    let active = true
    void getConfig()
      .then((value) => { if (active) setConfig(value) })
      .catch(() => { if (active) setConfigError(true) })
    void mintClaim({ data: teamId })
      .then((result) => {
        if (!active) return
        if ('token' in result) setToken(result.token)
        else setError(result.error)
      })
      .catch(() => { if (active) setError('could not mint a connect key') })
    return () => { active = false }
  }, [open, teamId])

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('could not copy - select the command and copy manually')
    }
  }

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHead title="New loop" />

      <div className="mt-6">
        <Step number="1" continued title="Install and connect the daemon">
          <p className="mt-1.5 text-body leading-snug text-secondary">
            Paste this command into the foreground coding-agent session where the loop should run.
          </p>
          <div className="mt-3 flex min-w-0 items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-control bg-display p-4 font-mono text-label leading-relaxed text-paper">
              {command || (configError
                ? 'Could not load the connection command. Close and try again.'
                : token
                  ? 'Loading CLI configuration…'
                  : 'Minting a connect key…')}
            </pre>
            <button className={btnSm} onClick={() => void copyCommand()} disabled={!command}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
        </Step>

        <Step number="2" title="Create the loop">
          <p className="mt-1.5 text-body leading-snug text-secondary">
            Then, in the same session, say:
          </p>
          <div className="mt-3 rounded-control border border-hairline bg-raised p-4 text-body font-medium text-display">
            Create a Pievo loop.
          </div>
        </Step>
      </div>

      {error && <div className="mt-4 text-body text-accent">Error: {error}</div>}
    </Modal>
  )
}

function Step({
  number,
  title,
  continued = false,
  children,
}: {
  number: string
  title: string
  continued?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3.5">
      <div className="flex flex-col items-center">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-display text-micro font-medium leading-none text-display">
          {number}
        </span>
        {continued && <span className="mt-1 w-px flex-1 bg-hairline" />}
      </div>
      <div className={continued ? 'min-w-0 flex-1 pb-7' : 'min-w-0 flex-1'}>
        <h3 className="text-label font-semibold text-display">{title}</h3>
        {children}
      </div>
    </div>
  )
}
