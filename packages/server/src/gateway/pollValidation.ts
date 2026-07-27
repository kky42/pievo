import {
  POLL_INFO_TEXT_CAP,
  POLL_VERSION_CAP,
  validOptionalPollString,
} from './http.js'

export type PollCurrentRun = {
  runId: string
  stage: 'executing' | 'reporting'
}

export type PollInfo = {
  host?: string
  platform?: string
  arch?: string
  version?: string
}

export type PollV4Request = {
  protocolVersion?: number
  currentRuns?: PollCurrentRun[]
  daemonInstanceId?: string
  recoveryComplete?: boolean
  info?: PollInfo
}

export const POLL_INFO_FIELDS = new Set(['host', 'platform', 'arch', 'version'])
export const POLL_V4_REQUEST_FIELDS = new Set([
  'protocolVersion', 'currentRuns', 'daemonInstanceId', 'recoveryComplete', 'info',
])
export const POLL_HTTP_BODY_FIELDS = new Set([
  ...POLL_INFO_FIELDS,
  'protocolVersion', 'currentRuns', 'daemonInstanceId', 'recoveryComplete',
])

export const validPollWireId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length <= 200
  && value.trim().length > 0
  && !value.includes('\0')

export const validPollCurrentRun = (value: unknown): value is PollCurrentRun =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2
  && Object.prototype.hasOwnProperty.call(value, 'runId')
  && Object.prototype.hasOwnProperty.call(value, 'stage')
  && validPollWireId((value as { runId?: unknown }).runId)
  && ((value as { stage?: unknown }).stage === 'executing'
    || (value as { stage?: unknown }).stage === 'reporting')

export const validPollInfo = (value: unknown): value is PollInfo | undefined =>
  value === undefined || (
    value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => POLL_INFO_FIELDS.has(key))
    && validOptionalPollString((value as Record<string, unknown>).host, POLL_INFO_TEXT_CAP)
    && validOptionalPollString((value as Record<string, unknown>).platform, POLL_INFO_TEXT_CAP)
    && validOptionalPollString((value as Record<string, unknown>).arch, POLL_INFO_TEXT_CAP)
    && validOptionalPollString((value as Record<string, unknown>).version, POLL_VERSION_CAP)
  )
