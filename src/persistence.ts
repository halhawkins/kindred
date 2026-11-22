import { invoke, isTauri } from '@tauri-apps/api/core'
import type { MindMapDocument } from './types'
import { parseMindMapDocument } from './data'

const STORAGE_KEY = 'kindred-mind-map'

export async function loadMap(): Promise<MindMapDocument | null> {
  if (isTauri()) {
    const document = await invoke<MindMapDocument | null>('load_map')
    return document
  }

  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return null
  return parseMindMapDocument(JSON.parse(stored))
}

export async function saveMap(document: MindMapDocument): Promise<void> {
  if (isTauri()) {
    await invoke('save_map', { document })
    return
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(document))
}
