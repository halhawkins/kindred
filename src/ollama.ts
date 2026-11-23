import { invoke, isTauri } from '@tauri-apps/api/core'

const MODEL_STORAGE_KEY = 'kindred-local-ai-model'
const STATUS_CACHE_MS = 30_000

export const DEFAULT_LOCAL_MODEL = 'qwen2.5:3b'

export type IdeaContextNode = {
  text: string
  note: string
}

export type IdeaSuggestionContext = {
  selected: IdeaContextNode
  parent: IdeaContextNode | null
  children: IdeaContextNode[]
}

export type LocalLlmStatus = {
  ollamaAvailable: boolean
  modelAvailable: boolean
  model: string
  checkedAt: number
  cached: boolean
  error?: string
}

export interface LocalLlmProvider {
  checkAvailability(model: string, refresh?: boolean): Promise<LocalLlmStatus>
  downloadModel(model: string): Promise<void>
  suggest(context: IdeaSuggestionContext, model: string): Promise<string[]>
}

let statusCache: LocalLlmStatus | null = null

function assertDesktopApp() {
  if (!isTauri()) throw new Error('Local AI is available in the Kindred desktop app.')
}

function validateModelTag(model: string) {
  if (!/^[a-zA-Z0-9._:/-]{1,100}$/.test(model)) {
    throw new Error('Enter a valid Ollama model tag, such as qwen2.5:3b.')
  }
}

class OllamaProvider implements LocalLlmProvider {
  async checkAvailability(model: string, refresh = false): Promise<LocalLlmStatus> {
    assertDesktopApp()
    validateModelTag(model)

    const now = Date.now()
    if (!refresh && statusCache?.model === model && now - statusCache.checkedAt < STATUS_CACHE_MS) {
      return { ...statusCache, cached: true }
    }

    try {
      const models = await invoke<string[]>('ollama_models')
      statusCache = {
        ollamaAvailable: true,
        modelAvailable: models.includes(model),
        model,
        checkedAt: now,
        cached: false,
      }
    } catch (error) {
      statusCache = {
        ollamaAvailable: false,
        modelAvailable: false,
        model,
        checkedAt: now,
        cached: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    return statusCache
  }

  async downloadModel(model: string): Promise<void> {
    assertDesktopApp()
    validateModelTag(model)
    await invoke('download_ollama_model', { model })
    statusCache = null
  }

  async suggest(context: IdeaSuggestionContext, model: string): Promise<string[]> {
    assertDesktopApp()
    validateModelTag(model)
    return invoke<string[]>('suggest_ideas', { context, model })
  }
}

export const localLlmProvider: LocalLlmProvider = new OllamaProvider()

export function getConfiguredModel() {
  return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_LOCAL_MODEL
}

export function saveConfiguredModel(model: string) {
  validateModelTag(model)
  localStorage.setItem(MODEL_STORAGE_KEY, model)
  statusCache = null
}
