import { describe, expect, it } from 'vitest'
import { createLifecycleTransitionGate } from '../../src/main/services/lifecycleTransitionGate'

describe('lifecycle transition gate', () => {
  it('waits for an active transition and rejects new work during shutdown', async () => {
    let release: () => void = () => undefined
    const pending = new Promise<void>((resolve) => { release = resolve })
    const gate = createLifecycleTransitionGate()
    const transition = gate.run(async () => {
      await pending
      return 'complete'
    })

    gate.beginShutdown()
    const idle = gate.waitForIdle()

    await expect(gate.run(async () => 'late')).rejects.toMatchObject({
      code: 'app_shutting_down'
    })
    let settled = false
    void idle.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await expect(transition).resolves.toBe('complete')
    await expect(idle).resolves.toBeUndefined()
  })

  it('reopens the gate when shutdown is cancelled', async () => {
    const gate = createLifecycleTransitionGate()
    gate.beginShutdown()
    gate.cancelShutdown()

    await expect(gate.run(async () => 'allowed')).resolves.toBe('allowed')
  })

  it('becomes idle after a failed transition', async () => {
    const gate = createLifecycleTransitionGate()
    const failure = gate.run(async () => { throw new Error('failed') })
    await expect(failure).rejects.toThrow('failed')
    gate.beginShutdown()
    await expect(gate.waitForIdle()).resolves.toBeUndefined()
  })

  it('waits for every overlapping transition that began before shutdown', async () => {
    let releaseFirst: () => void = () => undefined
    let releaseSecond: () => void = () => undefined
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const second = new Promise<void>((resolve) => { releaseSecond = resolve })
    const gate = createLifecycleTransitionGate()
    void gate.run(() => first)
    void gate.run(() => second)
    gate.beginShutdown()
    let idle = false
    void gate.waitForIdle().then(() => { idle = true })

    releaseFirst()
    await Promise.resolve()
    expect(idle).toBe(false)
    releaseSecond()
    await gate.waitForIdle()
    expect(idle).toBe(true)
  })
})
