import workspaceMenuIcons from '../assets/workspaceMenuIcons'
import { nativeImage, type NativeImage } from 'electron'
import { isContextMenuIcon } from '../../shared/contextMenuIcons'

const images = new Map<string, NativeImage | undefined>()

export function contextMenuIcon(value: unknown): NativeImage | undefined {
  if (!isContextMenuIcon(value)) return undefined
  if (!images.has(value)) {
    try {
      const icon = nativeImage.createEmpty()
      for (const representation of workspaceMenuIcons[value]) {
        icon.addRepresentation(representation)
      }
      icon.setTemplateImage(true)
      images.set(value, icon)
    } catch {
      images.set(value, undefined)
    }
  }
  return images.get(value)
}
