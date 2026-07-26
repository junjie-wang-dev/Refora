export class MainProcessError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'MainProcessError'
    this.code = code
  }
}
