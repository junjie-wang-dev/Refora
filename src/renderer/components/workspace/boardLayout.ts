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
