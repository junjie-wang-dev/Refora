import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentInterrupt,
  AgentInterruptAction,
  AgentInterruptDecision
} from '../../../shared/ipc-types'
import { api } from '../../ipc'
import { Button as UiButton } from '../ui'

interface AgentApprovalCardProps {
  interrupt: AgentInterrupt
  activeWorkspaceId: string | null
  streaming: boolean
  onResolve: (
    decision: AgentInterruptDecision,
    editedActions?: Array<{ name: string; args: Record<string, unknown> }>
  ) => Promise<void>
}

type TFunc = ReturnType<typeof useTranslation>['t']

const MEMORY_PATHS = [
  '/brief.md',
  '/preferences.md',
  '/decisions.md',
  '/glossary.md',
  '/research.md'
] as const

const MEMORY_SECTION_KEYS: Record<typeof MEMORY_PATHS[number], string> = {
  '/brief.md': 'workspace.chat.approvalMemoryBrief',
  '/preferences.md': 'workspace.chat.approvalMemoryPreferences',
  '/decisions.md': 'workspace.chat.approvalMemoryDecisions',
  '/glossary.md': 'workspace.chat.approvalMemoryGlossary',
  '/research.md': 'workspace.chat.approvalMemoryResearch'
}

const MEMORY_SECTION_FALLBACKS: Record<typeof MEMORY_PATHS[number], string> = {
  '/brief.md': 'goals and context',
  '/preferences.md': 'preferences',
  '/decisions.md': 'confirmed decisions',
  '/glossary.md': 'glossary',
  '/research.md': 'research progress'
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function memoryPath(value: unknown): typeof MEMORY_PATHS[number] {
  return MEMORY_PATHS.includes(value as typeof MEMORY_PATHS[number])
    ? value as typeof MEMORY_PATHS[number]
    : '/brief.md'
}

function memorySectionLabel(path: typeof MEMORY_PATHS[number], t: TFunc): string {
  return t(MEMORY_SECTION_KEYS[path], MEMORY_SECTION_FALLBACKS[path])
}

interface ApprovalDetail {
  label: string
  values: string[]
}

interface ApprovalCopy {
  name: string
  description: string
  details: ApprovalDetail[]
}

function packageNames(value: unknown, t: TFunc): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const name = stringValue((entry as Record<string, unknown>).name).trim()
    if (!name) return []
    const version = stringValue((entry as Record<string, unknown>).version).trim()
    return [version
      ? t('workspace.chat.approvalPackageWithVersion', {
          name,
          version,
          defaultValue: '{{name}} (version {{version}})'
        })
      : t('workspace.chat.approvalPackageWithoutVersion', {
          name,
          defaultValue: '{{name}} (version not specified)'
        })]
  })
}

function friendlyArgumentValue(value: unknown, t: TFunc): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [t('workspace.chat.approvalValueEmptyList', 'None')]
    }
    return value.flatMap((item) => friendlyArgumentValue(item, t))
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      return [t('workspace.chat.approvalValueEmptyList', 'None')]
    }
    return [entries.map(([key, nested]) => {
      const formatted = friendlyArgumentValue(nested, t).join(', ')
      return `${key}: ${formatted}`
    }).join(' · ')]
  }
  if (value === null || value === undefined || value === '') {
    return [t('workspace.chat.approvalValueNotSet', 'Not set')]
  }
  if (typeof value === 'boolean') {
    return [value
      ? t('workspace.chat.approvalValueYes', 'Yes')
      : t('workspace.chat.approvalValueNo', 'No')]
  }
  return [String(value)]
}

function additionalArgumentDetails(
  args: Record<string, unknown>,
  consumed: ReadonlySet<string>,
  t: TFunc
): ApprovalDetail[] {
  return Object.entries(args).flatMap(([key, value]) => consumed.has(key)
    ? []
    : [{
        label: t('workspace.chat.approvalAdditionalParameter', {
          parameter: key,
          defaultValue: 'Additional setting: {{parameter}}'
        }),
        values: friendlyArgumentValue(value, t)
      }]
  )
}

function installDetails(action: AgentInterruptAction, t: TFunc): ApprovalDetail[] {
  const python = packageNames(action.args.python, t)
  const node = packageNames(action.args.node, t)
  const runtimes = new Set(stringArray(action.args.runtimes))
  if (python.length > 0) runtimes.add('python')
  if (node.length > 0) runtimes.add('node')
  const runtimeNames = [...runtimes].map((runtime) => {
    if (runtime === 'python') {
      return t('workspace.chat.approvalRuntimePython', 'Python 3.12')
    }
    if (runtime === 'node') {
      return t('workspace.chat.approvalRuntimeNode', 'Node.js 24')
    }
    return runtime
  })
  const details: ApprovalDetail[] = []
  if (runtimeNames.length > 0) {
    details.push({
      label: t(
        'workspace.chat.approvalRuntimeList',
        'Runtime environments to install if missing'
      ),
      values: runtimeNames
    })
  }
  if (python.length > 0) {
    details.push({
      label: t('workspace.chat.approvalPythonPackageList', 'Python packages to install'),
      values: python
    })
  }
  if (node.length > 0) {
    details.push({
      label: t('workspace.chat.approvalNodePackageList', 'Node.js packages to install'),
      values: node
    })
  }
  if (details.length === 0) {
    details.push({
      label: t('workspace.chat.approvalInstallItemList', 'Items requested'),
      values: [t('workspace.chat.approvalNoInstallItems', 'No runtimes or packages were provided.')]
    })
  }
  return [
    ...details,
    ...additionalArgumentDetails(action.args, new Set(['runtimes', 'python', 'node']), t)
  ]
}

function actionCopy(
  action: AgentInterruptAction,
  t: TFunc,
  documentTitles: Record<string, string>,
  activeWorkspaceId: string | null
): ApprovalCopy {
  if (action.name === 'prepare_paper_ocr') {
    const docId = stringValue(action.args.docId)
    const title = documentTitles[docId]
    const paper = title
      ? t('workspace.chat.approvalPaperTitle', {
          title,
          defaultValue: '“{{title}}”'
        })
      : t('workspace.chat.approvalPaperFallbackWithId', {
          docId,
          defaultValue: 'the paper with document ID {{docId}}'
        })
    return {
      name: t('workspace.chat.approvalPrepareOcr', 'Run paper OCR'),
      description: t('workspace.chat.approvalPrepareOcrDescription', {
        paper,
        defaultValue:
          'The Agent wants to run OCR on {{paper}} to extract its text, formulas, and tables more accurately.'
      }),
      details: [
        {
          label: t('workspace.chat.approvalPaperTarget', 'Paper'),
          values: [paper]
        },
        {
          label: t('workspace.chat.approvalOcrMethod', 'Processing method'),
          values: [t(
            'workspace.chat.approvalOcrMethodBalanced',
            'Local OCR in balanced mode'
          )]
        },
        ...additionalArgumentDetails(action.args, new Set(['docId']), t)
      ]
    }
  }
  if (action.name === 'install_runtime_packages') {
    return {
      name: t('workspace.chat.approvalInstallPackages', 'Install runtime packages'),
      description: t(
        'workspace.chat.approvalInstallPackagesDescription',
        'The Agent wants to install the following runtime environments and packages in the current sandbox to complete this task.'
      ),
      details: installDetails(action, t)
    }
  }
  if (action.name === 'publish_workspace_artifacts') {
    const paths = stringArray(action.args.paths)
    const details: ApprovalDetail[] = [{
      label: t('workspace.chat.approvalArtifactPathList', 'Files to publish'),
      values: paths.length > 0
        ? paths
        : [t('workspace.chat.approvalNoArtifactPaths', 'No files were provided.')]
    }]
    const x = action.args.x
    const y = action.args.y
    if (x !== undefined || y !== undefined) {
      details.push({
        label: t('workspace.chat.approvalArtifactPlacement', 'Requested canvas position'),
        values: [
          t('workspace.chat.approvalArtifactCoordinates', {
            x: x === undefined
              ? t('workspace.chat.approvalValueAutomatic', 'automatic')
              : String(x),
            y: y === undefined
              ? t('workspace.chat.approvalValueAutomatic', 'automatic')
              : String(y),
            defaultValue: 'x: {{x}}, y: {{y}}'
          })
        ]
      })
    }
    details.push(
      ...additionalArgumentDetails(action.args, new Set(['paths', 'x', 'y']), t)
    )
    return {
      name: t('workspace.chat.approvalPublishArtifacts', 'Publish generated files'),
      description: activeWorkspaceId
        ? t('workspace.chat.approvalPublishArtifactsDescription', {
            count: paths.length,
            defaultValue:
              'The Agent wants to publish the following {{count}} generated files to the current workspace as file cards you can view and use.'
          })
        : t('workspace.chat.approvalPublishArtifactsNoWorkspace', {
            count: paths.length,
            defaultValue:
              'The Agent wants to publish the following {{count}} generated files, but no workspace is selected, so they will remain in the Agent sandbox.'
          }),
      details
    }
  }
  if (action.name === 'propose_workspace_memory_update') {
    const path = memoryPath(action.args.path)
    const scope = activeWorkspaceId
      ? t('workspace.chat.approvalCurrentWorkspace', 'the current workspace')
      : t('workspace.chat.approvalGlobalMemory', 'global')
    return {
      name: t('workspace.chat.approvalUpdateMemory', 'Update Agent memory'),
      description: t('workspace.chat.approvalUpdateMemoryDescription', {
        scope,
        section: memorySectionLabel(path, t),
        defaultValue:
          'The Agent wants to save the following information under “{{section}}” in {{scope}} memory for future conversations.'
      }),
      details: additionalArgumentDetails(
        action.args,
        new Set(['path', 'content', 'rationale']),
        t
      )
    }
  }
  return {
    name: t('workspace.chat.approvalOtherAction', 'Continue with an Agent action'),
    description: t('workspace.chat.approvalOtherActionDescription', {
      action: action.name,
      defaultValue: 'The Agent wants to perform “{{action}}”. Please confirm whether it may continue.'
    }),
    details: additionalArgumentDetails(action.args, new Set(), t)
  }
}

export default function AgentApprovalCard({
  interrupt,
  activeWorkspaceId,
  streaming,
  onResolve
}: AgentApprovalCardProps) {
  const { t } = useTranslation()
  const [drafts, setDrafts] = useState<Array<Record<string, unknown>>>([])
  const [documentTitles, setDocumentTitles] = useState<Record<string, string>>({})
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    setDrafts(interrupt.actions.map((action) => ({ ...action.args })))
    setValidationError(null)
  }, [interrupt.id])

  useEffect(() => {
    const docIds = [...new Set(interrupt.actions.flatMap((action) => {
      if (action.name !== 'prepare_paper_ocr') return []
      const docId = stringValue(action.args.docId).trim()
      return docId ? [docId] : []
    }))]
    setDocumentTitles({})
    if (docIds.length === 0) return
    let cancelled = false
    void Promise.all(docIds.map(async (docId) => {
      try {
        const document = await api.documents.get(docId)
        return [docId, document?.title ?? document?.fileName ?? ''] as const
      } catch {
        return [docId, ''] as const
      }
    })).then((entries) => {
      if (cancelled) return
      setDocumentTitles(Object.fromEntries(entries.filter(([, title]) => title.trim().length > 0)))
    })
    return () => {
      cancelled = true
    }
  }, [interrupt.id])

  const memoryOptions = useMemo(
    () => MEMORY_PATHS.filter((path) => activeWorkspaceId || path !== '/research.md'),
    [activeWorkspaceId]
  )
  const canEditAll = interrupt.actions.every((action) =>
    action.allowedDecisions.includes('edit')
  )

  const updateDraft = (index: number, patch: Record<string, unknown>): void => {
    setDrafts((current) => current.map((draft, draftIndex) =>
      draftIndex === index ? { ...draft, ...patch } : draft
    ))
    setValidationError(null)
  }

  const approve = (): void => {
    const changed = canEditAll && interrupt.actions.some(
      (action, index) => JSON.stringify(action.args) !== JSON.stringify(drafts[index])
    )
    if (!changed) {
      void onResolve('approve')
      return
    }
    for (let index = 0; index < interrupt.actions.length; index++) {
      if (interrupt.actions[index].name !== 'propose_workspace_memory_update') continue
      const draft = drafts[index] ?? {}
      if (!stringValue(draft.rationale).trim()) {
        setValidationError(t(
          'workspace.chat.approvalMemoryRationaleRequired',
          'Explain briefly why this information should be remembered.'
        ))
        return
      }
    }
    void onResolve(
      'edit',
      interrupt.actions.map((action, index) => ({
        name: action.name,
        args: drafts[index] ?? action.args
      }))
    )
  }

  const hasEditedDraft = canEditAll && interrupt.actions.some(
    (action, index) => JSON.stringify(action.args) !== JSON.stringify(drafts[index])
  )

  return (
    <div
      className="shrink-0 pb-3"
      style={{ paddingInline: 'clamp(12px, 7cqi, 64px)' }}
    >
      <div
        className="mx-auto w-full max-w-[768px] rounded-xl border border-accent bg-panel px-5 py-4 text-foreground shadow-sm"
        data-testid="agent-approval-card"
      >
        <div className="text-sm font-semibold">
          {t('workspace.chat.approvalRequired', 'Approval required')}
        </div>
        <div className="mt-3 max-h-[40vh] space-y-4 overflow-y-auto pr-1">
          {interrupt.actions.map((action, index) => {
            const copy = actionCopy(action, t, documentTitles, activeWorkspaceId)
            const draft = drafts[index] ?? action.args
            const isMemoryUpdate = action.name === 'propose_workspace_memory_update'
            return (
              <div key={`${action.name}-${index}`} className="space-y-3">
                <div>
                  <div className="text-sm font-medium">{copy.name}</div>
                  <p className="mt-1 text-xs leading-5 text-muted">{copy.description}</p>
                </div>
                {copy.details.length > 0 && (
                  <dl className="grid gap-3 rounded-lg border border-border bg-panel p-3">
                    {copy.details.map((detail) => (
                      <div key={detail.label} className="grid gap-1">
                        <dt className="text-xs font-medium text-foreground">
                          {detail.label}
                        </dt>
                        <dd className="text-xs leading-5 text-muted">
                          <ul className="list-disc space-y-0.5 pl-4">
                            {detail.values.map((value, valueIndex) => (
                              <li
                                key={`${detail.label}-${valueIndex}`}
                                className="break-all"
                              >
                                {value}
                              </li>
                            ))}
                          </ul>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {isMemoryUpdate && (
                  <div className="grid gap-3 rounded-lg border border-border p-3">
                    <label className="grid gap-1 text-xs font-medium">
                      <span>{t('workspace.chat.approvalMemorySection', 'Save under')}</span>
                      <select
                        className="h-9 rounded-lg border border-border bg-background px-3 text-xs text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                        value={memoryPath(draft.path)}
                        disabled={!canEditAll}
                        onChange={(event) => updateDraft(index, { path: event.target.value })}
                      >
                        {memoryOptions.map((path) => (
                          <option key={path} value={path}>
                            {memorySectionLabel(path, t)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs font-medium">
                      <span>{t('workspace.chat.approvalMemoryContent', 'Information to remember')}</span>
                      <textarea
                        className="min-h-24 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs font-normal leading-5 text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                        value={stringValue(draft.content)}
                        maxLength={16_384}
                        disabled={!canEditAll}
                        onChange={(event) => updateDraft(index, { content: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1 text-xs font-medium">
                      <span>{t('workspace.chat.approvalMemoryRationale', 'Why remember this')}</span>
                      <textarea
                        className="min-h-16 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs font-normal leading-5 text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                        value={stringValue(draft.rationale)}
                        maxLength={1000}
                        disabled={!canEditAll}
                        onChange={(event) => updateDraft(index, { rationale: event.target.value })}
                      />
                    </label>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {validationError && (
          <p className="mt-3 text-xs text-error">{validationError}</p>
        )}
        <div className="mt-4 flex justify-end gap-3">
          <UiButton
            variant="ghost"
            size="md"
            className="min-w-20 text-foreground hover:bg-hover active:bg-active"
            disabled={streaming}
            onClick={() => void onResolve('reject')}
          >
            {t('workspace.chat.rejectAction', 'Reject')}
          </UiButton>
          <UiButton
            variant="primary"
            size="md"
            className="min-w-20"
            disabled={streaming}
            onClick={approve}
          >
            {hasEditedDraft
              ? t('workspace.chat.applyEditAction', 'Save and approve')
              : t('workspace.chat.approveAction', 'Approve')}
          </UiButton>
        </div>
      </div>
    </div>
  )
}
