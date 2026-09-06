import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import { capturePdfPosition, resolvePdfDestination } from '../../src/renderer/utils/pdfNavigation'

const containerSize = { width: 800, height: 600 }
const current = { page: 1, x: 0.2, y: 0.4 }

function documentFixture(nativeRotation = 0) {
  const page = {
    rotate: nativeRotation,
    view: [0, 0, 600, 800],
    getViewport: vi.fn(({ rotation }: { scale: number; rotation: number }) => {
      const sideways = rotation === 90 || rotation === 270
      return {
        width: sideways ? 800 : 600,
        height: sideways ? 600 : 800,
        convertToViewportPoint: (x: number, y: number) => {
          if (rotation === 90) return [y, x]
          if (rotation === 180) return [600 - x, y]
          if (rotation === 270) return [800 - y, 600 - x]
          return [x, 800 - y]
        },
        convertToPdfPoint: (x: number, y: number) => {
          if (rotation === 90) return [y, x]
          if (rotation === 180) return [600 - x, y]
          if (rotation === 270) return [600 - y, 800 - x]
          return [x, 800 - y]
        }
      }
    })
  }
  const pdf = {
    numPages: 5,
    getPage: vi.fn().mockResolvedValue(page),
    getDestination: vi.fn().mockResolvedValue(null),
    getPageIndex: vi.fn().mockResolvedValue(2),
    cachedPageNumber: vi.fn().mockReturnValue(null)
  }
  return { page, pdf, document: pdf as unknown as PDFDocumentProxy }
}

describe('PDF destination navigation', () => {
  it.each([
    [0, 0.2, 0.25],
    [90, 0.75, 0.2],
    [180, 0.8, 0.75],
    [270, 0.25, 0.8]
  ])('converts XYZ coordinates with a native rotation of %i degrees', async (rotation, x, y) => {
    const { document } = documentFixture(rotation)
    const target = await resolvePdfDestination(document, [0, { name: 'XYZ' }, 120, 600, 1.5], 0, containerSize, current)
    expect(target).toEqual({ page: 1, x, y, scale: 1.5, zoomMode: 'custom' })
  })

  it('combines user rotation with native rotation and normalizes negative rotations', async () => {
    const { document, page } = documentFixture(90)
    expect(await resolvePdfDestination(document, [0, { name: 'XYZ' }, 120, 600, null], 90, containerSize, current)).toEqual({ page: 1, x: 0.8, y: 0.75 })
    expect(page.getViewport).toHaveBeenLastCalledWith({ scale: 1, rotation: 180 })
    expect(await resolvePdfDestination(document, [0, { name: 'XYZ' }, 120, 600, 0], -180, containerSize, current)).toEqual({ page: 1, x: 0.25, y: 0.8 })
    expect(page.getViewport).toHaveBeenLastCalledWith({ scale: 1, rotation: 270 })
  })

  it('preserves null XYZ operands in PDF axes on a sideways page', async () => {
    const { document } = documentFixture(90)
    expect(await resolvePdfDestination(document, [0, { name: 'XYZ' }, null, 600, null], 0, containerSize, current)).toEqual({ page: 1, x: 0.75, y: 0.4 })
    expect(await resolvePdfDestination(document, [0, { name: 'XYZ' }, 120, null, null], 0, containerSize, current)).toEqual({ page: 1, x: 0.2, y: 0.2 })
    expect(await resolvePdfDestination(document, [0, { name: 'XYZ' }, null, null, null], 0, containerSize, current)).toEqual(current)
  })

  it.each(['FitH', 'FitBH'])('fits width while positioning the %s destination using native rotation', async (name) => {
    const { document } = documentFixture(90)
    expect(await resolvePdfDestination(document, [0, { name }, 600], 0, containerSize, current)).toEqual({ page: 1, x: 0.75, y: 0, scale: 752 / 800, zoomMode: 'width' })
    expect(await resolvePdfDestination(document, [0, { name }, null], 0, containerSize, current)).toEqual({ ...current, scale: 752 / 800, zoomMode: 'width' })
  })

  it.each(['FitV', 'FitBV'])('fits height and honors the %s destination left coordinate', async (name) => {
    const { document } = documentFixture()
    expect(await resolvePdfDestination(document, [0, { name }, 120], 0, containerSize, current)).toEqual({ page: 1, x: 0.2, y: 0, scale: 552 / 800, zoomMode: 'custom' })
    expect(await resolvePdfDestination(document, [0, { name }, null], 0, containerSize, current)).toEqual({ ...current, scale: 552 / 800, zoomMode: 'custom' })
  })

  it.each(['Fit', 'FitB'])('fits the entire page for a %s destination', async (name) => {
    const { document } = documentFixture()
    expect(await resolvePdfDestination(document, [1, { name }], 0, containerSize, current)).toEqual({ page: 2, x: 0, y: 0, scale: 552 / 800, zoomMode: 'custom' })
  })

  it('positions and scales the whole FitR rectangle after native rotation', async () => {
    const { document } = documentFixture(90)
    const target = await resolvePdfDestination(document, [0, { name: 'FitR' }, 100, 200, 400, 600], 0, containerSize, current)
    expect(target?.page).toBe(1)
    expect(target?.x).toBe(0.25)
    expect(target?.y).toBeCloseTo(1 / 6)
    expect(target?.scale).toBeCloseTo(552 / 300)
    expect(target?.zoomMode).toBe('custom')
  })

  it('resolves a named destination and its indirect page reference', async () => {
    const { document, pdf } = documentFixture()
    const reference = { num: 17, gen: 0 }
    pdf.getDestination.mockResolvedValue([reference, { name: 'XYZ' }, 120, 600, null])
    expect(await resolvePdfDestination(document, 'methods', 0, containerSize, current)).toEqual({ page: 3, x: 0.2, y: 0.25 })
    expect(pdf.getDestination).toHaveBeenCalledWith('methods')
    expect(pdf.getPageIndex).toHaveBeenCalledWith(reference)
    expect(pdf.getPage).toHaveBeenCalledWith(3)
  })

  it('uses a cached one-based page number for an indirect reference', async () => {
    const { document, pdf } = documentFixture()
    pdf.cachedPageNumber.mockReturnValue(4)
    expect(await resolvePdfDestination(document, [{ num: 17, gen: 0 }, { name: 'Fit' }], 0, containerSize, current)).toMatchObject({ page: 4 })
    expect(pdf.getPageIndex).not.toHaveBeenCalled()
    expect(pdf.getPage).toHaveBeenCalledWith(4)
  })

  it('does not navigate when a named destination is missing', async () => {
    const { document, pdf } = documentFixture()
    expect(await resolvePdfDestination(document, 'missing', 0, containerSize, current)).toBeNull()
    expect(pdf.getPage).not.toHaveBeenCalled()
  })

  it.each([
    [],
    [-1, { name: 'Fit' }],
    [5, { name: 'Fit' }],
    [0.5, { name: 'Fit' }],
    [null, { name: 'Fit' }],
    [{ num: '17', gen: 0 }, { name: 'Fit' }],
    [{ num: 17 }, { name: 'Fit' }],
    [0, { name: 'Unknown' }],
    [0, null],
    [0, { name: 'XYZ' }, 12, 30],
    [0, { name: 'XYZ' }, '12', 30, null],
    [0, { name: 'XYZ' }, Infinity, 30, null],
    [0, { name: 'FitR' }, 0, null, 100, 100],
    [0, { name: 'Fit' }, 200]
  ])('rejects malformed or out-of-bounds explicit destination %#', async (...destination) => {
    const { document, pdf } = documentFixture()
    expect(await resolvePdfDestination(document, destination, 0, containerSize, current)).toBeNull()
    expect(pdf.getPage).not.toHaveBeenCalled()
  })

  it('rejects an empty FitR rectangle', async () => {
    const { document } = documentFixture()
    expect(await resolvePdfDestination(document, [0, { name: 'FitR' }, 100, 200, 100, 600], 0, containerSize, current)).toBeNull()
  })
})

function positionedElement(bounds: [number, number, number, number], pageNumber?: number) {
  const element = document.createElement('div')
  if (pageNumber !== undefined) element.dataset.pageNumber = String(pageNumber)
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(...bounds))
  return element
}

describe('capturePdfPosition', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('captures the exact page-relative viewport position, including horizontal scrolling', () => {
    const root = positionedElement([100, 200, 600, 500])
    root.append(positionedElement([-100, -200, 1000, 1200], 3))
    expect(capturePdfPosition(root, 3)).toEqual({ page: 3, x: 0.2, y: 1 / 3 })
  })

  it('prefers the requested page when multiple pages are visible', () => {
    const root = positionedElement([100, 200, 600, 500])
    root.append(positionedElement([120, -300, 560, 550], 3), positionedElement([120, 270, 560, 550], 4))
    expect(capturePdfPosition(root, 4)).toEqual({ page: 4, x: -20 / 560, y: -70 / 550 })
  })

  it('uses a visible page if the preferred page is outside the viewport', () => {
    const root = positionedElement([100, 200, 600, 500])
    root.append(positionedElement([100, -700, 600, 800], 1), positionedElement([100, 120, 600, 800], 2))
    expect(capturePdfPosition(root, 1)).toEqual({ page: 2, x: 0, y: 0.1 })
  })

  it('returns null when no page intersects the viewport', () => {
    const root = positionedElement([100, 200, 600, 500])
    root.append(positionedElement([100, 750, 600, 800], 2))
    expect(capturePdfPosition(root, 2)).toBeNull()
  })

  it('does not capture a page before its dimensions are known', () => {
    const root = positionedElement([100, 200, 600, 500])
    root.append(positionedElement([100, 100, 0, 800], 2))
    expect(capturePdfPosition(root, 2)).toBeNull()
  })
})
