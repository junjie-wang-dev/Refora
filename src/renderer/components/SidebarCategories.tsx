import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, PencilSimple, Trash, CircleNotch } from '@phosphor-icons/react'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { useDocumentStore } from '../store/documentStore'
import { useConfirmStore } from '../store/confirmStore'
import type { Category } from '../../shared/ipc-types'
import { Button as UiButton, Input as UiInput } from './ui'
import { SidebarItem, SidebarSection } from './sidebarShared'
import { useCategoryDrop } from '../hooks/useCategoryDrop'
import { useInlineNamedEntityEditor } from '../hooks/useInlineNamedEntityEditor'

const categoryName = (category: Category) => category.name

export default function SidebarCategories() {
  const { t } = useTranslation()
  const showConfirm = useConfirmStore((s) => s.show)

  const categories = useDocumentStore((s) => s.categories)
  const fetchDocuments = useDocumentStore((s) => s.fetchDocuments)
  const createCategory = useDocumentStore((s) => s.createCategory)
  const renameCategory = useDocumentStore((s) => s.renameCategory)
  const deleteCategory = useDocumentStore((s) => s.deleteCategory)
  const listMode = useDocumentStore((s) => s.listMode)
  const setListMode = useDocumentStore((s) => s.setListMode)

  const { pendingCatImports, handleDragOver, handleDrop } = useCategoryDrop(fetchDocuments)

  const editor = useInlineNamedEntityEditor({
    nameOf: categoryName,
    onCreate: createCategory,
    onRename: renameCategory
  })
  const {
    creating: creatingNew,
    renamingId,
    draftName,
    setDraftName,
    newInputRef,
    renameInputRef,
    startCreate,
    startRename,
    commitCreate,
    commitRename,
    cancelCreate,
    cancelRename
  } = editor

  const handleCategoryClick = useCallback(
    (cat: Category) => {
      setListMode({ mode: 'category', categoryId: cat.id })
    },
    [setListMode]
  )

  const confirmDeleteCategory = useCallback(async (cat: Category) => {
    await deleteCategory(cat.id)
    if (listMode.mode === 'category' && listMode.categoryId === cat.id) {
      setListMode({ mode: 'all' })
    }
  }, [deleteCategory, listMode, setListMode])

  const handleDelete = useCallback(
    (cat: Category) => {
      showConfirm({
        title: t('common.delete'),
        message: t('sidebar.deleteCategoryConfirm', { name: cat.name }),
        confirmText: t('common.delete'),
        cancelText: t('common.cancel'),
        danger: true,
        onConfirm: () => void confirmDeleteCategory(cat)
      })
    },
    [t, showConfirm, confirmDeleteCategory]
  )

  const handleSectionContext = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const items: ContextMenuItem[] = [
        {
          key: 'create',
          label: t('sidebar.createCategory'),
          icon: <Plus className="h-3.5 w-3.5" />,
          onClick: startCreate,
        },
      ]
      showContextMenu(items)
    },
    [t, startCreate]
  )

  const handleItemContext = useCallback(
    (e: React.MouseEvent, cat: Category) => {
      e.preventDefault()
      e.stopPropagation()
      const items: ContextMenuItem[] = [
        {
          key: 'create',
          label: t('sidebar.createCategory'),
          icon: <Plus className="h-3.5 w-3.5" />,
          onClick: startCreate,
        },
        {
          key: 'rename',
          label: t('sidebar.renameCategory'),
          icon: <PencilSimple className="h-3.5 w-3.5" />,
          onClick: () => startRename(cat),
        },
        {
          key: 'delete',
          label: t('sidebar.deleteCategory'),
          icon: <Trash className="h-3.5 w-3.5" />,
          onClick: () => handleDelete(cat),
          danger: true,
        },
      ]
      showContextMenu(items)
    },
    [t, startCreate, startRename, handleDelete]
  )

  return (
    <SidebarSection
      title={t('sidebar.categories')}
      onContextMenu={handleSectionContext}
      action={
        <UiButton
          variant="ghost"
          size="sm"
          iconOnly
          className="no-drag -mr-1 text-muted transition-colors duration-150 hover:text-foreground"
          onClick={startCreate}
          title={t('sidebar.createCategory')}
          aria-label={t('sidebar.createCategory')}
        >
          <Plus className="h-3.5 w-3.5" />
        </UiButton>
      }
    >
      {creatingNew && (
        <UiInput
          ref={newInputRef}
          variant="outlined"
          inputSize="sm"
          className="no-drag mb-1"
          placeholder={t('sidebar.categoryName')}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void commitCreate() }
            if (e.key === 'Escape') { e.preventDefault(); cancelCreate() }
          }}
          onBlur={() => void commitCreate()}
        />
      )}
      {categories.length === 0 && !creatingNew ? (
        <div className="px-2 py-1 text-label italic text-muted">
          {t('sidebar.emptyCategories')}
        </div>
      ) : (
        categories.map((c) => {
          const isPending = pendingCatImports.has(c.id)
          const isRenaming = renamingId === c.id
          return (
            <div key={c.id} className="relative">
              {isRenaming ? (
                <UiInput
                  ref={renameInputRef}
                  variant="outlined"
                  inputSize="sm"
                  className="no-drag"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void commitRename(c) }
                    if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                  }}
                  onBlur={() => void commitRename(c)}
                />
              ) : (
                <SidebarItem
                  icon={isPending ? <CircleNotch className="h-4 w-4 animate-spin text-accent" /> : undefined}
                  label={c.name}
                  trailing={
                    <span className="shrink-0 text-[10px] tabular-nums text-muted">{c.count ?? 0}</span>
                  }
                  active={listMode.mode === 'category' && listMode.categoryId === c.id}
                  onClick={() => handleCategoryClick(c)}
                  onContextMenu={(e) => handleItemContext(e, c)}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(c.id, e)}
                />
              )}
              {isPending && !isRenaming && <div className="cat-drop-pulse absolute inset-0" />}
            </div>
          )
        })
      )}
    </SidebarSection>
  )
}
