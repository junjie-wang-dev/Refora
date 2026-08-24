import { createContext, useContext, type Dispatch, type SetStateAction } from 'react'

interface SidebarVisibilityValue {
  collapsed: boolean
  setCollapsed: Dispatch<SetStateAction<boolean>>
}

const SidebarVisibilityContext = createContext<SidebarVisibilityValue>({
  collapsed: false,
  setCollapsed: () => undefined
})

export const SidebarVisibilityProvider = SidebarVisibilityContext.Provider

export function useSidebarVisibility(): SidebarVisibilityValue {
  return useContext(SidebarVisibilityContext)
}
