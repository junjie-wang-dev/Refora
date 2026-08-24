import { api } from '../ipc'

interface DeletedAgentSelections {
  providerId?: string
  profileId?: string
}

export async function cleanupDeletedAgentSelections({
  providerId,
  profileId
}: DeletedAgentSelections): Promise<void> {
  const [
    activeProviderId,
    selectedProviderId,
    activeProfileId,
    selectedProfileId
  ] = await Promise.all([
    api.settings.get<string>('activeProviderId', ''),
    api.settings.get<string>('chatSelectedProviderId', ''),
    api.settings.get<string>('activeAgentProfileId', ''),
    api.settings.get<string>('chatSelectedAgentProfileId', '')
  ])
  const writes = new Map<string, string>()
  if (providerId && activeProviderId === providerId) writes.set('activeProviderId', '')
  if (providerId && selectedProviderId === providerId) writes.set('chatSelectedProviderId', '')
  if (profileId && activeProfileId === profileId) writes.set('activeAgentProfileId', '')
  if (profileId && selectedProfileId === profileId) writes.set('chatSelectedAgentProfileId', '')
  if (
    (providerId && selectedProviderId === providerId) ||
    (profileId && selectedProfileId === profileId)
  ) {
    writes.set('chatSelectedModel', '')
    writes.set('chatSelectedVariant', '')
  }
  await Promise.all([...writes].map(([key, value]) => api.settings.set(key, value)))
}
