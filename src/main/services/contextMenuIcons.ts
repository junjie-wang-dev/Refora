import { nativeImage, type NativeImage } from 'electron'
import { contextMenuSymbols, isContextMenuIcon } from '../../shared/contextMenuIcons'

const images = new Map<string, NativeImage | undefined>()

export function contextMenuIcon(value: unknown): NativeImage | undefined {
  if (!isContextMenuIcon(value)) return undefined
  if (!images.has(value)) {
    try {
      images.set(value, nativeImage.createMenuSymbol(contextMenuSymbols[value]))
    } catch {
      images.set(value, undefined)
    }
  }
  return images.get(value)
}
