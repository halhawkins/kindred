import { invoke, isTauri } from '@tauri-apps/api/core'
import type { IdeaSuggestionContext } from './ollama'

export const AI_PROVIDER_OPTIONS = [
  { id: 'ollama', label: 'Ollama (local)' },
  { id: 'openai', label: 'OpenAI (ChatGPT)' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'anthropic', label: 'Anthropic (Claude)' },
] as const

export type AiProvider = (typeof AI_PROVIDER_OPTIONS)[number]['id']
export type CloudAiProvider = Exclude<AiProvider, 'ollama'>

const PROVIDER_STORAGE_KEY = 'kindred-ai-provider'
const CLOUD_MODEL_STORAGE_PREFIX = 'kindred-cloud-ai-model-'

export const DEFAULT_CLOUD_MODELS: Record<CloudAiProvider, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-haiku-4-5',
}

export function getConfiguredAiProvider(): AiProvider {
  const provider = localStorage.getItem(PROVIDER_STORAGE_KEY)
  return AI_PROVIDER_OPTIONS.find((option) => option.id === provider)?.id ?? 'ollama'
}

export function saveConfiguredAiProvider(provider: AiProvider) {
  localStorage.setItem(PROVIDER_STORAGE_KEY, provider)
}

export function getConfiguredCloudModel(provider: CloudAiProvider) {
  return localStorage.getItem(`${CLOUD_MODEL_STORAGE_PREFIX}${provider}`) || DEFAULT_CLOUD_MODELS[provider]
}

export function saveConfiguredCloudModel(provider: CloudAiProvider, model: string) {
  const value = model.trim()
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(value)) {
    throw new Error('Enter a valid model ID for the selected provider.')
  }
  localStorage.setItem(`${CLOUD_MODEL_STORAGE_PREFIX}${provider}`, value)
  return value
}

function assertDesktopApp() {
  if (!isTauri()) throw new Error('Online AI is available in the Kindred desktop app.')
}

export function hasSavedCloudAiKey(provider: CloudAiProvider) {
  assertDesktopApp()
  return invoke<boolean>('cloud_ai_key_saved', { provider })
}

export function saveCloudAiKey(provider: CloudAiProvider, apiKey: string) {
  assertDesktopApp()
  return invoke('save_cloud_ai_key', { provider, apiKey })
}

export function removeCloudAiKey(provider: CloudAiProvider) {
  assertDesktopApp()
  return invoke('remove_cloud_ai_key', { provider })
}

export function suggestWithCloudAi(context: IdeaSuggestionContext, provider: CloudAiProvider, model: string) {
  assertDesktopApp()
  return invoke<string[]>('suggest_cloud_ideas', { context, provider, model })
}
