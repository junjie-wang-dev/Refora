export type PersistenceFailureAction = 'retry' | 'cancel' | 'discard'

interface PersistenceGuardDeps {
  persist: () => Promise<void>
  resolveFailure: (error: unknown) => Promise<PersistenceFailureAction>
}

export async function runPersistenceGuard(
  deps: PersistenceGuardDeps
): Promise<'saved' | 'cancelled' | 'discarded'> {
  while (true) {
    try {
      await deps.persist()
      return 'saved'
    } catch (error) {
      const action = await deps.resolveFailure(error)
      if (action === 'retry') continue
      return action === 'discard' ? 'discarded' : 'cancelled'
    }
  }
}
