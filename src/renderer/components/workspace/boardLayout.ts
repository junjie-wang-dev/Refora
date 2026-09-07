import {
  WORKSPACE_CANVAS_DEFAULT_ZOOM,
  type WorkspaceCanvasViewport,
  type WorkspaceItem
} from '../../../shared/ipc-types'
import type { CardSize } from './ResizableCard'

export const VIEWPORT_SAVE_DELAY = 160
export const DEFAULT_VIEWPORT: WorkspaceCanvasViewport = {
  panX: 0,
  panY: 0,
  zoom: WORKSPACE_CANVAS_DEFAULT_ZOOM
}

export function fitContentViewport(
  bounds: Array<{ x: number; y: number; width: number; height: number }>,
  width: number,
  height: number
): WorkspaceCanvasViewport {
  if (!bounds.length || width <= 0 || height <= 0) return DEFAULT_VIEWPORT
  const left = Math.min(...bounds.map((item) => item.x))
  const top = Math.min(...bounds.map((item) => item.y))
  const right = Math.max(...bounds.map((item) => item.x + item.width))
  const bottom = Math.max(...bounds.map((item) => item.y + item.height))
  const zoom = Math.min(
    WORKSPACE_CANVAS_DEFAULT_ZOOM,
    Math.max(1, width - 64) / Math.max(1, right - left),
    Math.max(1, height - 112) / Math.max(1, bottom - top)
  )
  return {
    panX: width / 2 - (left + right) / 2 * zoom,
    panY: (height - 48) / 2 - (top + bottom) / 2 * zoom,
    zoom
  }
}

export interface GridPlacement {
  x: number
  y: number
}

export function compactGridPlacements(
  items: WorkspaceItem[],
  sizeFor: (item: WorkspaceItem) => CardSize,
  originX: number,
  originY: number
): GridPlacement[] {
  const gap = 24
  const columnCount = Math.ceil(Math.sqrt(items.length))
  const columns = Array.from({ length: columnCount }, () => ({
    width: 0,
    height: 0
  }))
  const itemColumns: number[] = []
  const itemY: number[] = []

  items.forEach((item) => {
    const size = sizeFor(item)
    let columnIndex = 0
    for (let index = 1; index < columns.length; index += 1) {
      if (columns[index].height < columns[columnIndex].height) columnIndex = index
    }
    const column = columns[columnIndex]
    itemColumns.push(columnIndex)
    itemY.push(originY + column.height)
    column.width = Math.max(column.width, size.width)
    column.height += size.height + gap
  })

  const columnX: number[] = []
  let nextX = originX
  columns.forEach((column, index) => {
    columnX[index] = nextX
    nextX += column.width + gap
  })

  return items.map((_, index) => ({
    x: columnX[itemColumns[index]],
    y: itemY[index]
  }))
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(
      target.closest(
        'input, textarea, select, button, a, [role="button"], [contenteditable="true"]'
      )
    )
}
