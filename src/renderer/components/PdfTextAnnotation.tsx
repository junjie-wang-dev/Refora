import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { useTranslation } from 'react-i18next'
import type { PdfAnnotation, PdfRect } from '../store/pdfReaderStore'
import { pdfRectForRotation } from '../utils/pdfAnnotationSelection'

export interface PdfTextAnnotationProps {
  annotation: PdfAnnotation
  scale: number
  rotation: number
  baseSize: { width: number; height: number }
  rect: PdfRect
  selected: boolean
  editing: boolean
  active: boolean
  controlsRef?: RefObject<HTMLDivElement | null>
  interactive: boolean
  erasing: boolean
  onSelect: () => void
  onStartEditing: () => void
  onFinishEditing: () => void
  onDragStart: (event: ReactPointerEvent<Element>) => void
  onUpdate: (patch: { text?: string; fontSize?: number; color?: string }) => void
  onDelete: () => void
}

export default function PdfTextAnnotation({
  annotation,
  scale,
  rotation,
  baseSize,
  rect,
  selected,
  editing,
  active,
  controlsRef,
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
  const editingSessionRef = useRef(false)
  const composingRef = useRef(false)
  const finishCallbackRef = useRef(onFinishEditing)
  const updateCallbackRef = useRef(onUpdate)
  const annotationTextRef = useRef(annotation.text)
  finishCallbackRef.current = onFinishEditing
  updateCallbackRef.current = onUpdate
  annotationTextRef.current = annotation.text
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
      if (textareaRef.current?.contains(event.target) || controlsRef?.current?.contains(event.target)) return
      finishEditing()
    }
    const controls = controlsRef?.current
    const handleControlsBlur = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node &&
        (controls?.contains(event.relatedTarget) || textareaRef.current?.contains(event.relatedTarget))) return
      finishEditing()
    }
    document.addEventListener('pointerdown', handleOutsidePointer, true)
    controls?.addEventListener('focusout', handleControlsBlur)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer, true)
      controls?.removeEventListener('focusout', handleControlsBlur)
    }
  }, [editing, canEdit, controlsRef, finishEditing])

  useEffect(() => {
    const textarea = textareaRef.current
    return () => {
      queueMicrotask(() => {
        if (textarea && !textarea.isConnected) finishEditing(textarea)
      })
    }
  }, [finishEditing])

  const handleBlur = (relatedTarget: EventTarget | null) => {
    if (relatedTarget instanceof Node &&
      (textareaRef.current?.contains(relatedTarget) || controlsRef?.current?.contains(relatedTarget))) return
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
        } ${editing && canEdit ? 'cursor-text bg-white/90 outline-none' :
          `bg-transparent ${erasing ? 'cursor-crosshair' : 'cursor-move'} outline-none`
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
    </>
  )
}
