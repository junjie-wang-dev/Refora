import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceItem } from '@shared/ipc-types'
import {
  compactGridPlacements,
  fitContentViewport,
  DEFAULT_VIEWPORT,
  isEditableTarget
} from '@renderer/components/workspace/boardLayout'
import {
  hasFilePayload,
  hasWorkspaceDocumentPayload,
  hasWorkspaceDropPayload,
  workspaceDocumentIds,
  WORKSPACE_DOCUMENT_MIME
} from '@renderer/components/workspace/boardDrop'

function transfer(types: string[], payload = ''): DataTransfer {
  return {
    types,
    getData: vi.fn(() => payload)
  } as unknown as DataTransfer
}

describe('board layout helpers', () => {
  it('compacts cards into balanced columns from the requested origin', () => {
    const items = [
      { id: 'one' },
      { id: 'two' },
      { id: 'three' }
    ] as WorkspaceItem[]
    const sizes = new Map([
      ['one', { width: 100, height: 200 }],
      ['two', { width: 140, height: 80 }],
      ['three', { width: 120, height: 60 }]
    ])

    expect(compactGridPlacements(
      items,
      (item) => sizes.get(item.id)!,
      20,
      30
    )).toEqual([
      { x: 20, y: 30 },
      { x: 144, y: 30 },
      { x: 144, y: 134 }
    ])
  })

  it('fits negative and distant card bounds inside the available viewport', () => {
    const bounds = [
      { x: -2000, y: -800, width: 400, height: 200 },
      { x: 6000, y: 2500, width: 600, height: 800 }
    ]
    const view = fitContentViewport(bounds, 800, 600)
    expect(view.zoom).toBeLessThan(0.25)
    for (const item of bounds) {
      expect(item.x * view.zoom + view.panX).toBeGreaterThanOrEqual(31.999)
      expect(item.y * view.zoom + view.panY).toBeGreaterThanOrEqual(31.999)
      expect((item.x + item.width) * view.zoom + view.panX).toBeLessThanOrEqual(768.001)
      expect((item.y + item.height) * view.zoom + view.panY).toBeLessThanOrEqual(520.001)
    }
  })

  it('keeps small content at default scale and handles empty or hidden canvases', () => {
    const bounds = [{ x: 0, y: 0, width: 100, height: 100 }]
    expect(fitContentViewport(bounds, 800, 600).zoom).toBe(1)
    expect(fitContentViewport([], 800, 600)).toEqual(DEFAULT_VIEWPORT)
    expect(fitContentViewport(bounds, 0, 0)).toEqual(DEFAULT_VIEWPORT)
  })

  it('recognizes editable descendants', () => {
    const wrapper = document.createElement('div')
    const textarea = document.createElement('textarea')
    const span = document.createElement('span')
    wrapper.append(textarea, span)

    expect(isEditableTarget(textarea)).toBe(true)
    expect(isEditableTarget(span)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('board drop helpers', () => {
  it('distinguishes document and file payloads', () => {
    const documents = transfer([WORKSPACE_DOCUMENT_MIME])
    const files = transfer(['Files'])

    expect(hasWorkspaceDocumentPayload(documents)).toBe(true)
    expect(hasFilePayload(documents)).toBe(false)
    expect(hasFilePayload(files)).toBe(true)
    expect(hasWorkspaceDropPayload(files)).toBe(true)
  })

  it('accepts only non-empty string document ids', () => {
    const dataTransfer = transfer(
      [WORKSPACE_DOCUMENT_MIME],
      JSON.stringify(['doc-1', '', 42, 'doc-2'])
    )

    expect(workspaceDocumentIds(dataTransfer)).toEqual(['doc-1', 'doc-2'])
  })

  it('returns no document ids for malformed payloads', () => {
    expect(workspaceDocumentIds(transfer([WORKSPACE_DOCUMENT_MIME], '{'))).toEqual([])
  })
})
