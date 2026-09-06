import type { DownloadItem } from 'electron'

type DownloadDialogItem = Pick<DownloadItem, 'getURL' | 'getFilename' | 'getSaveDialogOptions' | 'setSaveDialogOptions'>

export function configureGeneratedDownloadDialog(item: DownloadDialogItem, fallbackTitle: string): void {
  const url = item.getURL()
  if (!url.startsWith('blob:') && !/^data:image\/svg\+xml(?:;[^,]*)?,/i.test(url)) return
  const filename = [...item.getFilename()]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('').trim().slice(0, 200)
  const title = filename && !filename.startsWith('blob:') && !filename.startsWith('data:')
    ? filename : fallbackTitle
  item.setSaveDialogOptions({ ...item.getSaveDialogOptions(), title, message: title })
}
