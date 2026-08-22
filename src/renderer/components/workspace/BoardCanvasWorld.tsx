import type { ReactNode, RefObject } from 'react'
import { GridFour, Palette, Stack } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import type {
  WorkspaceConnection,
  WorkspaceConnectionAnchor,
  WorkspaceNote
} from '../../../shared/ipc-types'
import { WORKSPACE_CANVAS_DEFAULT_ZOOM } from '../../../shared/ipc-types'
import {
  connectionCurve,
  targetAnchorForPreview,
  type ConnectionPoint
} from './connectionGeometry'
import { STICKY_NOTE_COLORS } from './stickyNoteColors'

export interface BoardConnectionDraft {
  sourceItemId: string
  sourceAnchor: WorkspaceConnectionAnchor
  source: ConnectionPoint
  pointer: ConnectionPoint
}

export interface BoardConnectionPath {
  connection: WorkspaceConnection
  path: string
  midpoint: ConnectionPoint
}

export interface BoardSelectionBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface BoardCanvasWorldProps {
  worldRef: RefObject<HTMLDivElement | null>
  connectionPaths: BoardConnectionPath[]
  connectionDraft: BoardConnectionDraft | null
  connectionPreviewPathRef: RefObject<SVGPathElement | null>
  connectionGroupRefs: RefObject<Map<string, SVGGElement>>
  connectionDeleteRefs: RefObject<Map<string, HTMLButtonElement>>
  selectedConnectionId: string | null
  selectedBounds: BoardSelectionBounds | null
  selectedItemCount: number
  selectedStickyNotes: WorkspaceNote[]
  onSelectConnection: (connectionId: string) => void
  onDeleteConnection: (connectionId: string) => void
  onArrangeSelected: (mode: 'stack' | 'grid') => void
  onStickyColor: (color: WorkspaceNote['color']) => void
  children: ReactNode
}

export default function BoardCanvasWorld({
  worldRef,
  connectionPaths,
  connectionDraft,
  connectionPreviewPathRef,
  connectionGroupRefs,
  connectionDeleteRefs,
  selectedConnectionId,
  selectedBounds,
  selectedItemCount,
  selectedStickyNotes,
  onSelectConnection,
  onDeleteConnection,
  onArrangeSelected,
  onStickyColor,
  children
}: BoardCanvasWorldProps) {
  const { t } = useTranslation()

  return (
    <div
      ref={worldRef}
      className="workspace-canvas-world absolute left-0 top-0 h-px w-px origin-top-left"
      style={{ transform: `translate3d(0px, 0px, 0) scale(${WORKSPACE_CANVAS_DEFAULT_ZOOM})` }}
    >
      <svg className="pointer-events-none absolute left-0 top-0 h-px w-px overflow-visible" aria-hidden="false">
        <defs>
          <marker id="workspace-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 9 4.5 L 0 9 z" fill="var(--color-muted)" />
          </marker>
          <marker id="workspace-arrow-selected" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 9 4.5 L 0 9 z" fill="var(--color-accent)" />
          </marker>
        </defs>
        {connectionPaths.map(({ connection, path }) => {
          const selected = selectedConnectionId === connection.id
          return (
            <g
              key={connection.id}
              ref={(element) => {
                if (element) connectionGroupRefs.current.set(connection.id, element)
                else connectionGroupRefs.current.delete(connection.id)
              }}
            >
              <path
                d={path}
                fill="none"
                stroke="transparent"
                strokeWidth="16"
                style={{ pointerEvents: 'stroke' }}
                role="button"
                tabIndex={0}
                aria-label={t('workspace.connectionSelect')}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelectConnection(connection.id)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onDeleteConnection(connection.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault()
                    onDeleteConnection(connection.id)
                  }
                }}
              />
              <path
                d={path}
                fill="none"
                stroke={selected ? 'var(--color-accent)' : 'var(--color-muted)'}
                strokeOpacity={selected ? 0.9 : 0.55}
                strokeWidth={selected ? 2.5 : 2}
                markerEnd={selected ? 'url(#workspace-arrow-selected)' : 'url(#workspace-arrow)'}
                style={{ pointerEvents: 'none' }}
              />
            </g>
          )
        })}
        {connectionDraft && (() => {
          const targetAnchor = targetAnchorForPreview(connectionDraft.source, connectionDraft.pointer)
          const preview = connectionCurve(
            connectionDraft.source,
            connectionDraft.pointer,
            connectionDraft.sourceAnchor,
            targetAnchor
          )
          return (
            <path
              ref={connectionPreviewPathRef}
              d={preview.path}
              fill="none"
              stroke="var(--color-muted)"
              strokeOpacity="0.65"
              strokeWidth="2"
              strokeDasharray="7 6"
              markerEnd="url(#workspace-arrow)"
            />
          )
        })()}
      </svg>
      {children}
      {selectedBounds && (
        <div
          data-selection-toolbar
          className="absolute z-[300000] flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-panel/95 p-1 shadow-lg backdrop-blur"
          style={{
            left: (selectedBounds.minX + selectedBounds.maxX) / 2,
            top: selectedBounds.maxY + 12
          }}
          role="toolbar"
          aria-label={t('workspace.selectionActions')}
        >
          <span
            className="flex h-7 min-w-7 items-center justify-center rounded-lg bg-background px-2 text-xs tabular-nums text-muted"
            aria-label={t('workspace.selectionCount')}
          >
            {selectedItemCount}
          </span>
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-foreground hover:bg-background disabled:cursor-default disabled:opacity-40"
            disabled={selectedItemCount < 2}
            onClick={() => onArrangeSelected('stack')}
            aria-label={t('workspace.selectionStack')}
            title={t('workspace.selectionStack')}
          >
            <Stack className="h-3.5 w-3.5" />
            {t('workspace.selectionStack')}
          </button>
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-foreground hover:bg-background disabled:cursor-default disabled:opacity-40"
            disabled={selectedItemCount < 2}
            onClick={() => onArrangeSelected('grid')}
            aria-label={t('workspace.selectionGrid')}
            title={t('workspace.selectionGrid')}
          >
            <GridFour className="h-3.5 w-3.5" />
            {t('workspace.selectionGrid')}
          </button>
          {selectedStickyNotes.length > 0 && (
            <>
              <div className="mx-0.5 h-5 w-px bg-border" />
              <Palette
                className="mx-1 h-3.5 w-3.5 text-muted"
                aria-label={t('workspace.stickyColor')}
              />
              {STICKY_NOTE_COLORS.map((option) => {
                const active = selectedStickyNotes.every((note) => (note.color ?? 'sand') === option.id)
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`h-5 w-5 rounded-full border transition-transform hover:scale-110 ${active ? 'border-accent ring-2 ring-accent/30' : 'border-black/10'}`}
                    style={{ backgroundColor: option.value }}
                    onClick={() => onStickyColor(option.id)}
                    aria-label={t(`workspace.stickyColor${option.label}`)}
                    title={t(`workspace.stickyColor${option.label}`)}
                  />
                )
              })}
            </>
          )}
        </div>
      )}
      {selectedConnectionId && connectionPaths.map(({ connection, midpoint }) => (
        connection.id === selectedConnectionId && (
          <button
            key={connection.id}
            ref={(element) => {
              if (element) connectionDeleteRefs.current.set(connection.id, element)
              else connectionDeleteRefs.current.delete(connection.id)
            }}
            type="button"
            className="absolute z-[200003] flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-panel text-sm leading-none text-muted shadow-md hover:border-error hover:text-error"
            style={{ left: midpoint.x, top: midpoint.y }}
            aria-label={t('workspace.connectionDelete')}
            title={t('workspace.connectionDelete')}
            onClick={() => onDeleteConnection(connection.id)}
          >
            ×
          </button>
        )
      ))}
    </div>
  )
}
