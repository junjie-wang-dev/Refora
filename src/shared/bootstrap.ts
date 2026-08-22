import type {
  BootstrapData,
  ColumnId,
  ListColumn,
  ListColumnState,
  SortField,
  ThemeMode,
  WindowBounds
} from './ipc-types'

const COLUMN_IDS: readonly ColumnId[] = [
  'title',
  'authors',
  'year',
  'venue',
  'addedAt',
  'filePath'
]
const COLUMN_ID_SET = new Set<string>(COLUMN_IDS)
const SORT_FIELDS = new Set<SortField>(COLUMN_IDS)

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (!finiteNumber(value) || value < minimum || value > maximum) return null
  return Math.round(value)
}

export function normalizeWindowBounds(value: unknown): WindowBounds | null {
  const candidate = record(value)
  if (!candidate) return null
  const x = boundedNumber(candidate.x, -100_000, 100_000)
  const y = boundedNumber(candidate.y, -100_000, 100_000)
  const width = boundedNumber(candidate.width, 800, 10_000)
  const height = boundedNumber(candidate.height, 500, 10_000)
  if (x === null || y === null || width === null || height === null) return null
  return {
    x,
    y,
    width,
    height,
    isMaximized: candidate.isMaximized === true
  }
}

function normalizeColumn(value: unknown): ListColumn | null {
  const candidate = record(value)
  if (!candidate || typeof candidate.id !== 'string' || !COLUMN_ID_SET.has(candidate.id)) {
    return null
  }
  const width = boundedNumber(candidate.width, 40, 2_000)
  const order = boundedNumber(candidate.order, 0, COLUMN_IDS.length - 1)
  if (width === null || order === null || typeof candidate.visible !== 'boolean') return null
  return {
    id: candidate.id as ColumnId,
    visible: candidate.visible,
    width,
    order
  }
}

export function normalizeListColumnState(value: unknown): ListColumnState | null {
  const candidate = record(value)
  if (!candidate || !Array.isArray(candidate.columns) || candidate.columns.length !== COLUMN_IDS.length) {
    return null
  }
  const columns = candidate.columns.map(normalizeColumn)
  if (columns.some((column) => column === null)) return null
  const normalizedColumns = columns as ListColumn[]
  if (
    new Set(normalizedColumns.map((column) => column.id)).size !== COLUMN_IDS.length ||
    new Set(normalizedColumns.map((column) => column.order)).size !== COLUMN_IDS.length
  ) {
    return null
  }
  const sort = record(candidate.sort)
  if (
    !sort ||
    typeof sort.field !== 'string' ||
    !SORT_FIELDS.has(sort.field as SortField) ||
    (sort.dir !== 'asc' && sort.dir !== 'desc')
  ) {
    return null
  }
  return {
    columns: normalizedColumns,
    sort: { field: sort.field as SortField, dir: sort.dir }
  }
}

export function normalizeBootstrapData(value: unknown): BootstrapData {
  const candidate = record(value) ?? {}
  const language = candidate.language === 'zh' ? 'zh' : 'en'
  const theme: ThemeMode =
    candidate.theme === 'dark' || candidate.theme === 'light' ? candidate.theme : 'system'
  return {
    language,
    theme,
    windowBounds: normalizeWindowBounds(candidate.windowBounds),
    listColumnState: normalizeListColumnState(candidate.listColumnState),
    sidebarCollapsed: candidate.sidebarCollapsed === true,
    firstRun: candidate.firstRun === true,
    libraryFolderPath:
      typeof candidate.libraryFolderPath === 'string' && candidate.libraryFolderPath.length > 0
        ? candidate.libraryFolderPath
        : null
  }
}
