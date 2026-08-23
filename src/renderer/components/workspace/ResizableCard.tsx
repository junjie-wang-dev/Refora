import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  WORKSPACE_CARD_DEFAULT_HEIGHT,
  WORKSPACE_CARD_DEFAULT_WIDTH
} from '../../../shared/ipc-types'
import type { WorkspaceConnectionAnchor } from '../../../shared/ipc-types'

export interface CardSize {
  width: number
  height: number
}

export interface CardPosition {
  x: number
  y: number
  zIndex: number
}

interface ResizableCardProps {
  sizeKey: string
  size: CardSize
  position: CardPosition
  getScale: () => number
  frontZIndex: number
  onSizeChange: (sizeKey: string, size: CardSize) => void
  onSizeCommit: (sizeKey: string, size: CardSize) => void
  onSizeCancel?: (sizeKey: string) => void
  onPositionChange: (sizeKey: string, position: CardPosition) => void
  onPositionCommit: (sizeKey: string, position: CardPosition) => void
  onPositionCancel?: (sizeKey: string) => void
  onConnectionStart?: (
    sizeKey: string,
    anchor: WorkspaceConnectionAnchor,
    event: React.MouseEvent<HTMLButtonElement>
  ) => void
  connectionLabel?: string
  moveLabel?: string
  resizeWidthLabel?: string
  resizeHeightLabel?: string
  resizeBothLabel?: string
  children: ReactNode
  className?: string
  selected?: boolean
  canStartDrag?: () => boolean
  animatePosition?: boolean
}

type Edge = 'e' | 's' | 'se'
const DRAG_START_DISTANCE = 5

export default function ResizableCard({
  sizeKey,
  size,
  position,
  getScale,
  frontZIndex,
  onSizeChange,
  onSizeCommit,
  onSizeCancel,
  onPositionChange,
  onPositionCommit,
  onPositionCancel,
  onConnectionStart,
  connectionLabel,
  moveLabel,
  resizeWidthLabel = 'Resize card width',
  resizeHeightLabel = 'Resize card height',
  resizeBothLabel = 'Resize card',
  children,
  className = '',
  selected = false,
  canStartDrag,
  animatePosition = false
}: ResizableCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef({ x: 0, y: 0, w: 0, h: 0, edge: 'se' as Edge })
  const moveStartRef = useRef({ x: 0, y: 0, cardX: 0, cardY: 0, zIndex: 0 })
  const latestSizeRef = useRef(size)
  const latestPositionRef = useRef(position)
  const positionDirtyRef = useRef(false)
  const sizeDirtyRef = useRef(false)
  const frameRef = useRef<number | null>(null)
  const interactionCleanupRef = useRef<(() => void) | null>(null)
  const suppressClickUntilRef = useRef(0)
  const movingRef = useRef(false)
  const resizingRef = useRef(false)
  const [resizing, setResizing] = useState(false)
  const [moving, setMoving] = useState(false)

  const flushVisuals = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    const element = cardRef.current
    if (positionDirtyRef.current) {
      positionDirtyRef.current = false
      const next = latestPositionRef.current
      if (element) element.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`
      onPositionChange(sizeKey, next)
    }
    if (sizeDirtyRef.current) {
      sizeDirtyRef.current = false
      const next = latestSizeRef.current
      if (element) {
        element.style.width = `${next.width}px`
        element.style.height = `${next.height}px`
      }
      onSizeChange(sizeKey, next)
    }
  }, [onPositionChange, onSizeChange, sizeKey])

  const scheduleVisuals = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      flushVisuals()
    })
  }, [flushVisuals])

  useLayoutEffect(() => {
    latestPositionRef.current = position
    if (!movingRef.current && cardRef.current) {
      cardRef.current.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`
    }
  }, [position])

  useLayoutEffect(() => {
    latestSizeRef.current = size
    if (!resizingRef.current && cardRef.current) {
      cardRef.current.style.width = `${size.width}px`
      cardRef.current.style.height = `${size.height}px`
    }
  }, [size])

  useEffect(() => {
    return () => {
      interactionCleanupRef.current?.()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  const startPointerDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || canStartDrag?.() === false) return
    suppressClickUntilRef.current = 0
    const target = e.target as HTMLElement
    const dragClickTarget = target.closest<HTMLElement>('[data-card-drag-click]')
    const interactiveTarget = target.closest<HTMLElement>('button, a, input, textarea, select, audio, video, [contenteditable="true"], [role="button"], [role="link"], [data-card-resize]')
    if (interactiveTarget && interactiveTarget !== dragClickTarget) return
    interactionCleanupRef.current?.()
    const pointerId = e.pointerId
    const pointerTarget = dragClickTarget ?? target.closest<HTMLElement>('[data-card-kind]') ?? e.currentTarget
    moveStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      cardX: position.x,
      cardY: position.y,
      zIndex: frontZIndex
    }
    let activated = false
    let previewed = false

    const cleanup = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      if (interactionCleanupRef.current === cleanup) interactionCleanupRef.current = null
    }

    const activate = () => {
      activated = true
      try {
        pointerTarget.setPointerCapture?.(pointerId)
      } catch {
        void 0
      }
      movingRef.current = true
      setMoving(true)
      window.getSelection()?.removeAllRanges()
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const dx = ev.clientX - moveStartRef.current.x
      const dy = ev.clientY - moveStartRef.current.y
      if (dx === 0 && dy === 0) return
      if (!activated && Math.hypot(dx, dy) >= DRAG_START_DISTANCE) activate()
      ev.preventDefault()
      const scale = getScale()
      const next = {
        x: Math.round(moveStartRef.current.cardX + dx / scale),
        y: Math.round(moveStartRef.current.cardY + dy / scale),
        zIndex: activated ? moveStartRef.current.zIndex : position.zIndex
      }
      previewed = true
      latestPositionRef.current = next
      positionDirtyRef.current = true
      scheduleVisuals()
    }

    const finish = (commit: boolean) => {
      const shouldCommit = activated
      cleanup()
      if (!shouldCommit) {
        if (previewed) {
          flushVisuals()
          latestPositionRef.current = position
          if (cardRef.current) {
            cardRef.current.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`
          }
          onPositionCancel?.(sizeKey)
        }
        return
      }
      flushVisuals()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      movingRef.current = false
      setMoving(false)
      suppressClickUntilRef.current = Date.now() + 250
      if (commit) onPositionCommit(sizeKey, latestPositionRef.current)
      else if (cardRef.current) {
        latestPositionRef.current = position
        cardRef.current.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`
        onPositionCancel?.(sizeKey)
      }
    }

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(true)
    }
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(false)
    }

    interactionCleanupRef.current = cleanup
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
  }, [canStartDrag, flushVisuals, frontZIndex, getScale, onPositionCancel, onPositionCommit, position, scheduleVisuals, sizeKey])

  const startResize = useCallback(
    (edge: Edge, e: React.PointerEvent) => {
      if (e.button !== 0 || canStartDrag?.() === false) return
      e.preventDefault()
      e.stopPropagation()
      interactionCleanupRef.current?.()
      const pointerId = e.pointerId
      e.currentTarget.setPointerCapture?.(pointerId)
      resizeStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        w: size.width,
        h: size.height,
        edge
      }
      latestSizeRef.current = size
      resizingRef.current = true
      setResizing(true)

      const cleanup = () => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onCancel)
        if (interactionCleanupRef.current === cleanup) interactionCleanupRef.current = null
      }

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        const scale = getScale()
        const dx = (ev.clientX - resizeStartRef.current.x) / scale
        const dy = (ev.clientY - resizeStartRef.current.y) / scale
        let nextW = resizeStartRef.current.w
        let nextH = resizeStartRef.current.h
        if (resizeStartRef.current.edge === 'e' || resizeStartRef.current.edge === 'se') {
          nextW = Math.max(1, Math.round(resizeStartRef.current.w + dx))
        }
        if (resizeStartRef.current.edge === 's' || resizeStartRef.current.edge === 'se') {
          nextH = Math.max(1, Math.round(resizeStartRef.current.h + dy))
        }
        latestSizeRef.current = { width: nextW, height: nextH }
        sizeDirtyRef.current = true
        scheduleVisuals()
      }

      const finish = (commit: boolean) => {
        cleanup()
        flushVisuals()
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        resizingRef.current = false
        setResizing(false)
        if (commit) onSizeCommit(sizeKey, latestSizeRef.current)
        else if (cardRef.current) {
          latestSizeRef.current = size
          cardRef.current.style.width = `${size.width}px`
          cardRef.current.style.height = `${size.height}px`
          onSizeCancel?.(sizeKey)
        }
      }

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish(true)
      }
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish(false)
      }

      interactionCleanupRef.current = cleanup
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onCancel)
      document.body.style.cursor =
        edge === 'e' ? 'ew-resize' : edge === 's' ? 'ns-resize' : 'nwse-resize'
      document.body.style.userSelect = 'none'
    },
    [canStartDrag, flushVisuals, getScale, onSizeCancel, onSizeCommit, scheduleVisuals, size, sizeKey]
  )

  const moveByKeyboard = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    const step = e.shiftKey ? 50 : 10
    let next: CardPosition | null = null
    if (e.key === 'ArrowLeft') next = { x: position.x - step, y: position.y, zIndex: frontZIndex }
    if (e.key === 'ArrowRight') next = { x: position.x + step, y: position.y, zIndex: frontZIndex }
    if (e.key === 'ArrowUp') next = { x: position.x, y: position.y - step, zIndex: frontZIndex }
    if (e.key === 'ArrowDown') next = { x: position.x, y: position.y + step, zIndex: frontZIndex }
    if (!next) return
    e.preventDefault()
    latestPositionRef.current = next
    positionDirtyRef.current = true
    flushVisuals()
    onPositionCommit(sizeKey, next)
  }

  const resizeByKeyboard = (edge: Edge, e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 50 : 10
    const changesWidth = edge === 'e' || edge === 'se'
    const changesHeight = edge === 's' || edge === 'se'
    let nextWidth = latestSizeRef.current.width
    let nextHeight = latestSizeRef.current.height
    if (changesWidth && e.key === 'ArrowRight') nextWidth += step
    else if (changesWidth && e.key === 'ArrowLeft') nextWidth = Math.max(1, nextWidth - step)
    else if (changesHeight && e.key === 'ArrowDown') nextHeight += step
    else if (changesHeight && e.key === 'ArrowUp') nextHeight = Math.max(1, nextHeight - step)
    else return
    e.preventDefault()
    e.stopPropagation()
    const next = { width: nextWidth, height: nextHeight }
    latestSizeRef.current = next
    if (cardRef.current) {
      cardRef.current.style.width = `${next.width}px`
      cardRef.current.style.height = `${next.height}px`
    }
    onSizeChange(sizeKey, next)
    onSizeCommit(sizeKey, next)
  }

  return (
    <div
      ref={cardRef}
      data-workspace-card
      data-workspace-card-id={sizeKey}
      data-selected={selected || undefined}
      role="group"
      tabIndex={0}
      aria-label={moveLabel}
      title={moveLabel}
      className={`resizable-card group/card absolute ${selected ? 'is-selected' : ''} ${animatePosition ? 'is-layout-animating' : ''} ${moving ? 'is-moving cursor-grabbing' : ''} ${resizing ? 'is-resizing' : ''} ${className}`}
      onPointerDown={startPointerDrag}
      onKeyDown={moveByKeyboard}
      onClickCapture={(e) => {
        if (Date.now() >= suppressClickUntilRef.current) return
        e.preventDefault()
        e.stopPropagation()
      }}
      style={{
        left: 0,
        top: 0,
        zIndex: resizing || moving ? Math.max(position.zIndex, frontZIndex) + 100000 : position.zIndex,
        width: size.width,
        height: size.height,
        touchAction: 'none'
      }}
    >
      <div className="resizable-card-content h-full w-full">{children}</div>
      {onConnectionStart && (['top', 'right', 'bottom', 'left'] as const).map((anchor) => (
        <button
          key={anchor}
          type="button"
          data-connection-handle={anchor}
          className={`workspace-connection-handle workspace-connection-handle--${anchor}`}
          aria-label={connectionLabel}
          title={connectionLabel}
          onMouseDown={(event) => onConnectionStart(sizeKey, anchor, event)}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        />
      ))}
      <button
        type="button"
        data-card-resize
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize opacity-0 transition-opacity group-hover/card:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onPointerDown={(e) => startResize('e', e)}
        onKeyDown={(e) => resizeByKeyboard('e', e)}
        aria-label={resizeWidthLabel}
        title={resizeWidthLabel}
      />
      <button
        type="button"
        data-card-resize
        className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize opacity-0 transition-opacity group-hover/card:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onPointerDown={(e) => startResize('s', e)}
        onKeyDown={(e) => resizeByKeyboard('s', e)}
        aria-label={resizeHeightLabel}
        title={resizeHeightLabel}
      />
      <button
        type="button"
        data-card-resize
        className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize opacity-0 transition-opacity group-hover/card:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onPointerDown={(e) => startResize('se', e)}
        onKeyDown={(e) => resizeByKeyboard('se', e)}
        aria-label={resizeBothLabel}
        title={resizeBothLabel}
      >
        <span className="absolute bottom-1 right-1 h-2 w-2 rounded-sm border-b-2 border-r-2 border-muted" />
      </button>
    </div>
  )
}

export function defaultCardSize(): CardSize {
  return { width: WORKSPACE_CARD_DEFAULT_WIDTH, height: WORKSPACE_CARD_DEFAULT_HEIGHT }
}

export function clampCardSize(size: Partial<CardSize> | undefined): CardSize {
  const width = size?.width
  const height = size?.height
  return {
    width: typeof width === 'number' && Number.isFinite(width) && width > 0
      ? Math.round(width)
      : WORKSPACE_CARD_DEFAULT_WIDTH,
    height: typeof height === 'number' && Number.isFinite(height) && height > 0
      ? Math.round(height)
      : WORKSPACE_CARD_DEFAULT_HEIGHT
  }
}
