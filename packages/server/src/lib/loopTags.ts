import { MAX_LOOP_TAG_LENGTH, MAX_LOOP_TAGS, RESERVED_LOOP_TAGS } from '../types'

export type LoopTagsValidation =
  | { ok: true; value: string[] }
  | { ok: false; detail: string }

const reserved = new Set<string>(RESERVED_LOOP_TAGS)

export function normalizeLoopTag(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

export function validateLoopTags(value: unknown): LoopTagsValidation {
  if (value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) return { ok: false, detail: 'tags must be an array of strings' }
  if (value.length > MAX_LOOP_TAGS) return { ok: false, detail: `tags must contain at most ${MAX_LOOP_TAGS} values` }

  const tags: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false, detail: 'tags must contain only strings' }
    if (/\p{Cc}|\p{Cf}|\p{Default_Ignorable_Code_Point}/u.test(entry)) {
      return { ok: false, detail: 'tags must not contain control or invisible characters' }
    }
    const tag = normalizeLoopTag(entry)
    if (!tag) return { ok: false, detail: 'tags must not contain empty values' }
    if ([...tag].length > MAX_LOOP_TAG_LENGTH) {
      return { ok: false, detail: `each tag must contain at most ${MAX_LOOP_TAG_LENGTH} characters` }
    }
    if (reserved.has(tag)) return { ok: false, detail: `reserved tag: ${tag}` }
    if (seen.has(tag)) return { ok: false, detail: `duplicate tag: ${tag}` }
    seen.add(tag)
    tags.push(tag)
  }
  return { ok: true, value: [...tags].sort() }
}
