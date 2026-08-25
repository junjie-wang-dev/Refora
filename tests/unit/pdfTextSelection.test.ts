import { afterEach, describe, expect, it } from 'vitest'
import {
  pdfTextPositionAtPoint,
  updateTextSelection
} from '../../src/renderer/utils/pdfTextSelection'

afterEach(() => {
  document.body.replaceChildren()
})

describe('PDF text selection', () => {
  it('prefers text-layer geometry when native caret hit testing returns a stale offset', () => {
    const root = document.createElement('div')
    const layer = document.createElement('div')
    const span = document.createElement('span')
    span.textContent = 'Selectable'
    layer.className = 'textLayer'
    layer.append(span)
    root.append(layer)
    document.body.append(root)
    const bounds = {
      x: 10,
      y: 20,
      left: 10,
      right: 110,
      top: 20,
      bottom: 40,
      width: 100,
      height: 20,
      toJSON: () => ({})
    }
    layer.getBoundingClientRect = () => bounds
    span.getBoundingClientRect = () => bounds
    const caretDescriptor = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: span.firstChild, offset: 0 })
    })
    const rectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        const left = 10 + this.startOffset * 10
        return [{
          ...bounds,
          x: left,
          left,
          right: left + 10,
          width: 10
        }]
      }
    })

    try {
      const position = pdfTextPositionAtPoint(root, 36, 30)
      expect(position?.node).toBe(span.firstChild)
      expect(position?.offset).toBe(3)
    } finally {
      if (caretDescriptor) {
        Object.defineProperty(document, 'caretPositionFromPoint', caretDescriptor)
      } else {
        Reflect.deleteProperty(document, 'caretPositionFromPoint')
      }
      if (rectsDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', rectsDescriptor)
      } else {
        Reflect.deleteProperty(Range.prototype, 'getClientRects')
      }
    }
  })

  it('uses proportional span geometry when character rectangles are degenerate', () => {
    const root = document.createElement('div')
    const layer = document.createElement('div')
    const staleSpan = document.createElement('span')
    const span = document.createElement('span')
    staleSpan.textContent = 'Stale'
    span.textContent = 'Selectable'
    layer.className = 'textLayer'
    layer.append(staleSpan, span)
    root.append(layer)
    document.body.append(root)
    const layerBounds = DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 40 })
    const staleBounds = DOMRect.fromRect({ x: 10, y: 10, width: 40, height: 20 })
    const bounds = DOMRect.fromRect({ x: 60, y: 10, width: 100, height: 20 })
    layer.getBoundingClientRect = () => layerBounds
    staleSpan.getBoundingClientRect = () => staleBounds
    span.getBoundingClientRect = () => bounds
    const caretDescriptor = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: staleSpan.firstChild, offset: 0 })
    })
    const rectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value() {
        return [bounds]
      }
    })

    try {
      const start = pdfTextPositionAtPoint(root, 70, 20)
      const end = pdfTextPositionAtPoint(root, 135, 20)
      expect(start?.node).toBe(span.firstChild)
      expect(start?.offset).toBe(1)
      expect(end?.node).toBe(span.firstChild)
      expect(end?.offset).toBe(8)
      updateTextSelection(start!, end!)
      expect(window.getSelection()?.toString()).toBe('electab')
    } finally {
      if (caretDescriptor) {
        Object.defineProperty(document, 'caretPositionFromPoint', caretDescriptor)
      } else {
        Reflect.deleteProperty(document, 'caretPositionFromPoint')
      }
      if (rectsDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', rectsDescriptor)
      } else {
        Reflect.deleteProperty(Range.prototype, 'getClientRects')
      }
    }
  })

  it('creates forward and reverse ranges without Selection.extend', () => {
    const text = document.createTextNode('Selectable PDF text')
    document.body.append(text)

    updateTextSelection(
      { node: text, offset: 1 },
      { node: text, offset: 10 }
    )
    expect(window.getSelection()?.toString()).toBe('electable')

    updateTextSelection(
      { node: text, offset: 10 },
      { node: text, offset: 1 }
    )
    expect(window.getSelection()?.toString()).toBe('electable')
  })
})
