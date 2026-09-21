import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'

type TabPosition = { id: string; element: HTMLElement; left: number; width: number }
type Gesture = {
  id: string
  startX: number
  pointerX: number
  grabOffset: number
  moved: boolean
  positions: TabPosition[]
  order: string[]
  frame: number
  time: number
}

export function useWorkspaceTabDrag(ids: string[], onReorder: (ids: string[]) => void) {
  const stripRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const suppressClick = useRef(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const settle = useRef<Map<string, number> | null>(null)
  const settleFrame = useRef(0)
  const latest = useRef({ ids, onReorder })
  latest.current = { ids, onReorder }

  const finish = (commit: boolean) => {
    const drag = gesture.current
    if (!drag) return
    cancelAnimationFrame(drag.frame)
    gesture.current = null
    if (!drag.moved) return
    settle.current = new Map(drag.positions.map(({ id, element }) => [id, element.getBoundingClientRect().left]))
    if (commit) latest.current.onReorder(drag.order)
    setDraggedId(null)
  }

  useLayoutEffect(() => {
    if (gesture.current) return
    const elements = stripRef.current?.querySelectorAll<HTMLElement>('[data-reader-tab-id]')
    if (!elements) return
    const previous = settle.current
    settle.current = null
    cancelAnimationFrame(settleFrame.current)
    for (const element of elements) {
      element.style.transition = 'none'
      element.style.transform = ''
      const left = previous?.get(element.dataset.readerTabId!)
      if (left !== undefined) element.style.transform = `translateX(${left - element.getBoundingClientRect().left}px)`
    }
    if (!previous) return
    stripRef.current?.getBoundingClientRect()
    settleFrame.current = requestAnimationFrame(() => {
      for (const element of elements) {
        element.style.transition = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'transform 160ms ease'
        element.style.transform = ''
      }
    })
  }, [draggedId, ids])

  useEffect(() => {
    const cancel = () => finish(false)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) {
        event.preventDefault()
        cancel()
      }
    }
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', onKeyDown)
      if (gesture.current) cancelAnimationFrame(gesture.current.frame)
      cancelAnimationFrame(settleFrame.current)
    }
  }, [])

  useEffect(() => {
    const drag = gesture.current
    if (drag && (ids.length !== drag.positions.length || drag.positions.some((item) => !ids.includes(item.id)))) finish(false)
  }, [ids])

  const update = (time: number) => {
    const drag = gesture.current
    const strip = stripRef.current
    if (!drag?.moved || !strip) return
    const bounds = strip.getBoundingClientRect()
    const elapsed = Math.min(time - drag.time, 32)
    drag.time = time
    const edge = 40
    const speed = drag.pointerX < bounds.left + edge
      ? -Math.min(1, (bounds.left + edge - drag.pointerX) / edge)
      : drag.pointerX > bounds.right - edge ? Math.min(1, (drag.pointerX - bounds.right + edge) / edge) : 0
    strip.scrollLeft += speed * elapsed * 0.65
    const source = drag.positions.find((item) => item.id === drag.id)!
    const totalWidth = drag.positions.reduce((sum, item) => sum + item.width, 0)
    const left = Math.max(0, Math.min(totalWidth - source.width, drag.pointerX - bounds.left + strip.scrollLeft - drag.grabOffset))
    const remaining = drag.positions.filter((item) => item.id !== drag.id)
    let slot = 0
    let index = 0
    for (const item of remaining) {
      if (left > slot + item.width / 2) index += 1
      slot += item.width
    }
    drag.order = remaining.map((item) => item.id)
    drag.order.splice(index, 0, drag.id)
    let offset = 0
    for (const id of drag.order) {
      const item = drag.positions.find((entry) => entry.id === id)!
      item.element.style.transform = `translateX(${(id === drag.id ? left : offset) - item.left}px)`
      offset += item.width
    }
    drag.frame = requestAnimationFrame(update)
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    const strip = stripRef.current
    if (event.button !== 0 || !strip) return
    cancelAnimationFrame(settleFrame.current)
    suppressClick.current = false
    const elements = Array.from(strip.querySelectorAll<HTMLElement>('[data-reader-tab-id]'))
    for (const element of elements) {
      element.style.transition = 'none'
      element.style.transform = ''
    }
    const bounds = strip.getBoundingClientRect()
    const positions = elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return { id: element.dataset.readerTabId!, element, left: rect.left - bounds.left + strip.scrollLeft, width: rect.width }
    })
    const source = positions.find((item) => item.id === id)!
    gesture.current = {
      id, startX: event.clientX, pointerX: event.clientX,
      grabOffset: event.clientX - bounds.left + strip.scrollLeft - source.left,
      moved: false, positions, order: ids, frame: 0, time: performance.now()
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = gesture.current
    if (!drag) return
    drag.pointerX = event.clientX
    if (drag.moved || Math.abs(event.clientX - drag.startX) < 5) return
    drag.moved = true
    suppressClick.current = true
    setDraggedId(drag.id)
    for (const item of drag.positions) {
      item.element.style.transition = item.id === drag.id || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'transform 160ms ease'
    }
    update(performance.now())
  }

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = gesture.current
    if (drag?.moved) {
      drag.pointerX = event.clientX
      cancelAnimationFrame(drag.frame)
      update(performance.now())
    }
    finish(true)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return {
    stripRef, draggedId, onPointerDown, onPointerMove, onPointerUp,
    onPointerCancel: () => finish(false),
    onClick: (select: () => void) => {
      if (suppressClick.current) suppressClick.current = false
      else select()
    }
  }
}
