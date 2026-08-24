import { useCallback, useEffect, useRef, useState } from 'react'

interface NamedEntity {
  id: string
}

interface InlineNamedEntityEditorOptions<T extends NamedEntity> {
  nameOf: (entity: T) => string
  onCreate: (name: string) => Promise<unknown>
  onRename: (id: string, name: string) => Promise<unknown>
}

export function useInlineNamedEntityEditor<T extends NamedEntity>({
  nameOf,
  onCreate,
  onRename
}: InlineNamedEntityEditorOptions<T>) {
  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const newInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const submittingRef = useRef(false)

  const reset = useCallback(() => {
    setCreating(false)
    setRenamingId(null)
    setDraftName('')
  }, [])

  const startCreate = useCallback(() => {
    setDraftName('')
    setRenamingId(null)
    setCreating(true)
  }, [])

  const startRename = useCallback((entity: T) => {
    setDraftName(nameOf(entity))
    setCreating(false)
    setRenamingId(entity.id)
  }, [nameOf])

  const commitCreate = useCallback(async () => {
    if (submittingRef.current) return
    const name = draftName.trim()
    if (!name) {
      reset()
      return
    }
    submittingRef.current = true
    try {
      await onCreate(name)
      reset()
    } finally {
      submittingRef.current = false
    }
  }, [draftName, onCreate, reset])

  const commitRename = useCallback(async (entity: T) => {
    if (submittingRef.current) return
    const name = draftName.trim()
    submittingRef.current = true
    try {
      if (name && name !== nameOf(entity)) await onRename(entity.id, name)
      reset()
    } finally {
      submittingRef.current = false
    }
  }, [draftName, nameOf, onRename, reset])

  useEffect(() => {
    if (creating) newInputRef.current?.focus()
  }, [creating])

  useEffect(() => {
    if (!renamingId) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renamingId])

  return {
    creating,
    renamingId,
    draftName,
    setDraftName,
    newInputRef,
    renameInputRef,
    startCreate,
    startRename,
    commitCreate,
    commitRename,
    cancelCreate: reset,
    cancelRename: reset
  }
}
