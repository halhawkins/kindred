import type { BoardThemeId, MindMapDocument, MindMapImage, MindMapNode } from './types'

export const DEFAULT_MAP: MindMapDocument = {
  version: 1,
  title: 'A slower kind of weekend',
  theme: 'paper',
  images: [],
  nodes: [
    { id: 'root', parentId: null, text: 'A slower kind of weekend', note: 'Make a little room to recharge and enjoy the people around me.', color: 'lilac', x: 700, y: 430 },
    { id: 'places', parentId: 'root', text: 'Find new places', note: 'Somewhere close, with no big itinerary.', color: 'blue', x: 1010, y: 250 },
    { id: 'walk', parentId: 'places', text: 'Take the long way', note: 'Pick a neighborhood and wander.', color: 'blue', x: 1260, y: 170 },
    { id: 'coffee', parentId: 'places', text: 'A café with a patio', note: '', color: 'blue', x: 1260, y: 330 },
    { id: 'simple', parentId: 'root', text: 'Keep it simple', note: 'One or two lovely things is plenty.', color: 'peach', x: 1010, y: 560 },
    { id: 'market', parentId: 'simple', text: 'Saturday market', note: 'Grab fruit and something fresh for dinner.', color: 'peach', x: 1260, y: 490 },
    { id: 'cook', parentId: 'simple', text: 'Cook something new', note: '', color: 'peach', x: 1260, y: 650 },
    { id: 'reset', parentId: 'root', text: 'Make room to reset', note: '', color: 'mint', x: 390, y: 330 },
    { id: 'reading', parentId: 'reset', text: 'Read somewhere sunny', note: 'Bring the book I keep meaning to finish.', color: 'mint', x: 140, y: 250 },
    { id: 'phone', parentId: 'reset', text: 'A little less screen time', note: 'Leave my phone on the charger for a while.', color: 'mint', x: 140, y: 410 },
    { id: 'people', parentId: 'root', text: 'Bring good company', note: '', color: 'butter', x: 390, y: 570 },
    { id: 'dinner', parentId: 'people', text: 'Dinner with friends', note: 'Keep it cozy; everyone can bring a little something.', color: 'butter', x: 140, y: 650 },
  ],
}

export const NODE_COLORS = [
  { name: 'lilac', value: '#d9c8f2' },
  { name: 'blue', value: '#c8def2' },
  { name: 'mint', value: '#cce8d9' },
  { name: 'peach', value: '#f5d4c6' },
  { name: 'butter', value: '#f1e5b7' },
  { name: 'rose', value: '#f1cfdb' },
] as const

export const BOARD_THEMES: { id: BoardThemeId; label: string; background: string; grid: string; connection: string; preview: string }[] = [
  { id: 'paper', label: 'Paper', background: '#fbfaf7', grid: '#dddcd6', connection: '#c8c8bc', preview: '#fbfaf7' },
  { id: 'meadow', label: 'Meadow', background: '#f1f5ed', grid: '#d8e0d1', connection: '#b2c0a8', preview: '#e5eee0' },
  { id: 'ocean', label: 'Ocean', background: '#eef5f7', grid: '#d1e0e3', connection: '#a8c0c4', preview: '#dcebed' },
  { id: 'lavender', label: 'Lavender', background: '#f4f0f8', grid: '#e0d8e9', connection: '#c5b7d2', preview: '#e9e0f0' },
  { id: 'night', label: 'Night garden', background: '#252a32', grid: '#434b56', connection: '#687483', preview: '#343c48' },
]

type MindMapImageInput = Omit<MindMapImage, 'parentId'> & { parentId?: string | null }

type MindMapDocumentInput = Omit<MindMapDocument, 'theme' | 'images'> & {
  theme?: BoardThemeId
  images?: MindMapImageInput[]
}

export function isMindMapDocument(value: unknown): value is MindMapDocumentInput {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Partial<MindMapDocumentInput>
  if (
    document.version !== 1 ||
    typeof document.title !== 'string' ||
    document.title.length > 80 ||
    (document.theme !== undefined && !BOARD_THEMES.some((theme) => theme.id === document.theme)) ||
    (document.images !== undefined && !Array.isArray(document.images)) ||
    !Array.isArray(document.nodes)
  ) return false
  if (!document.nodes.length || document.nodes.length > 1000) return false

  const ids = new Set<string>()
  for (const candidate of document.nodes) {
    if (typeof candidate !== 'object' || candidate === null) return false
    const node = candidate as Partial<MindMapNode>
    if (
      typeof node.id !== 'string' ||
      !node.id ||
      ids.has(node.id) ||
      (node.parentId !== null && typeof node.parentId !== 'string') ||
      typeof node.text !== 'string' ||
      node.text.length > 160 ||
      typeof node.note !== 'string' ||
      node.note.length > 500 ||
      typeof node.color !== 'string' ||
      typeof node.x !== 'number' ||
      !Number.isFinite(node.x) ||
      typeof node.y !== 'number' ||
      !Number.isFinite(node.y)
    ) return false
    ids.add(node.id)
  }

  const images = document.images ?? []
  if (images.length > 10) return false
  let totalImageData = 0
  const imageIds = new Set<string>()
  for (const candidate of images) {
    if (typeof candidate !== 'object' || candidate === null) return false
    const image = candidate as Partial<MindMapImage>
    if (
      typeof image.id !== 'string' ||
      !image.id ||
      ids.has(image.id) ||
      imageIds.has(image.id) ||
      (image.parentId !== undefined && image.parentId !== null && typeof image.parentId !== 'string') ||
      typeof image.name !== 'string' ||
      image.name.length > 120 ||
      typeof image.dataUrl !== 'string' ||
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl) ||
      typeof image.x !== 'number' ||
      !Number.isFinite(image.x) ||
      typeof image.y !== 'number' ||
      !Number.isFinite(image.y) ||
      typeof image.width !== 'number' ||
      !Number.isFinite(image.width) ||
      image.width <= 0 ||
      image.width > 400 ||
      typeof image.height !== 'number' ||
      !Number.isFinite(image.height) ||
      image.height <= 0 ||
      image.height > 400
    ) return false
    imageIds.add(image.id)
    totalImageData += image.dataUrl.length
  }
  if (totalImageData > 2_000_000) return false

  const roots = document.nodes.filter((node) => node.parentId === null)
  if (roots.length !== 1) return false
  const rootId = roots[0].id
  if (
    !document.nodes.every((node) => node.parentId === null || ids.has(node.parentId) || imageIds.has(node.parentId)) ||
    !images.every((image) => {
      const parentId = image.parentId ?? rootId
      return ids.has(parentId) || imageIds.has(parentId)
    })
  ) return false

  const children = new Map<string, string[]>()
  for (const node of document.nodes) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node.id)
    children.set(node.parentId, siblings)
  }
  for (const image of images) {
    const parentId = image.parentId ?? rootId
    const siblings = children.get(parentId) ?? []
    siblings.push(image.id)
    children.set(parentId, siblings)
  }
  const visited = new Set<string>()
  const pending = [roots[0].id]
  while (pending.length) {
    const id = pending.pop()
    if (!id || visited.has(id)) continue
    visited.add(id)
    pending.push(...(children.get(id) ?? []))
  }
  return visited.size === document.nodes.length + images.length
}

export function parseMindMapDocument(value: unknown): MindMapDocument {
  if (!isMindMapDocument(value)) throw new Error('This file is not a valid Kindred mind map.')
  const rootId = value.nodes.find((node) => node.parentId === null)!.id
  return {
    ...value,
    theme: value.theme ?? 'paper',
    images: (value.images ?? []).map((image) => ({ ...image, parentId: image.parentId ?? rootId })),
  }
}
