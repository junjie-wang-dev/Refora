import { describe, expect, it, vi } from 'vitest'
import { configureGeneratedDownloadDialog } from '../../src/main/services/downloadDialog'

function item(filename = 'Mermaid diagram.png', url = 'blob:http://localhost:5173/private-token') {
  return {
    getURL: () => url,
    getFilename: () => filename,
    getSaveDialogOptions: () => ({ defaultPath: '/tmp/diagram.png', filters: [{ name: 'PNG', extensions: ['png'] }] }),
    setSaveDialogOptions: vi.fn()
  }
}

describe('generated download dialog', () => {
  it('uses the exported filename while preserving the destination and file filters', () => {
    const download = item()
    configureGeneratedDownloadDialog(download, 'Save file')
    expect(download.setSaveDialogOptions).toHaveBeenCalledWith({
      ...download.getSaveDialogOptions(), title: 'Mermaid diagram.png', message: 'Mermaid diagram.png'
    })
  })

  it.each(['', 'blob:http://localhost:5173/token', 'data:image/png;base64,secret'])('uses the localized fallback for missing or generated filename %s', (filename) => {
    const download = item(filename)
    configureGeneratedDownloadDialog(download, '保存文件')
    expect(download.setSaveDialogOptions).toHaveBeenCalledWith(expect.objectContaining({ title: '保存文件', message: '保存文件' }))
  })

  it('removes control characters from the dialog title', () => {
    const download = item('Figure\n1.png')
    configureGeneratedDownloadDialog(download, 'Save file')
    expect(download.setSaveDialogOptions).toHaveBeenCalledWith(expect.objectContaining({ title: 'Figure1.png' }))
  })

  it.each(['data:image/svg+xml;charset=utf-8,%3Csvg%3E', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/svg+xml,%3Csvg%3E'])('uses the filename for generated SVG downloads: %s', (url) => {
    const download = item('diagram.svg', url)
    configureGeneratedDownloadDialog(download, 'Save file')
    expect(download.setSaveDialogOptions).toHaveBeenCalledWith(expect.objectContaining({ title: 'diagram.svg', message: 'diagram.svg' }))
  })

  it.each(['data:image/svg+xml-malicious,content', 'data:text/html,%3Csvg%3E'])('does not change unrelated data formats: %s', (url) => {
    const download = item('file', url)
    configureGeneratedDownloadDialog(download, 'Save file')
    expect(download.setSaveDialogOptions).not.toHaveBeenCalled()
  })

  it('does not change ordinary network downloads', () => {
    const download = item('paper.pdf', 'https://example.com/paper.pdf')
    configureGeneratedDownloadDialog(download, 'Save file')
    expect(download.setSaveDialogOptions).not.toHaveBeenCalled()
  })
})
