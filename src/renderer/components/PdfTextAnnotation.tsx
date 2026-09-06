import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { Check, Minus, PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import type { PdfAnnotation, PdfRect } from '../store/pdfReaderStore'
import { pdfRectForRotation } from '../utils/pdfAnnotationSelection'

const COLORS = ['#f2c94c', '#6fcf97', '#56ccf2', '#bb6bd9', '#eb5757']

export interface PdfTextAnnotationProps {
  annotation: PdfAnnotation
  scale: number
  rotation: number
  baseSize: { width: number; height: number }
  rect: PdfRect
  selected: boolean
  showControls?: boolean
  editing: boolean
  active: boolean
  scrollRootRef: RefObject<HTMLDivElement | null>
  interactive: boolean
  erasing: boolean
  onSelect: () => void
  onStartEditing: () => void
  onFinishEditing: () => void
  onDragStart: (event: ReactPointerEvent<Element>) => void
  onUpdate: (patch: { text?: string; fontSize?: number; color?: string }) => void
  onDelete: () => void
}

interface ToolbarPosition {
  left: number
  top: number
  maxWidth: number
  visible: boolean
}

export default function PdfTextAnnotation({
  annotation,
  scale,
  rotation,
  baseSize,
  rect,
  selected,
  showControls = true,
  editing,
  active,
  scrollRootRef,
  interactive,
  erasing,
  onSelect,
  onStartEditing,
  onFinishEditing,
  onDragStart,
  onUpdate,
  onDelete
}: PdfTextAnnotationProps) {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const editingSessionRef = useRef(false)
  const composingRef = useRef(false)
  const finishCallbackRef = useRef(onFinishEditing)
  const updateCallbackRef = useRef(onUpdate)
  const annotationTextRef = useRef(annotation.text)
  finishCallbackRef.current = onFinishEditing
  updateCallbackRef.current = onUpdate
  annotationTextRef.current = annotation.text
  const [toolbarPosition, setToolbarPosition] = useState<ToolbarPosition | null>(null)
  const showToolbar = showControls && active && interactive && !erasing && (selected || editing)
  const canEdit = active && interactive && !erasing
  const displayRect = pdfRectForRotation(rect, rotation)
  const textWidth = rect.width * baseSize.width * scale
  const textHeight = rect.height * baseSize.height * scale
  const textTransform = rotation === 90
    ? `translateX(${textHeight}px) rotate(90deg)`
    : rotation === 180
      ? `translate(${textWidth}px, ${textHeight}px) rotate(180deg)`
      : rotation === 270
        ? `translateY(${textWidth}px) rotate(270deg)`
        : undefined

  const finishEditing = useCallback((textarea = textareaRef.current) => {
    if (!editingSessionRef.current) return
    editingSessionRef.current = false
    composingRef.current = false
    if (textarea && textarea.value !== annotationTextRef.current) {
      updateCallbackRef.current({ text: textarea.value })
    }
    finishCallbackRef.current()
  }, [])

  useLayoutEffect(() => {
    if (!editing || !canEdit) {
      if (editingSessionRef.current) finishEditing()
      return
    }
    editingSessionRef.current = true
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [editing, canEdit, finishEditing])

  useEffect(() => {
    if (!editing || !canEdit) return
    const handleOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (textareaRef.current?.contains(event.target) || toolbarRef.current?.contains(event.target)) return
      finishEditing()
    }
    document.addEventListener('pointerdown', handleOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', handleOutsidePointer, true)
  }, [editing, canEdit, finishEditing])

  useEffect(() => {
    const textarea = textareaRef.current
    return () => {
      queueMicrotask(() => {
        if (textarea && !textarea.isConnected) finishEditing(textarea)
      })
    }
  }, [finishEditing])

  const updateToolbarPosition = useCallback(() => {
    const textarea = textareaRef.current
    const toolbar = toolbarRef.current
    if (!textarea || !toolbar) return
    const anchor = textarea.getBoundingClientRect()
    const root = scrollRootRef.current?.getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportLeft = viewport?.offsetLeft ?? 0
    const viewportTop = viewport?.offsetTop ?? 0
    const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth)
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight)
    const hasRootBounds = root && root.width > 0 && root.height > 0
    const left = Math.max(viewportLeft, hasRootBounds ? root.left : viewportLeft) + 8
    const right = Math.min(viewportRight, hasRootBounds ? root.right : viewportRight) - 8
    const top = Math.max(viewportTop, hasRootBounds ? root.top : viewportTop) + 8
    const bottom = Math.min(viewportBottom, hasRootBounds ? root.bottom : viewportBottom) - 8
    const maxWidth = Math.max(0, right - left)
    const toolbarBounds = toolbar.getBoundingClientRect()
    const width = Math.min(maxWidth, toolbarBounds.width || 320)
    const height = toolbarBounds.height || 40
    const preferredTop = anchor.top - height - 8 >= top
      ? anchor.top - height - 8
      : anchor.bottom + 8
    const next = {
      left: Math.max(left, Math.min(anchor.left, right - width)),
      top: Math.max(top, Math.min(preferredTop, bottom - height)),
      maxWidth,
      visible: maxWidth > 0 && bottom > top && anchor.bottom > top &&
        anchor.top < bottom && anchor.right > left && anchor.left < right
    }
    setToolbarPosition((current) => current && current.left === next.left &&
      current.top === next.top && current.maxWidth === next.maxWidth &&
      current.visible === next.visible ? current : next)
  }, [scrollRootRef])

  useLayoutEffect(() => {
    if (!showToolbar) return
    updateToolbarPosition()
  }, [showToolbar, scale, rotation, rect, annotation.fontSize, annotation.text, updateToolbarPosition])

  useEffect(() => {
    if (!showToolbar) return
    const root = scrollRootRef.current
    const observer = new ResizeObserver(updateToolbarPosition)
    if (root) observer.observe(root)
    if (textareaRef.current) observer.observe(textareaRef.current)
    if (toolbarRef.current) observer.observe(toolbarRef.current)
    window.addEventListener('scroll', updateToolbarPosition, true)
    window.addEventListener('resize', updateToolbarPosition)
    window.visualViewport?.addEventListener('resize', updateToolbarPosition)
    window.visualViewport?.addEventListener('scroll', updateToolbarPosition)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', updateToolbarPosition, true)
      window.removeEventListener('resize', updateToolbarPosition)
      window.visualViewport?.removeEventListener('resize', updateToolbarPosition)
      window.visualViewport?.removeEventListener('scroll', updateToolbarPosition)
    }
  }, [showToolbar, scrollRootRef, updateToolbarPosition])

  const handleBlur = (relatedTarget: EventTarget | null) => {
    if (relatedTarget instanceof Node &&
      (textareaRef.current?.contains(relatedTarget) || toolbarRef.current?.contains(relatedTarget))) return
    finishEditing()
  }

  return (
    <>
      <textarea
        ref={textareaRef}
        data-annotation-id={annotation.id}
        data-text-annotation-id={annotation.id}
        data-annotation-kind="text"
        data-text-selected={selected ? 'true' : 'false'}
        data-text-editing={editing && canEdit ? 'true' : 'false'}
        value={annotation.text}
        placeholder={t('pdfReader.textPlaceholder')}
        className={`pdf-text-annotation absolute z-20 resize-none overflow-hidden border-0 p-0 text-black shadow-none ${
          active && interactive ? 'pointer-events-auto' : 'pointer-events-none'
        } ${editing && canEdit ? 'cursor-text bg-white/90 outline outline-1 outline-offset-2 outline-accent' :
          `bg-transparent ${erasing ? 'cursor-crosshair' : 'cursor-move'} ${selected ? 'outline outline-1 outline-offset-2 outline-accent' : 'outline-none'}`
        }`}
        style={{
          left: `${displayRect.x * 100}%`,
          top: `${displayRect.y * 100}%`,
          width: textWidth,
          height: textHeight,
          transform: textTransform,
          transformOrigin: 'top left',
          color: annotation.color,
          fontSize: `${(annotation.fontSize ?? 14) * scale}px`,
          lineHeight: 1.35,
          '--pdf-text-annotation-color': annotation.color
        } as CSSProperties}
        aria-label={t('pdfReader.tools.text')}
        title={!editing ? t('pdfReader.editTextHint') : undefined}
        readOnly={!editing || !canEdit}
        tabIndex={active && interactive && !erasing ? 0 : -1}
        onPointerDown={(event) => {
          event.stopPropagation()
          if (!active || !interactive) return
          if (erasing) {
            event.preventDefault()
            return
          }
          if (!editing) onDragStart(event)
        }}
        onClick={(event) => {
          event.stopPropagation()
          if (!active || !interactive) return
          if (erasing) onDelete()
          else if (!editing) onSelect()
        }}
        onDoubleClick={(event) => {
          event.stopPropagation()
          if (!canEdit || editing) return
          event.preventDefault()
          onStartEditing()
        }}
        onChange={(event) => {
          if (editing && canEdit) onUpdate({ text: event.target.value })
        }}
        onBlur={(event) => handleBlur(event.relatedTarget)}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (!canEdit || event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return
          if (!editing && (event.key === 'Enter' || event.key === 'F2')) {
            event.preventDefault()
            onStartEditing()
            return
          }
          if (!editing || (event.key !== 'Escape' && !(event.key === 'Enter' && event.metaKey))) return
          event.preventDefault()
          finishEditing()
          event.currentTarget.blur()
        }}
      />
      {showToolbar && createPortal(
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={t('pdfReader.textAnnotationToolbar')}
          data-text-annotation-toolbar={annotation.id}
          className="fixed z-50 flex w-80 flex-wrap items-center gap-1 rounded-lg border border-border bg-panel p-1.5 text-foreground shadow-lg"
          style={{
            left: toolbarPosition?.left ?? 0,
            top: toolbarPosition?.top ?? 0,
            maxWidth: toolbarPosition?.maxWidth,
            visibility: toolbarPosition?.visible ? 'visible' : 'hidden'
          }}
          onPointerDown={(event) => {
            event.stopPropagation()
            event.preventDefault()
          }}
          onBlur={(event) => handleBlur(event.relatedTarget)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              finishEditing()
            }
          }}
        >
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-hover disabled:opacity-40"
            aria-label={t('pdfReader.decreaseFontSize')}
            title={t('pdfReader.decreaseFontSize')}
            disabled={(annotation.fontSize ?? 14) <= 8}
            onClick={() => onUpdate({ fontSize: Math.max(8, (annotation.fontSize ?? 14) - 2) })}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-7 shrink-0 text-center text-xs tabular-nums" aria-label={t('pdfReader.fontSize')}>
            {annotation.fontSize ?? 14}
          </span>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-hover disabled:opacity-40"
            aria-label={t('pdfReader.increaseFontSize')}
            title={t('pdfReader.increaseFontSize')}
            disabled={(annotation.fontSize ?? 14) >= 72}
            onClick={() => onUpdate({ fontSize: Math.min(72, (annotation.fontSize ?? 14) + 2) })}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <div className="mx-1 h-4 w-px shrink-0 bg-border" />
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`h-5 w-5 shrink-0 rounded-full border-2 ${annotation.color === color ? 'border-foreground' : 'border-transparent'}`}
              style={{ background: color }}
              aria-label={`${t('pdfReader.annotationColor')} ${color}`}
              aria-pressed={annotation.color === color}
              onClick={() => onUpdate({ color })}
            />
          ))}
          <div className="mx-1 h-4 w-px shrink-0 bg-border" />
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-accent hover:bg-hover"
            aria-label={t(editing ? 'pdfReader.finishEditingText' : 'pdfReader.editText')}
            title={t(editing ? 'pdfReader.finishEditingText' : 'pdfReader.editText')}
            onClick={() => {
              if (!editing) {
                onStartEditing()
                return
              }
              finishEditing()
              if (document.activeElement === textareaRef.current) textareaRef.current?.blur()
            }}
          >
            {editing ? <Check className="h-4 w-4" /> : <PencilSimple className="h-4 w-4" />}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-error hover:bg-hover"
            aria-label={t('common.delete')}
            title={t('common.delete')}
            onClick={onDelete}
          >
            <Trash className="h-4 w-4" />
          </button>
        </div>,
        document.body
      )}
    </>
  )
}
