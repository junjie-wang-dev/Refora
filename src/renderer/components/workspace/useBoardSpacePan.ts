import { useEffect, useRef, useState } from 'react'
import { isEditableTarget } from './boardLayout'

export default function useBoardSpacePan(active = true) {
  const [spacePressed, setSpacePressed] = useState(false)
  const spacePressedRef = useRef(false)

  useEffect(() => {
    if (!active) {
      spacePressedRef.current = false
      setSpacePressed(false)
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isEditableTarget(event.target)) return
      event.preventDefault()
      if (spacePressedRef.current) return
      spacePressedRef.current = true
      setSpacePressed(true)
    }
    const releaseSpace = (event?: Event) => {
      if (event?.type === 'keyup' && (event as KeyboardEvent).code !== 'Space') return
      if (!spacePressedRef.current) return
      spacePressedRef.current = false
      setSpacePressed(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', releaseSpace)
    window.addEventListener('blur', releaseSpace)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', releaseSpace)
      window.removeEventListener('blur', releaseSpace)
    }
  }, [active])

  return { spacePressed, spacePressedRef }
}
