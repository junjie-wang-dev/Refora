import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { BookOpen } from '@phosphor-icons/react'
import { api } from '../ipc'
import { errorMessage } from '../../shared/ipc-types'
import { Button } from './ui'
import { flushRendererPersistence } from '../persistence'

interface FirstRunWizardProps {
  onDone: () => void
}

export default function FirstRunWizard({ onDone }: FirstRunWizardProps) {
  const { t } = useTranslation()
  const [picking, setPicking] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleChooseLibrary = async () => {
    setPicking(true)
    setError(null)
    try {
      const path = await api.dialog.openDirectory()
      if (!path) {
        setPicking(false)
        return
      }
      setScanning(true)
      await flushRendererPersistence()
      await api.library.switch(path)
      setScanning(false)
      onDone()
    } catch (e) {
      setScanning(false)
      setError(errorMessage(e, t('wizard.setLibraryFailed')))
    }
    setPicking(false)
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog-panel flex w-80 flex-col items-center gap-4">
        <BookOpen className="h-12 w-12 text-accent" />
        <h1 className="text-base font-semibold text-foreground">
          {t('wizard.title')}
        </h1>
        <p className="text-center text-xs text-muted leading-relaxed">
          {t('wizard.description')}
        </p>
        <div className="flex w-full flex-col gap-2">
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleChooseLibrary}
            disabled={picking || scanning}
          >
            {scanning
              ? t('wizard.scanning')
              : t('wizard.chooseLibrary')}
          </Button>
        </div>
        {error && (
          <div className="w-full rounded-lg bg-error/10 px-3 py-1.5 text-xs text-error">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
