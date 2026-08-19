export type PaperLocatorType =
  | 'document_id'
  | 'arxiv_id'
  | 'doi'
  | 's2_paper_id'
  | 's2_corpus_id'

export const ACADEMIC_RESEARCH_TOOL_NAMES = [
  'search_arxiv',
  'get_arxiv_paper',
  'get_related_academic_papers',
  'explore_research_frontier',
  'resolve_academic_identity',
  'get_citing_papers',
  'get_referenced_papers',
  'get_semantic_recommendations'
] as const

export interface PaperLocator {
  type: PaperLocatorType
  value: string
}

export interface AcademicAuthor {
  authorId?: string
  name: string
}

export interface IdentityEvidence {
  provider: 'local' | 'arxiv' | 'semantic_scholar'
  identifier: string
  matchedBy: string
}

export interface PaperIdentity {
  canonicalId: string
  arxivId?: string
  doi?: string
  semanticScholarPaperId?: string
  semanticScholarCorpusId?: number
  title: string
  authors: AcademicAuthor[]
  year?: number
  publicationDate?: string
  abstract?: string
  venue?: string
  citationCount?: number
  referenceCount?: number
  matchStatus: 'exact' | 'verified' | 'ambiguous'
  evidence: IdentityEvidence[]
}

export interface ArxivSearchInput {
  query: string
  cursor?: string
  pageSize?: number
  sort?: 'relevance' | 'submitted_date'
  categories?: string[]
}

export interface ArxivSearchPaper {
  arxivId: string
  title: string
  authors: string[]
  abstract?: string
  publishedAt?: string
  updatedAt?: string
  categories: string[]
  doi?: string
  absUrl: string
  htmlUrl: string
  pdfUrl: string
}

export interface ArxivSearchResult {
  papers: ArxivSearchPaper[]
  total: number
  nextCursor?: string
  fetchedAt: string
  cached: boolean
}

export interface ArxivPaperSection {
  id: string
  title: string
  level: number
  start: number
  end: number
}

export interface ArxivPaperResult {
  arxivId: string
  sourceUrl: string
  sourceFormat: 'arxiv-html'
  outputFormat: 'markdown'
  title?: string
  sections: ArxivPaperSection[]
  sectionId?: string
  cursor: number
  maxChars: number
  totalChars: number
  nextCursor?: string
  contentMd: string
  conversionWarnings: string[]
  cached: boolean
}

export interface CitationEvidence {
  contexts: string[]
  intents: string[]
  isInfluential: boolean
}

export interface AcademicGraphCandidate {
  paper: PaperIdentity
  citationEvidence?: CitationEvidence
}

export interface AcademicGraphPage {
  seed: PaperIdentity
  direction: 'incoming' | 'outgoing'
  items: AcademicGraphCandidate[]
  total?: number
  nextCursor?: string
  coverage: {
    scanned: number
    total?: number
    complete: boolean
  }
  fetchedAt: string
  cached: boolean
}

export interface SemanticRecommendationResult {
  seed: PaperIdentity
  items: PaperIdentity[]
  fetchedAt: string
  cached: boolean
}

export type FrontierBranch = 'citations' | 'recommendations' | 'arxiv_recent'

export interface FrontierCandidateView {
  canonicalId: string
  arxivId?: string
  doi?: string
  semanticScholarPaperId?: string
  title: string
  authors: string[]
  publicationDate?: string
  year?: number
  abstract?: string
  discoveredBy: string[]
  citationContexts?: string[]
  citationIntents?: string[]
  isInfluential?: boolean
  graphDistance: number
  inLocalLibrary: boolean
  arxivHtmlAvailable: boolean | null
  evidenceGaps: string[]
}

export interface FrontierCoverage {
  scanned: number
  total?: number
  complete: boolean
  description?: string
}

export interface FrontierView {
  frontierId: string
  round: number
  seed: PaperIdentity
  expandedFrom: string[]
  groups: {
    citingPapers: FrontierCandidateView[]
    recommendations: FrontierCandidateView[]
    recentArxivPapers: FrontierCandidateView[]
  }
  coverage: {
    citations?: FrontierCoverage
    recommendations?: FrontierCoverage
    arxivSearch?: FrontierCoverage
  }
  nextActions: Array<{
    type: 'expand' | 'continue'
    description: string
    resumeToken?: string
  }>
  warnings: string[]
  fetchedAt: string
}
