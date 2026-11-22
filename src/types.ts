export type MindMapNode = {
  id: string
  parentId: string | null
  text: string
  note: string
  color: string
  x: number
  y: number
}

export type MindMapImage = {
  id: string
  name: string
  dataUrl: string
  x: number
  y: number
  width: number
  height: number
}

export type BoardThemeId = 'paper' | 'meadow' | 'ocean' | 'lavender' | 'night'

export type MindMapDocument = {
  version: 1
  title: string
  nodes: MindMapNode[]
  theme: BoardThemeId
  images: MindMapImage[]
}
