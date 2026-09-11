import { BookOpen, CircleNotch } from '@phosphor-icons/react'

export default function Splash() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-background">
      <BookOpen className="h-16 w-16 text-accent" aria-hidden="true" />
      <CircleNotch aria-hidden className="mt-6 h-6 w-6 animate-spin text-accent" />
    </div>
  )
}
