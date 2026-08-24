declare module '*/server-sidecar-integrity.mjs' {
  export function canonicalTreeSha256(directory: string): Promise<string>
}
