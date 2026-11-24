import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CircleAlert,
  ChevronDown,
  CircleHelp,
  Command,
  Download,
  FilePlus2,
  Focus,
  ImagePlus,
  Lightbulb,
  LoaderCircle,
  Minus,
  Palette,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { isTauri } from '@tauri-apps/api/core'
import {
  AI_PROVIDER_OPTIONS,
  DEFAULT_CLOUD_MODELS,
  getConfiguredAiProvider,
  getConfiguredCloudModel,
  hasSavedCloudAiKey,
  removeCloudAiKey,
  saveCloudAiKey,
  saveConfiguredAiProvider,
  saveConfiguredCloudModel,
  suggestWithCloudAi,
} from './cloudAi'
import type { AiProvider, CloudAiProvider } from './cloudAi'
import { BOARD_THEMES, DEFAULT_MAP, NODE_COLORS, parseMindMapDocument } from './data'
import {
  DEFAULT_LOCAL_MODEL,
  getConfiguredModel,
  localLlmProvider,
  saveConfiguredModel,
} from './ollama'
import type { IdeaSuggestionContext, LocalLlmStatus } from './ollama'
import { loadMap, saveMap } from './persistence'
import type { MindMapDocument, MindMapImage, MindMapNode } from './types'

const VIEW_WIDTH = 1400
const VIEW_HEIGHT = 860
const ROOT_WIDTH = 224
const NODE_WIDTH = 178
const NODE_HEIGHT = 62
const MAX_IMAGE_FILE_SIZE = 15 * 1024 * 1024
const MAX_IMAGE_DATA_SIZE = 2_000_000

type DragTarget =
  | { type: 'node' | 'image'; id: string; offsetX: number; offsetY: number }
  | { type: 'reparent'; id: string; parentId: string; branchIds: Set<string> }

function nodeWidth(node: MindMapNode) {
  return node.parentId === null ? ROOT_WIDTH : NODE_WIDTH
}

function itemWidth(item: MindMapNode | MindMapImage) {
  return 'dataUrl' in item ? item.width : nodeWidth(item)
}

function itemLabel(item: MindMapNode | MindMapImage) {
  return 'text' in item ? item.text : item.name
}

function getBranchIds(id: string, childrenByParent: ReadonlyMap<string, (MindMapNode | MindMapImage)[]>) {
  const branchIds = new Set<string>()
  const pending = [id]
  while (pending.length) {
    const currentId = pending.pop()!
    if (branchIds.has(currentId)) continue
    branchIds.add(currentId)
    for (const child of childrenByParent.get(currentId) ?? []) pending.push(child.id)
  }
  return branchIds
}

function wrapText(text: string, limit: number) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && `${line} ${word}`.length > limit) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, 2)
}

function pointerToCanvas(svg: SVGSVGElement, clientX: number, clientY: number) {
  const point = svg.createSVGPoint()
  point.x = clientX
  point.y = clientY
  const matrix = svg.getScreenCTM()
  if (!matrix) return { x: 0, y: 0 }
  return point.matrixTransform(matrix.inverse())
}

function pointerToMap(svg: SVGSVGElement, clientX: number, clientY: number, zoom: number, pan: { x: number; y: number }) {
  const position = pointerToCanvas(svg, clientX, clientY)
  return {
    x: (position.x - VIEW_WIDTH * (1 - zoom) / 2 - pan.x) / zoom,
    y: (position.y - VIEW_HEIGHT * (1 - zoom) / 2 - pan.y) / zoom,
  }
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read the image.'))
    reader.onerror = () => reject(new Error('Could not read the image.'))
    reader.readAsDataURL(blob)
  })
}

async function prepareImage(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.')
  if (file.size > MAX_IMAGE_FILE_SIZE) throw new Error('Images must be smaller than 15 MB.')

  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = window.document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Your browser could not prepare this image.')
    context.drawImage(bitmap, 0, 0, width, height)

    let blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82))
    if (!blob) blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))
    if (!blob) throw new Error('Your browser could not prepare this image.')
    if (blob.size > 1_500_000) throw new Error('This image is too detailed to save locally. Try a smaller image.')

    const dataUrl = await readAsDataUrl(blob)
    if (dataUrl.length > MAX_IMAGE_DATA_SIZE) throw new Error('This image is too large to save with the map.')
    const displayScale = Math.min(260 / width, 180 / height)
    return {
      dataUrl,
      width: Math.round(width * displayScale),
      height: Math.round(height * displayScale),
    }
  } finally {
    bitmap.close()
  }
}

function App() {
  const [document, setDocument] = useState<MindMapDocument>(DEFAULT_MAP)
  const [selectedId, setSelectedId] = useState('root')
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [saveState, setSaveState] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading')
  const [notice, setNotice] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [canSave, setCanSave] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [reparentingId, setReparentingId] = useState<string | null>(null)
  const [reparentTargetId, setReparentTargetId] = useState<string | null>(null)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestionForNodeId, setSuggestionForNodeId] = useState<string | null>(null)
  const [suggestionsReady, setSuggestionsReady] = useState(false)
  const [suggestionError, setSuggestionError] = useState('')
  const [isSuggesting, setIsSuggesting] = useState(false)
  const [aiProvider, setAiProvider] = useState<AiProvider>(getConfiguredAiProvider)
  const [aiProviderDraft, setAiProviderDraft] = useState<AiProvider>(aiProvider)
  const [aiModel, setAiModel] = useState(getConfiguredModel)
  const [aiModelDraft, setAiModelDraft] = useState(() => aiProvider === 'ollama' ? aiModel : getConfiguredCloudModel(aiProvider))
  const [cloudKeyDraft, setCloudKeyDraft] = useState('')
  const [cloudKeySaved, setCloudKeySaved] = useState<boolean | null>(null)
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false)
  const [isSavingAiSettings, setIsSavingAiSettings] = useState(false)
  const [aiStatus, setAiStatus] = useState<LocalLlmStatus | null>(null)
  const [aiStatusBusy, setAiStatusBusy] = useState(false)
  const [aiDownloadBusy, setAiDownloadBusy] = useState(false)
  const [aiSettingsError, setAiSettingsError] = useState('')
  const importRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const canvasSvgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<DragTarget | null>(null)
  const panRef = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number } | null>(null)
  const rootNode = document.nodes.find((node) => node.parentId === null) ?? document.nodes[0]
  const selectedNode = document.nodes.find((node) => node.id === selectedId) ?? rootNode
  const selectedImage = (document.images ?? []).find((image) => image.id === selectedImageId)
  const activeTheme = BOARD_THEMES.find((theme) => theme.id === document.theme) ?? BOARD_THEMES[0]
  const graphItems = useMemo(() => [...document.nodes, ...document.images], [document.nodes, document.images])
  const graphItemsById = useMemo(() => new Map(graphItems.map((item) => [item.id, item])), [graphItems])
  const selectedImageParent = selectedImage ? graphItemsById.get(selectedImage.parentId) : undefined
  const selectedNodeParent = selectedNode?.parentId ? graphItemsById.get(selectedNode.parentId) : undefined

  useEffect(() => {
    let active = true
    loadMap()
      .then((saved) => {
        if (!active) return
        if (saved) {
          setDocument(saved)
          setSelectedId(saved.nodes.find((node) => node.parentId === null)?.id ?? saved.nodes[0].id)
        }
        setCanSave(true)
        setSaveState('saved')
      })
      .catch((error: unknown) => {
        if (!active) return
        setSaveState('error')
        setNotice(`Couldn't load your saved map: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!loaded || !canSave) return
    setSaveState('saving')
    const timeout = window.setTimeout(() => {
      saveMap(document)
        .then(() => setSaveState('saved'))
        .catch((error: unknown) => {
          setSaveState('error')
          setNotice(`Couldn't save your map: ${error instanceof Error ? error.message : String(error)}`)
        })
    }, 450)
    return () => window.clearTimeout(timeout)
  }, [canSave, document, loaded])

  const childrenByParent = useMemo(() => {
    const children = new Map<string, (MindMapNode | MindMapImage)[]>()
    for (const item of graphItems) {
      if (!item.parentId) continue
      const current = children.get(item.parentId) ?? []
      current.push(item)
      children.set(item.parentId, current)
    }
    return children
  }, [graphItems])

  const updateNode = useCallback((id: string, update: Partial<MindMapNode>) => {
    setCanSave(true)
    setDocument((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === id ? { ...node, ...update } : node),
    }))
  }, [])

  const updateImage = useCallback((id: string, update: Partial<MindMapImage>) => {
    setCanSave(true)
    setDocument((current) => ({
      ...current,
      images: current.images.map((image) => image.id === id ? { ...image, ...update } : image),
    }))
  }, [])

  const addIdea = useCallback((text = 'New idea', parentOverride?: MindMapNode | MindMapImage) => {
    const parent = parentOverride ?? selectedImage ?? selectedNode
    if (!parent || !rootNode) return
    const siblings = childrenByParent.get(parent.id) ?? []
    const direction = parent.id === rootNode.id
      ? (siblings.length % 2 === 0 ? 1 : -1)
      : parent.x >= rootNode.x ? 1 : -1
    const color = siblings.find((item): item is MindMapNode => 'text' in item)?.color
      ?? ('color' in parent ? parent.color : rootNode.color)
    const horizontalGap = parent.id === rootNode.id && !('dataUrl' in parent)
      ? 252
      : itemWidth(parent) / 2 + NODE_WIDTH / 2 + 51
    const newNode: MindMapNode = {
      id: crypto.randomUUID(),
      parentId: parent.id,
      text,
      note: '',
      color,
      x: parent.x + direction * horizontalGap,
      y: parent.y + (siblings.length - (siblings.length - 1) / 2) * 102,
    }
    setDocument((current) => ({ ...current, nodes: [...current.nodes, newNode] }))
    setCanSave(true)
    setSelectedImageId(null)
    setSelectedId(newNode.id)
    setNotice('')
  }, [childrenByParent, rootNode, selectedImage, selectedNode])

  const reparentBranch = useCallback((childId: string, parentId: string) => {
    const child = graphItemsById.get(childId)
    const parent = graphItemsById.get(parentId)
    if (!child || !parent || child.parentId === null || child.parentId === parent.id) return

    const branchIds = getBranchIds(childId, childrenByParent)
    if (branchIds.has(parentId)) return

    const siblings = childrenByParent.get(parent.id) ?? []
    const direction = parent.id === rootNode.id
      ? (siblings.length % 2 === 0 ? 1 : -1)
      : parent.x >= rootNode.x ? 1 : -1
    const horizontalGap = parent.id === rootNode.id
      ? 252
      : itemWidth(parent) / 2 + itemWidth(child) / 2 + 51
    const offsetX = parent.x + direction * horizontalGap - child.x
    const offsetY = parent.y + (siblings.length - (siblings.length - 1) / 2) * 102 - child.y

    setDocument((current) => ({
      ...current,
      nodes: current.nodes.map((node) => branchIds.has(node.id)
        ? {
          ...node,
          parentId: node.id === childId ? parent.id : node.parentId,
          x: node.x + offsetX,
          y: node.y + offsetY,
        }
        : node),
      images: current.images.map((image) => branchIds.has(image.id)
        ? { ...image, x: image.x + offsetX, y: image.y + offsetY }
        : image),
    }))
    setCanSave(true)
  }, [childrenByParent, graphItemsById, rootNode.id, rootNode.x])

  const refreshAiStatus = useCallback(async (refresh = false, model = aiModel) => {
    setAiStatusBusy(true)
    try {
      const status = await localLlmProvider.checkAvailability(model, refresh)
      setAiStatus(status)
      setAiSettingsError(status.error ?? '')
      return status
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setAiSettingsError(message)
      return null
    } finally {
      setAiStatusBusy(false)
    }
  }, [aiModel])

  useEffect(() => {
    if (!aiSettingsOpen) return
    if (aiProviderDraft === 'ollama') {
      setCloudKeySaved(null)
      void refreshAiStatus()
      return
    }

    setAiStatus(null)
    setCloudKeySaved(null)
    if (!isTauri()) {
      setCloudKeySaved(false)
      return
    }

    let active = true
    hasSavedCloudAiKey(aiProviderDraft)
      .then((saved) => {
        if (active) setCloudKeySaved(saved)
      })
      .catch((error: unknown) => {
        if (!active) return
        setCloudKeySaved(false)
        setAiSettingsError(error instanceof Error ? error.message : String(error))
      })
    return () => { active = false }
  }, [aiProviderDraft, aiSettingsOpen, refreshAiStatus])

  const requestSuggestions = useCallback(async () => {
    if (!selectedNode || selectedImage || isSuggesting) return
    setIsSuggesting(true)
    setSuggestions([])
    setSuggestionsReady(false)
    setSuggestionForNodeId(selectedNode.id)
    setSuggestionError('')
    try {
      const children = (childrenByParent.get(selectedNode.id) ?? [])
        .filter((item): item is MindMapNode => 'text' in item)
        .map((node) => ({ text: node.text, note: node.note }))
      const context: IdeaSuggestionContext = {
        selected: { text: selectedNode.text, note: selectedNode.note },
        parent: selectedNodeParent && 'text' in selectedNodeParent
          ? { text: selectedNodeParent.text, note: selectedNodeParent.note }
          : selectedNodeParent
            ? { text: itemLabel(selectedNodeParent), note: '' }
            : null,
        children,
      }
      if (aiProvider === 'ollama') {
        const status = await localLlmProvider.checkAvailability(aiModel)
        setAiStatus(status)
        if (!status.ollamaAvailable || !status.modelAvailable) {
          setAiProviderDraft('ollama')
          setAiModelDraft(aiModel)
          setAiSettingsOpen(true)
          setAiSettingsError(status.error ?? '')
          return
        }
        setSuggestions(await localLlmProvider.suggest(context, aiModel))
      } else {
        setSuggestions(await suggestWithCloudAi(context, aiProvider, getConfiguredCloudModel(aiProvider)))
      }
      setSuggestionsReady(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSuggestionError(message)
      if (message.includes('is not available') || message.includes('No API key is saved')) {
        setAiProviderDraft(aiProvider)
        setAiModelDraft(aiProvider === 'ollama' ? aiModel : getConfiguredCloudModel(aiProvider))
        setCloudKeyDraft('')
        setAiSettingsOpen(true)
        setAiSettingsError(message)
        if (aiProvider === 'ollama') await refreshAiStatus(true)
      }
    } finally {
      setIsSuggesting(false)
    }
  }, [aiModel, aiProvider, childrenByParent, isSuggesting, refreshAiStatus, selectedImage, selectedNode, selectedNodeParent])

  async function downloadAiModel() {
    setAiDownloadBusy(true)
    setAiSettingsError('')
    try {
      const model = aiModelDraft.trim()
      await localLlmProvider.downloadModel(model)
      await refreshAiStatus(true, model)
    } catch (error) {
      setAiSettingsError(error instanceof Error ? error.message : String(error))
    } finally {
      setAiDownloadBusy(false)
    }
  }

  async function applyAiSettings() {
    if (isSavingAiSettings) return
    setIsSavingAiSettings(true)
    setAiSettingsError('')
    try {
      const model = aiModelDraft.trim()
      if (aiProviderDraft === 'ollama') {
        saveConfiguredModel(model)
        saveConfiguredAiProvider('ollama')
        setAiModel(model)
        setAiProvider('ollama')
        setAiModelDraft(model)
        setAiStatus(null)
      } else {
        const provider: CloudAiProvider = aiProviderDraft
        let keySaved = cloudKeySaved === true
        if (cloudKeyDraft.trim()) {
          await saveCloudAiKey(provider, cloudKeyDraft.trim())
          keySaved = true
        } else if (cloudKeySaved === null) {
          keySaved = await hasSavedCloudAiKey(provider)
        }
        if (!keySaved) throw new Error(`Add an API key for ${AI_PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? provider}.`)
        const savedModel = saveConfiguredCloudModel(provider, model)
        saveConfiguredAiProvider(provider)
        setAiProvider(provider)
        setAiModelDraft(savedModel)
        setCloudKeySaved(true)
        setCloudKeyDraft('')
      }
    } catch (error) {
      setAiSettingsError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingAiSettings(false)
    }
  }

  async function forgetCloudAiKey() {
    if (aiProviderDraft === 'ollama') return
    setIsSavingAiSettings(true)
    setAiSettingsError('')
    try {
      await removeCloudAiKey(aiProviderDraft)
      setCloudKeySaved(false)
      setCloudKeyDraft('')
    } catch (error) {
      setAiSettingsError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingAiSettings(false)
    }
  }

  function closeAiSettings() {
    setAiSettingsOpen(false)
    setCloudKeyDraft('')
    setAiSettingsError('')
  }

  const selectItem = useCallback((id: string) => {
    const item = graphItemsById.get(id)
    if (!item) return
    if ('dataUrl' in item) {
      setSelectedId('')
      setSelectedImageId(item.id)
    } else {
      setSelectedId(item.id)
      setSelectedImageId(null)
    }
  }, [graphItemsById])

  const removeSubtree = useCallback((id: string) => {
    const removed = new Set<string>([id])
    const pending = [id]
    while (pending.length) {
      for (const child of childrenByParent.get(pending.pop()!) ?? []) {
        if (removed.has(child.id)) continue
        removed.add(child.id)
        pending.push(child.id)
      }
    }
    const parentId = graphItemsById.get(id)?.parentId
    setDocument((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !removed.has(node.id)),
      images: current.images.filter((image) => !removed.has(image.id)),
    }))
    setCanSave(true)
    if (parentId) selectItem(parentId)
    else selectItem(rootNode.id)
  }, [childrenByParent, graphItemsById, rootNode.id, selectItem])

  const deleteIdea = useCallback(() => {
    if (!selectedNode || selectedNode.id === rootNode.id) return
    removeSubtree(selectedNode.id)
  }, [removeSubtree, rootNode.id, selectedNode])

  const deleteImage = useCallback(() => {
    if (!selectedImage) return
    removeSubtree(selectedImage.id)
  }, [removeSubtree, selectedImage])

  const startNewDocument = useCallback(() => {
    if (!window.confirm('Start a new document? This replaces the current map. Export it first if you want to keep a copy.')) return
    const root: MindMapNode = {
      id: crypto.randomUUID(),
      parentId: null,
      text: 'Start with one idea',
      note: '',
      color: 'lilac',
      x: VIEW_WIDTH / 2,
      y: VIEW_HEIGHT / 2,
    }
    setDocument({ version: 1, title: 'Untitled map', theme: document.theme, nodes: [root], images: [] })
    setCanSave(true)
    setSelectedId(root.id)
    setSelectedImageId(null)
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setSearch('')
    setThemeMenuOpen(false)
    setNotice('')
  }, [document.theme])

  async function addImage(file: File | undefined) {
    if (!file) return
    try {
      const prepared = await prepareImage(file)
      const images = document.images ?? []
      const parent = selectedImage ?? selectedNode
      const siblings = childrenByParent.get(parent.id) ?? []
      const direction = parent.id === rootNode.id
        ? (siblings.length % 2 === 0 ? 1 : -1)
        : parent.x >= rootNode.x ? 1 : -1
      const image: MindMapImage = {
        id: crypto.randomUUID(),
        parentId: parent.id,
        name: file.name.slice(0, 120) || 'Image',
        dataUrl: prepared.dataUrl,
        x: parent.x + direction * (itemWidth(parent) / 2 + prepared.width / 2 + 60),
        y: parent.y + (siblings.length - (siblings.length - 1) / 2) * 112,
        width: prepared.width,
        height: prepared.height,
      }
      if (images.reduce((total, item) => total + item.dataUrl.length, image.dataUrl.length) > MAX_IMAGE_DATA_SIZE) {
        throw new Error('The combined images are too large to save with this map.')
      }
      setDocument((current) => ({ ...current, images: [...current.images, image] }))
      setCanSave(true)
      setSelectedImageId(image.id)
      setSelectedId('')
      setNotice('')
    } catch (error) {
      setNotice(`Couldn't add that image: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        addIdea()
      } else if (event.key === 'Delete' && !typing) {
        if (selectedImage) deleteImage()
        else deleteIdea()
      } else if (event.key === 'Escape') {
        setSearch('')
        setThemeMenuOpen(false)
        setAiSettingsOpen(false)
        setCloudKeyDraft('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addIdea, deleteIdea, deleteImage, selectedImage])

  const matchingIds = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return null
    return new Set([
      ...document.nodes.filter((node) => `${node.text} ${node.note}`.toLowerCase().includes(query)).map((node) => node.id),
      ...document.images.filter((image) => image.name.toLowerCase().includes(query)).map((image) => image.id),
    ])
  }, [document.images, document.nodes, search])

  function exportMap() {
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = window.document.createElement('a')
    link.href = url
    link.download = `${document.title.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'mind-map'}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function importMap(file: File | undefined) {
    if (!file) return
    try {
      const value = parseMindMapDocument(JSON.parse(await file.text()))
      setDocument(value)
      setCanSave(true)
      setSelectedId(value.nodes.find((node) => node.parentId === null)?.id ?? value.nodes[0].id)
      setSelectedImageId(null)
      setPan({ x: 0, y: 0 })
      setZoom(1)
      setNotice('')
      setSaveState('saved')
    } catch (error) {
      setNotice(`Couldn't import that file: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }

  const saveLabel = saveState === 'loading' ? 'Opening map' : saveState === 'saving' ? 'Saving' : saveState === 'error' ? 'Save issue' : 'Saved locally'
  const activeAiProviderLabel = AI_PROVIDER_OPTIONS.find((option) => option.id === aiProvider)?.label ?? 'Ollama (local)'
  const activeAiModel = aiProvider === 'ollama' ? aiModel : getConfiguredCloudModel(aiProvider)

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <span>kindred</span>
          <button className="icon-button sidebar-collapse" aria-label="Workspace options"><ChevronDown size={16} /></button>
        </div>

        <div className="workspace-label">YOUR WORKSPACE</div>
        <div className="workspace-card">
          <div className="workspace-icon"><Lightbulb size={17} /></div>
          <div className="workspace-copy">
            <span className="workspace-name">{document.title}</span>
            <span className="workspace-count">{document.nodes.length} ideas{document.images.length ? ` · ${document.images.length} images` : ''} · just you</span>
          </div>
          <span className="active-dot" />
        </div>

        <div className="sidebar-section-heading">
          <span>ON THIS MAP</span>
          <span className="branch-count">{childrenByParent.get(rootNode?.id ?? '')?.length ?? 0}</span>
        </div>
        <nav className="branch-list" aria-label="Map branches">
          {(childrenByParent.get(rootNode?.id ?? '') ?? []).filter((item): item is MindMapNode => 'text' in item).map((node) => (
            <button key={node.id} className={`branch-link ${selectedId === node.id ? 'is-selected' : ''}`} onClick={() => { setSelectedId(node.id); setSelectedImageId(null) }}>
              <span className="branch-swatch" style={{ backgroundColor: NODE_COLORS.find((color) => color.name === node.color)?.value ?? '#d9c8f2' }} />
              <span className="branch-label">{node.text}</span>
              <span className="branch-count">{(childrenByParent.get(node.id) ?? []).length}</span>
            </button>
          ))}
          {!childrenByParent.get(rootNode?.id ?? '')?.length && <p className="empty-sidebar">Your first idea is ready to grow.</p>}
        </nav>

        <div className="sidebar-actions">
          <div className="sidebar-section-heading"><span>QUICK ACTIONS</span></div>
          <button className="sidebar-action" onClick={() => addIdea()} title="Add a thought"><Plus size={16} /><span className="sidebar-action-label">Add a thought</span><kbd>Ctrl ↵</kbd></button>
          <button className="sidebar-action" onClick={() => imageInputRef.current?.click()} title="Add an image"><ImagePlus size={16} /><span className="sidebar-action-label">Add an image</span></button>
          <button className="sidebar-action" onClick={startNewDocument} title="Start a new document"><FilePlus2 size={16} /><span className="sidebar-action-label">New document</span></button>
          <button className="sidebar-action" onClick={() => importRef.current?.click()} title="Import a map"><ArrowUpFromLine size={16} /><span className="sidebar-action-label">Import a map</span></button>
          <button className="sidebar-action" onClick={exportMap} title="Export this map"><ArrowDownToLine size={16} /><span className="sidebar-action-label">Export this map</span></button>
          <input ref={importRef} className="visually-hidden" type="file" accept=".json,application/json" onChange={(event) => void importMap(event.target.files?.[0])} />
          <input ref={imageInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void addImage(event.target.files?.[0])} />
        </div>

        <div className="sidebar-spacer" />
        <div className="local-card">
          <div className="local-card-icon"><Check size={14} /></div>
          <div><strong>Your ideas stay yours</strong><span>Saved on this device only</span></div>
        </div>
        <div className="profile-row">
          <div className="avatar">Y</div>
          <div className="profile-copy"><strong>Your space</strong><span>Personal workspace</span></div>
          <button className="icon-button" aria-label="Help"><CircleHelp size={17} /></button>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumbs">
            <span className="crumb-muted">My workspace</span><span className="breadcrumb-divider">/</span>
            <input className="map-title-input" aria-label="Map title" value={document.title} maxLength={80} onChange={(event) => { setCanSave(true); setDocument((current) => ({ ...current, title: event.target.value })) }} />
            <span className={`save-indicator ${saveState}`}>
              {saveState === 'saving' || saveState === 'loading' ? <LoaderCircle size={13} className="spin" /> : saveState === 'error' ? <X size={13} /> : <Check size={13} />}
              {saveLabel}
            </span>
          </div>
          <div className="topbar-actions">
            <button className="topbar-export" onClick={exportMap}><ArrowDownToLine size={15} /> <span>Export</span></button>
            <button className="topbar-export suggest-toolbar-button" onClick={() => void requestSuggestions()} disabled={isSuggesting || Boolean(selectedImage)} title={selectedImage ? 'Select an idea to get suggestions' : 'Suggest child ideas for the selected node'}>
              {isSuggesting ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />} <span>Suggest ideas</span>
            </button>
            <button className="primary-button" onClick={() => addIdea()}><Plus size={16} /> Add idea <kbd><Command size={11} /> ↵</kbd></button>
            <button className="icon-button ai-settings-trigger" aria-label="AI settings" title="AI settings" onClick={() => {
              setAiProviderDraft(aiProvider)
              setAiModelDraft(activeAiModel)
              setCloudKeyDraft('')
              setCloudKeySaved(null)
              setAiSettingsError('')
              setAiSettingsOpen(true)
            }}><Settings2 size={17} /></button>
            <button className="icon-button topbar-more" aria-label="More options" onClick={() => setNotice('Your map is saved locally and can be exported as a JSON file.')}><CircleHelp size={17} /></button>
          </div>
        </header>

        <div className="canvas-toolbar">
          <div className="theme-menu-wrap">
            <button className="canvas-mode" aria-expanded={themeMenuOpen} onClick={() => setThemeMenuOpen((open) => !open)}>
              <Palette size={15} /> Board theme <ChevronDown size={13} />
            </button>
            {themeMenuOpen && (
              <div className="theme-popover" role="group" aria-label="Board themes">
                <span className="theme-popover-title">CHOOSE A PALETTE</span>
                {BOARD_THEMES.map((theme) => (
                  <button key={theme.id} className={`theme-option ${document.theme === theme.id ? 'is-selected' : ''}`} onClick={() => {
                    setDocument((current) => ({ ...current, theme: theme.id }))
                    setCanSave(true)
                    setThemeMenuOpen(false)
                  }} aria-pressed={document.theme === theme.id}>
                    <span className="theme-preview" style={{ backgroundColor: theme.preview, borderColor: theme.connection }}>
                      <span /><span /><span />
                    </span>
                    <span>{theme.label}</span>
                    {document.theme === theme.id && <Check size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="canvas-tools">
            <label className="search-field">
              <Search size={15} />
              <input aria-label="Search ideas" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find an idea..." />
              {search && <button className="search-clear" aria-label="Clear search" onClick={() => setSearch('')}><X size={13} /></button>}
              {!search && <kbd>/</kbd>}
            </label>
            <span className="tool-divider" />
            <div className="zoom-control">
              <button className="zoom-button" aria-label="Zoom out" onClick={() => setZoom((current) => Math.max(0.65, Math.round((current - 0.1) * 10) / 10))}><Minus size={14} /></button>
              <span>{Math.round(zoom * 100)}%</span>
              <button className="zoom-button" aria-label="Zoom in" onClick={() => setZoom((current) => Math.min(2.35, Math.round((current + 0.1) * 10) / 10))}><Plus size={14} /></button>
            </div>
            <button className="zoom-button fit-button" aria-label="Reset zoom" onClick={() => setZoom(1)}><Focus size={15} /></button>
          </div>
        </div>

        <div className="workspace-body">
          <div
            ref={canvasWrapRef}
            className={`canvas-wrap theme-${document.theme} ${isPanning ? 'is-panning' : ''} ${reparentingId ? 'is-reparenting' : ''}`}
            style={{
              backgroundColor: activeTheme.background,
              backgroundImage: `radial-gradient(circle, ${activeTheme.grid} 1px, transparent 1px)`,
              backgroundSize: '28px 28px',
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || (event.target as Element).closest('.mind-node, .board-image, button, input, textarea, .notice')) return
              event.preventDefault()
              const svg = canvasSvgRef.current
              if (!svg) return
              const position = pointerToCanvas(svg, event.clientX, event.clientY)
              panRef.current = { startX: position.x, startY: position.y, offsetX: pan.x, offsetY: pan.y }
              setIsPanning(true)
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const svg = canvasSvgRef.current
              if (!svg) return
              if (panRef.current) {
                const position = pointerToCanvas(svg, event.clientX, event.clientY)
                setPan({
                  x: panRef.current.offsetX + position.x - panRef.current.startX,
                  y: panRef.current.offsetY + position.y - panRef.current.startY,
                })
                return
              }
              if (dragRef.current) {
                if (dragRef.current.type === 'reparent') {
                  const targetId = window.document.elementFromPoint(event.clientX, event.clientY)
                    ?.closest<SVGGElement>('.mind-node')?.dataset.nodeId ?? null
                  setReparentTargetId(targetId && targetId !== dragRef.current.parentId && !dragRef.current.branchIds.has(targetId)
                    ? targetId
                    : null)
                  return
                }
                const position = pointerToMap(svg, event.clientX, event.clientY, zoom, pan)
                const drag = dragRef.current
                const update = { x: position.x + drag.offsetX, y: position.y + drag.offsetY }
                if (drag.type === 'node') updateNode(drag.id, update)
                else updateImage(drag.id, update)
              }
            }}
            onPointerUp={(event) => {
              const drag = dragRef.current
              if (drag?.type === 'reparent') {
                const targetId = window.document.elementFromPoint(event.clientX, event.clientY)
                  ?.closest<SVGGElement>('.mind-node')?.dataset.nodeId
                if (targetId && targetId !== drag.parentId && !drag.branchIds.has(targetId)) {
                  reparentBranch(drag.id, targetId)
                }
              }
              dragRef.current = null
              panRef.current = null
              setDraggingId(null)
              setIsPanning(false)
              setReparentingId(null)
              setReparentTargetId(null)
            }}
            onPointerCancel={() => {
              dragRef.current = null
              panRef.current = null
              setDraggingId(null)
              setIsPanning(false)
              setReparentingId(null)
              setReparentTargetId(null)
            }}
          >
            <div className="canvas-caption"><span className="caption-dot" /> A little space to think</div>
            {notice && <div className={`notice ${saveState === 'error' ? 'notice-error' : ''}`} role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={14} /></button></div>}
            <svg
              ref={canvasSvgRef}
              className={`mindmap-canvas ${isPanning ? 'is-panning' : ''} ${reparentingId ? 'is-reparenting' : ''}`}
              viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
              role="img"
              aria-label="Interactive mind map. Drag the background to move around, drag an idea to reposition it, or drag an idea's connector onto another idea to reparent its branch."
            >
              <defs>
                <pattern id="dot-grid" width="28" height="28" patternUnits="userSpaceOnUse">
                  <circle cx="1" cy="1" r="1" fill={activeTheme.grid} />
                </pattern>
                {(document.images ?? []).map((image, index) => (
                  <clipPath key={image.id} id={`image-clip-${index}`}>
                    <rect x={-image.width / 2} y={-image.height / 2} width={image.width} height={image.height} rx="10" />
                  </clipPath>
                ))}
              </defs>
              <rect className="canvas-background" width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={activeTheme.background} />
              <rect className="canvas-grid" width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="url(#dot-grid)" pointerEvents="none" />
              <g transform={`translate(${VIEW_WIDTH * (1 - zoom) / 2 + pan.x} ${VIEW_HEIGHT * (1 - zoom) / 2 + pan.y}) scale(${zoom})`}>
                <g className="connections">
                  {graphItems.map((item) => {
                    if (!item.parentId) return null
                    const parent = graphItemsById.get(item.parentId)
                    if (!parent) return null
                    const direction = item.x >= parent.x ? 1 : -1
                    const startX = parent.x + direction * (itemWidth(parent) / 2 - 5)
                    const endX = item.x - direction * (itemWidth(item) / 2 - 5)
                    const curve = Math.max(55, Math.abs(endX - startX) * 0.42)
                    const dimmed = matchingIds !== null && !matchingIds.has(item.id) && !matchingIds.has(parent.id)
                    const path = `M ${startX} ${parent.y} C ${startX + direction * curve} ${parent.y}, ${endX - direction * curve} ${item.y}, ${endX} ${item.y}`
                    return (
                      <g key={`edge-${item.id}`}>
                        <path className={`connection ${dimmed ? 'is-dimmed' : ''} ${reparentingId === item.id ? 'is-reparenting' : ''}`} style={{ stroke: activeTheme.connection }} d={path} />
                        {'text' in item && (
                          <path
                            className="connection-hit-area"
                            d={path}
                            aria-label={`Drag to change the parent of ${item.text}`}
                            onPointerDown={(event) => {
                              if (event.button !== 0) return
                              event.stopPropagation()
                              event.preventDefault()
                              dragRef.current = {
                                type: 'reparent',
                                id: item.id,
                                parentId: item.parentId!,
                                branchIds: getBranchIds(item.id, childrenByParent),
                              }
                              setReparentingId(item.id)
                              setReparentTargetId(null)
                              canvasWrapRef.current?.setPointerCapture(event.pointerId)
                            }}
                          >
                            <title>Drag this line onto an idea to change its parent</title>
                          </path>
                        )}
                      </g>
                    )
                  })}
                </g>
                {(document.images ?? []).map((image, index) => (
                  <g
                    key={image.id}
                    className={`board-image ${selectedImageId === image.id ? 'is-active' : ''} ${draggingId === image.id ? 'is-dragging' : ''} ${matchingIds !== null && !matchingIds.has(image.id) ? 'is-dimmed' : ''}`}
                    transform={`translate(${image.x} ${image.y})`}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return
                      event.stopPropagation()
                      const position = pointerToMap(event.currentTarget.ownerSVGElement!, event.clientX, event.clientY, zoom, pan)
                      dragRef.current = { type: 'image', id: image.id, offsetX: image.x - position.x, offsetY: image.y - position.y }
                      setDraggingId(image.id)
                      setSelectedImageId(image.id)
                      setSelectedId('')
                      canvasWrapRef.current?.setPointerCapture(event.pointerId)
                    }}
                    onClick={() => { setSelectedId(''); setSelectedImageId(image.id) }}
                    role="button"
                    aria-label={`Image: ${image.name}`}
                    tabIndex={0}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { setSelectedId(''); setSelectedImageId(image.id) } }}
                  >
                    <title>{image.name}</title>
                    <rect className="board-image-shadow" x={-image.width / 2} y={-image.height / 2} width={image.width} height={image.height} rx="10" />
                    <image href={image.dataUrl} x={-image.width / 2} y={-image.height / 2} width={image.width} height={image.height} preserveAspectRatio="xMidYMid slice" clipPath={`url(#image-clip-${index})`} pointerEvents="none" />
                    <rect className="board-image-frame" x={-image.width / 2} y={-image.height / 2} width={image.width} height={image.height} rx="10" />
                    <text className="board-image-label" y={image.height / 2 + 17}>{image.name.length > 26 ? `${image.name.slice(0, 23)}...` : image.name}</text>
                    {childrenByParent.has(image.id) && <text className="child-count" x={image.width / 2 - 13} y={-image.height / 2 + 12}>{childrenByParent.get(image.id)?.length}</text>}
                  </g>
                ))}
                {document.nodes.map((node) => {
                  const root = node.parentId === null
                  const selected = node.id === selectedId
                  const dimmed = matchingIds !== null && !matchingIds.has(node.id)
                  const lines = wrapText(node.text || 'Untitled idea', root ? 25 : 20)
                  return (
                    <g
                      key={node.id}
                      className={`mind-node ${selected ? 'is-active' : ''} ${root ? 'is-root' : ''} ${dimmed ? 'is-dimmed' : ''} ${draggingId === node.id ? 'is-dragging' : ''} ${reparentTargetId === node.id ? 'is-drop-target' : ''}`}
                      data-node-id={node.id}
                      transform={`translate(${node.x} ${node.y})`}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return
                        event.stopPropagation()
                        const position = pointerToMap(event.currentTarget.ownerSVGElement!, event.clientX, event.clientY, zoom, pan)
                        dragRef.current = { type: 'node', id: node.id, offsetX: node.x - position.x, offsetY: node.y - position.y }
                        setDraggingId(node.id)
                        setSelectedId(node.id)
                        setSelectedImageId(null)
                        canvasWrapRef.current?.setPointerCapture(event.pointerId)
                      }}
                      onClick={() => { setSelectedId(node.id); setSelectedImageId(null) }}
                      onDoubleClick={() => { setSelectedId(node.id); setSelectedImageId(null) }}
                      role="button"
                      aria-label={`${node.text}${selected ? ', selected' : ''}`}
                      tabIndex={0}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { setSelectedId(node.id); setSelectedImageId(null) } }}
                    >
                      <rect className="node-shadow" x={-nodeWidth(node) / 2} y={-NODE_HEIGHT / 2} width={nodeWidth(node)} height={NODE_HEIGHT} rx={root ? 20 : 16} />
                      <rect className="node-card" x={-nodeWidth(node) / 2} y={-NODE_HEIGHT / 2} width={nodeWidth(node)} height={NODE_HEIGHT} rx={root ? 20 : 16} fill={NODE_COLORS.find((color) => color.name === node.color)?.value ?? '#d9c8f2'} />
                      {root && <circle className="root-sparkle" cx={-nodeWidth(node) / 2 + 23} cy={0} r="4" />}
                      <text className="node-label" y={lines.length === 1 ? 5 : -5} x={root ? 10 : 0}>
                        {lines.map((line, index) => <tspan key={`${node.id}-${index}`} x={root ? 10 : 0} dy={index === 0 ? 0 : 17}>{line}</tspan>)}
                      </text>
                      {childrenByParent.has(node.id) && <text className="child-count" x={nodeWidth(node) / 2 - 13} y={-NODE_HEIGHT / 2 + 12}>{childrenByParent.get(node.id)?.length}</text>}
                    </g>
                  )
                })}
              </g>
            </svg>
            <div className="canvas-footer">
              <span><span className="footer-key">Ctrl</span> <span className="footer-key">↵</span> add an idea</span>
              <span className="footer-separator">·</span>
              <span>Drag ideas to move · drag a connector to reparent</span>
              <span className="canvas-idea-count">{document.nodes.length} ideas{document.images.length ? ` · ${document.images.length} images` : ''}</span>
            </div>
          </div>

          <aside className="inspector">
            <div className="inspector-heading">
              <div><span className="eyebrow">YOUR THINKING, UNFOLDED</span><h2>Idea details</h2></div>
              <button className="icon-button inspector-more" aria-label="Close details"><X size={16} /></button>
            </div>
            {selectedImage ? (
              <>
                <div className="field-group">
                  <label htmlFor="image-name">IMAGE</label>
                  <input id="image-name" className="image-name-field" value={selectedImage.name} maxLength={120} onChange={(event) => updateImage(selectedImage.id, { name: event.target.value })} />
                  <div className="field-meta"><span>On this board</span><span>{selectedImage.width} × {selectedImage.height}</span></div>
                </div>
                <div className="image-preview-frame">
                  <img src={selectedImage.dataUrl} alt={selectedImage.name} />
                </div>
                <div className="inspector-separator image-separator" />
                <button className="add-branch-button" onClick={() => addIdea()}><Plus size={16} /> Add a connected idea</button>
                <div className="parent-context">
                  <span className="parent-label">CONNECTED TO</span>
                  {selectedImageParent && (
                    <button className="parent-pill" onClick={() => selectItem(selectedImageParent.id)}>
                      <span className="parent-swatch" style={{ backgroundColor: 'color' in selectedImageParent ? NODE_COLORS.find((color) => color.name === selectedImageParent.color)?.value : '#dddcd6' }} />
                      {itemLabel(selectedImageParent)}
                    </button>
                  )}
                </div>
                <button className="delete-branch-button" onClick={deleteImage}><Trash2 size={15} /> Remove image from board</button>
                <div className="ai-card">
                  <div className="ai-icon"><ImagePlus size={15} /></div>
                  <div className="ai-card-copy"><strong>Saved with your map</strong><span>Images stay on this device and travel with JSON exports.</span></div>
                </div>
              </>
            ) : selectedNode ? (
              <>
                <div className="field-group">
                  <label htmlFor="idea-title">IDEA</label>
                  <textarea id="idea-title" className="idea-title-field" rows={2} maxLength={160} value={selectedNode.text} onChange={(event) => updateNode(selectedNode.id, { text: event.target.value })} placeholder="Give this idea a name..." />
                  <div className="field-meta"><span>{selectedNode.parentId ? 'Branch idea' : 'Center of your map'}</span><span>{selectedNode.text.length}/160</span></div>
                </div>
                <div className="field-group note-group">
                  <label htmlFor="idea-note">A LITTLE MORE</label>
                  <textarea id="idea-note" className="note-field" rows={5} maxLength={500} value={selectedNode.note} onChange={(event) => updateNode(selectedNode.id, { note: event.target.value })} placeholder="Add a thought, a question, or a detail to remember..." />
                  <div className="field-meta"><span>Notes are just for you</span><span>{selectedNode.note.length}/500</span></div>
                </div>
                <div className="field-group color-group">
                  <label>COLOR</label>
                  <div className="color-options" role="group" aria-label="Idea color">
                    {NODE_COLORS.map((color) => (
                      <button key={color.name} className={`color-option ${selectedNode.color === color.name ? 'is-picked' : ''}`} style={{ backgroundColor: color.value }} onClick={() => updateNode(selectedNode.id, { color: color.name })} aria-label={`${color.name} color`} aria-pressed={selectedNode.color === color.name}>
                        {selectedNode.color === color.name && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="inspector-separator" />
                <button className="add-branch-button" onClick={() => addIdea()}><Plus size={16} /> Add a connected idea</button>
                <button className="suggest-ideas-button" onClick={() => void requestSuggestions()} disabled={isSuggesting}>
                  {isSuggesting ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
                  {isSuggesting ? 'Generating suggestions...' : 'Suggest ideas'}
                </button>
                {selectedNode.parentId && <button className="delete-branch-button" onClick={deleteIdea}><Trash2 size={15} /> Remove this idea & its branches</button>}
                <div className="parent-context">
                  <span className="parent-label">CONNECTED TO</span>
                  <button className="parent-pill" onClick={() => { if (selectedNode.parentId) selectItem(selectedNode.parentId) }}>
                      <span className="parent-swatch" style={{ backgroundColor: selectedNodeParent && 'color' in selectedNodeParent ? NODE_COLORS.find((color) => color.name === selectedNodeParent.color)?.value : '#dddcd6' }} />
                      {selectedNodeParent ? itemLabel(selectedNodeParent) : 'Your central idea'}
                  </button>
                </div>
                <div className="ai-card">
                  <div className="ai-icon"><Sparkles size={15} /></div>
                  <div className="ai-card-copy">
                    <strong>{aiProvider === 'ollama' ? 'Private, local brainstorming' : `${activeAiProviderLabel} brainstorming`}</strong>
                    <span>{aiProvider === 'ollama'
                      ? `Uses ${activeAiModel} through Ollama on this device.`
                      : `Selected idea context is sent to ${activeAiProviderLabel} when you request suggestions.`}</span>
                  </div>
                </div>
              </>
            ) : <p className="empty-inspector">Choose an idea to see its details.</p>}
            {suggestionForNodeId && (suggestionError || suggestionsReady) && (
              <div className="suggestion-results" aria-live="polite">
                {suggestionError && <p className="suggestion-error" role="alert">{suggestionError}</p>}
                {suggestionsReady && (
                  <>
                    <span className="suggestion-heading">CHOOSE IDEAS TO ADD</span>
                    {suggestions.length > 0
                      ? suggestions.map((suggestion, index) => (
                        <button key={`${suggestion}-${index}`} className="suggestion-option" onClick={() => {
                          const parent = document.nodes.find((node) => node.id === suggestionForNodeId) ?? selectedNode
                          if (!parent) return
                          addIdea(suggestion, parent)
                          setSuggestions((current) => current.filter((_, itemIndex) => itemIndex !== index))
                        }}>
                          <Plus size={13} /><span>{suggestion}</span>
                        </button>
                      ))
                      : <p className="suggestion-empty">All suggestions have been added.</p>}
                  </>
                )}
              </div>
            )}
          </aside>
        </div>
      </section>
      {aiSettingsOpen && (
        <div className="ai-settings-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeAiSettings()
        }}>
          <section className="ai-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
            <div className="ai-settings-heading">
              <div><span className="eyebrow">AI PROVIDERS</span><h2 id="ai-settings-title">AI settings</h2></div>
              <button className="icon-button" aria-label="Close AI settings" onClick={closeAiSettings}><X size={16} /></button>
            </div>
            <label className="ai-model-field" htmlFor="ai-provider">AI PROVIDER</label>
            <select id="ai-provider" className="ai-settings-select" value={aiProviderDraft} onChange={(event) => {
              const provider = AI_PROVIDER_OPTIONS.find((option) => option.id === event.currentTarget.value)?.id
              if (!provider) return
              setAiProviderDraft(provider)
              setAiModelDraft(provider === 'ollama' ? aiModel : getConfiguredCloudModel(provider))
              setCloudKeyDraft('')
              setCloudKeySaved(null)
              setAiSettingsError('')
            }}>
              {AI_PROVIDER_OPTIONS.map((option) => (
                <option key={option.id} value={option.id} disabled={option.id !== 'ollama' && !isTauri()}>{option.label}</option>
              ))}
            </select>
            {aiProviderDraft === 'ollama' ? (
              <>
                <label className="ai-model-field" htmlFor="ai-model-tag">OLLAMA MODEL TAG</label>
                <div className="ai-model-entry">
                  <input id="ai-model-tag" value={aiModelDraft} maxLength={100} onChange={(event) => setAiModelDraft(event.target.value)} />
                </div>
                <p className="ai-settings-hint">Default: {DEFAULT_LOCAL_MODEL}. Choose any model tag installed in Ollama.</p>
                <div className={`ai-status-card ${aiStatus?.ollamaAvailable ? aiStatus.modelAvailable ? 'is-ready' : 'is-missing' : 'is-offline'}`} role="status">
                  {aiStatus?.ollamaAvailable && aiStatus.modelAvailable
                    ? <Check size={17} />
                    : <CircleAlert size={17} />}
                  <div>
                    <strong>
                      {!aiStatus && !aiSettingsError ? 'Status not checked' :
                        aiStatus?.ollamaAvailable ? aiStatus.modelAvailable ? 'Ollama and model ready' : 'Model not downloaded' :
                          'Ollama unavailable'}
                    </strong>
                    <span>
                      {aiStatus?.ollamaAvailable
                        ? aiStatus.modelAvailable
                          ? `${aiStatus.model} is ready for local suggestions.`
                          : `Download ${aiStatus.model} to enable suggestions.`
                        : aiStatus?.error ?? aiSettingsError ?? 'Check that Ollama is installed and running on this device.'}
                    </span>
                    {aiStatus?.cached && <small>Availability check cached for up to 30 seconds.</small>}
                    {!aiStatus?.ollamaAvailable && <a href="https://ollama.com/download" target="_blank" rel="noreferrer">Install Ollama</a>}
                  </div>
                </div>
                <div className="ai-settings-actions">
                  <button className="settings-action-button secondary" onClick={() => void refreshAiStatus(true, aiModelDraft.trim())} disabled={aiStatusBusy || aiDownloadBusy}>
                    {aiStatusBusy ? <LoaderCircle size={14} className="spin" /> : <Settings2 size={14} />}
                    {aiStatusBusy ? 'Checking...' : 'Check status'}
                  </button>
                  {aiStatus?.ollamaAvailable && !aiStatus.modelAvailable && (
                    <button className="settings-action-button" onClick={() => void downloadAiModel()} disabled={aiDownloadBusy || aiStatusBusy}>
                      {aiDownloadBusy ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
                      {aiDownloadBusy ? 'Downloading model...' : 'Download model'}
                    </button>
                  )}
                </div>
                <p className="ai-download-note">Models download only when requested and are never bundled with Kindred.</p>
              </>
            ) : (
              <>
                <label className="ai-model-field" htmlFor="ai-model-tag">MODEL ID</label>
                <div className="ai-model-entry">
                  <input id="ai-model-tag" value={aiModelDraft} maxLength={120} onChange={(event) => setAiModelDraft(event.target.value)} />
                </div>
                <p className="ai-settings-hint">Default: {DEFAULT_CLOUD_MODELS[aiProviderDraft]}. Use a model ID enabled for your provider account.</p>
                <label className="ai-model-field" htmlFor="cloud-ai-key">API KEY</label>
                <div className="ai-model-entry">
                  <input
                    id="cloud-ai-key"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={cloudKeyDraft}
                    maxLength={512}
                    disabled={!isTauri()}
                    placeholder={cloudKeySaved ? 'Saved securely — leave blank to keep it' : 'Enter your provider API key'}
                    onChange={(event) => setCloudKeyDraft(event.target.value)}
                  />
                </div>
                <div className={`ai-status-card ${cloudKeySaved ? 'is-ready' : cloudKeySaved === false ? 'is-missing' : ''}`} role="status">
                  {cloudKeySaved === null
                    ? <LoaderCircle size={17} className="spin" />
                    : cloudKeySaved ? <Check size={17} /> : <CircleAlert size={17} />}
                  <div>
                    <strong>{cloudKeySaved ? 'API key saved securely' : cloudKeySaved === false ? 'API key required' : 'Checking saved key'}</strong>
                    <span>{cloudKeySaved
                      ? 'The key is stored in your operating system credential manager, not in your map.'
                      : cloudKeySaved === false
                        ? 'Save an API key to enable online suggestions.'
                        : 'Checking the operating system credential manager.'}</span>
                  </div>
                </div>
                <p className="ai-privacy-note">
                  When you request suggestions, Kindred sends the selected idea and its note, its parent and note, and its immediate child ideas and notes to {AI_PROVIDER_OPTIONS.find((option) => option.id === aiProviderDraft)?.label}. The provider may charge for API use and handle submitted data under its own policies.
                </p>
                {!isTauri() && <p className="ai-settings-hint">Online AI requires the desktop app so API keys can be kept in the operating system credential manager.</p>}
                <div className="ai-settings-actions">
                  {cloudKeySaved && (
                    <button className="settings-action-button secondary" onClick={() => void forgetCloudAiKey()} disabled={isSavingAiSettings}>
                      Forget API key
                    </button>
                  )}
                </div>
              </>
            )}
            {aiSettingsError && (aiProviderDraft !== 'ollama' || aiStatus?.error !== aiSettingsError) && <p className="ai-settings-error" role="alert">{aiSettingsError}</p>}
            <div className="ai-settings-actions ai-settings-footer">
              <button className="settings-action-button" onClick={() => void applyAiSettings()} disabled={isSavingAiSettings || (aiProviderDraft !== 'ollama' && !isTauri())}>
                {isSavingAiSettings ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
                {isSavingAiSettings ? 'Saving...' : 'Save AI settings'}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
