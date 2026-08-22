<p align="center">
  <img src="build/icon.png" width="112" height="112" alt="Refora app icon">
</p>

<h1 align="center">Refora</h1>

<p align="center">
  <strong>Think with your literature. Discover what to research next.</strong>
</p>

<p align="center">
  Refora is an AI-native research workspace for macOS. It brings papers, annotations, evidence maps, notes, and a research agent into one continuous loop—from understanding a passage to tracing a research frontier, developing hypotheses, and turning insight into durable work.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="macOS">
  <img src="https://img.shields.io/badge/focus-AI--native_research-coral" alt="AI-native research">
  <img src="https://img.shields.io/badge/interface-English_%7C_Chinese-blue" alt="English and Chinese interface">
</p>

> [!IMPORTANT]
> Refora is still at an early stage. Its core reading, workspace, and AI research workflows are functional, but the product is evolving quickly and some features may change or remain incomplete. Treat it as an experimental research tool for now, and keep independent backups of important papers and research materials.

## Research should not end at a summary

Most AI tools meet a paper in an empty chat. You paste fragments, rebuild the context, receive a summary, and lose the useful reasoning when the conversation ends.

Refora places AI inside the research process. The agent can follow the paper open in the reader, understand the materials gathered in a workspace, search beyond them when evidence is missing, and leave its conclusions where the next round of thinking can begin.

## One continuous research loop

| Stage | What happens in Refora |
| --- | --- |
| **1. Read closely** | Read PDFs in tabs, annotate important passages, and send selected text directly to AI for explanation, synthesis, or context |
| **2. Build context** | Gather papers, Markdown notes, sticky notes, files, AI reports, and evidence connections on a visual workspace |
| **3. Explore outward** | Let the agent search your library, arXiv, citation and reference graphs, recommendations, recent research, and the public web |
| **4. Develop the idea** | Compare claims and methods, surface tensions, examine assumptions, and explore competing hypotheses against the evidence |
| **5. Make it durable** | Pin sourced reports, connect relevant cards, publish generated files, and preserve approved findings and next steps in research memory |

## What makes Refora different

### AI works inside your research context

The agent knows which paper is active, which papers were explicitly attached, and which documents belong to the current workspace. It can inspect paper metadata, cached summaries, full text, notes, reports, files, and the connections between them instead of relying on context pasted into a prompt.

### Explore the research frontier, not just a search result

Start from a paper and a research objective. Refora can run a bounded exploration across citing papers, references, Semantic Scholar recommendations, and recent arXiv work. It keeps the discovery paths separate, preserves citation evidence, and lets the agent expand the most promising branches instead of flattening everything into one opaque relevance score.

### Turn conversations into a living research space

AI can do more than answer in chat. It can add relevant papers to the board, create connections between cards, generate a structured report linked to its source papers, run calculations or data transformations in an isolated sandbox, and publish the resulting files back into the workspace.

### Keep momentum across sessions

Conversations are organized into persistent global or workspace threads. With approval, the agent can maintain concise memory for goals, terminology, decisions, findings, uncertainties, report references, and next steps—so the next conversation continues the project instead of starting over.

### See what the agent is doing

Plans, model activity, tool calls, token usage, and live progress are visible in the chat. Consequential actions such as OCR, memory updates, package installation, sandbox commands, and publishing generated files use explicit approval flows.

## Core capabilities

### Read and annotate

- Built-in tabbed PDF reader with page search, zoom, rotation, and fit-to-width controls
- Highlights, underlines, strikeouts, comments, typed text, freehand ink, erasing, annotation search, and undo
- Select any passage to summarize it, explain it, or add it directly to the current AI context
- Optional MinerU OCR converts difficult PDFs into reusable, searchable Markdown with formulas, tables, and images

### Organize knowledge visually

- Workspaces combine paper previews, AI summaries, Markdown notes, sticky notes, reports, and managed files
- Move and resize cards freely, connect related evidence, or arrange selections into stacks and grids
- Open reports and notes in focused Markdown reading and editing views
- Keep generated images, data, documents, and other research artifacts alongside the literature that produced them

### Build and search a real literature library

- Import PDFs, folders, DOI or arXiv identifiers, paper URLs, Zotero libraries, and Mendeley libraries
- Automatically pick up PDFs added to the library folder or configured watch folders
- Edit and refresh bibliographic metadata, organize categories, star papers, and track recent additions and reading
- Search across papers, workspace notes and reports, managed files, and AI conversations from one global search
- Export references as BibTeX or JSON, and export notes, reports, and conversations as Markdown

### Work with the research agent

- Search and read papers already in the library, with cached OCR preferred when available
- Search arXiv, read official arXiv paper content, follow citations and references, and fetch public web evidence
- Attach up to eight workspace papers to focus a question while retaining the broader workspace context
- Generate source-linked comparisons, surveys, and reports directly on the board
- Use API models, local Ollama models, or detected Codex and Gemini CLI agents without changing the research workflow

## Questions worth asking

- *Where do these papers genuinely disagree, and what experiment could distinguish their explanations?*
- *Which assumptions are shared across this body of work, and which one is least supported?*
- *Starting from this paper, explore the citation frontier and identify three promising research directions.*
- *Turn these annotations into competing hypotheses and list the evidence each one still needs.*
- *Build a claim–evidence map from this workspace and connect the relevant cards.*
- *Analyze this dataset alongside the selected papers and publish the results back to the workspace.*

## Data and privacy

- Your PDFs, library database, OCR output, indexes, thumbnails, conversations, and agent traces remain on your Mac.
- API keys are encrypted with the macOS Keychain and are never exposed to the renderer or the research agent.
- Paper content is sent to an external AI service only when you use a provider that requires it; local Ollama models are also supported.
- Cloud metadata synchronization is not enabled in the current build, and PDFs are outside its planned scope.

## License

The project package metadata declares the [MIT license](package.json).
