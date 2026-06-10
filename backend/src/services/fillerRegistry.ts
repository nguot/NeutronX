export interface FillerEntry { name: string; url: string }

let seeded = false
const entries: FillerEntry[] = []

function seed() {
  if (seeded) return
  seeded = true
  if (process.env.WHALE_FILLER_QUOTE_URL) entries.push({ name: 'WhaleFiller', url: process.env.WHALE_FILLER_QUOTE_URL })
  if (process.env.COW_FILLER_QUOTE_URL)   entries.push({ name: 'CoWFiller',   url: process.env.COW_FILLER_QUOTE_URL })
}

export const fillerRegistry = {
  list(): FillerEntry[] {
    seed()
    return [...entries]
  },
  add(name: string, url: string) {
    seed()
    if (entries.find(f => f.name === name)) throw new Error('filler already exists')
    entries.push({ name, url })
  },
  remove(name: string) {
    seed()
    const idx = entries.findIndex(f => f.name === name)
    if (idx === -1) throw new Error('filler not found')
    entries.splice(idx, 1)
  },
}
