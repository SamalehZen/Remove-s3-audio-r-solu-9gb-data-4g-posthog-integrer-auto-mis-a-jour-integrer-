import { Button } from '@/app/components/ui/button'
import { useOnboardingStore } from '@/app/store/useOnboardingStore'
import { DomainIcon } from '@/app/components/ui/domain-icon'
import { Globe } from '@mynaui/icons-react'
import { useEffect, useState } from 'react'

interface DomainInfo {
  slug: string
  name: string
  nameFr: string | null
  icon: string
  description: string | null
  descriptionFr: string | null
}

export default function DomainSelectionContent() {
  const { incrementOnboardingStep, decrementOnboardingStep } =
    useOnboardingStore()
  const [domains, setDomains] = useState<DomainInfo[]>([])
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    window.api.domainContexts.list().then(list => {
      setDomains(list)
      setIsLoading(false)
    })
    window.api.domainContexts.getUserDomain().then(slug => {
      if (slug) setSelectedSlug(slug)
    })
  }, [])

  const handleContinue = async () => {
    if (selectedSlug) {
      await window.api.domainContexts.setUserDomain(selectedSlug)
    }
    incrementOnboardingStep()
  }

  const handleSkip = () => {
    incrementOnboardingStep()
  }

  const selectedDomain = domains.find(d => d.slug === selectedSlug)

  return (
    <div className="flex flex-row h-full w-full bg-background">
      <div className="flex flex-col w-[45%] justify-center items-start pl-24">
        <div className="flex flex-col h-full min-h-[400px] justify-between py-12">
          <div className="mt-8">
            <button
              className="mb-4 text-sm text-muted-foreground hover:underline"
              type="button"
              onClick={decrementOnboardingStep}
            >
              &lt; Back
            </button>
            <h1 className="text-3xl mb-4 mt-12">
              What do you primarily use speech for?
            </h1>
            <p className="text-sm text-muted-foreground mb-6 pr-24">
              Choose your domain to optimize transcription accuracy. You can
              change this later in settings.
            </p>
            {isLoading ? (
              <div className="text-sm text-muted-foreground">
                Loading domains...
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3 pr-24 max-h-[320px] overflow-y-auto">
                {domains.map(domain => (
                  <div
                    key={domain.slug}
                    className={`border rounded-lg p-3 cursor-pointer transition-all text-center ${
                      selectedSlug === domain.slug
                        ? 'border-purple-300 bg-purple-50 border-2'
                        : 'border-border border-2 bg-background hover:bg-gray-50'
                    }`}
                    onClick={() =>
                      setSelectedSlug(
                        selectedSlug === domain.slug ? null : domain.slug,
                      )
                    }
                  >
                    <DomainIcon
                      name={domain.icon}
                      className="w-6 h-6 mx-auto mb-1"
                    />
                    <div className="text-sm font-medium truncate">
                      {domain.name}
                    </div>
                    {domain.nameFr && (
                      <div className="text-xs text-muted-foreground truncate">
                        {domain.nameFr}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col items-start mb-8 gap-2">
            <Button
              className="w-24"
              onClick={handleContinue}
              disabled={!selectedSlug}
            >
              Continue
            </Button>
            <button
              className="text-sm text-muted-foreground hover:underline"
              type="button"
              onClick={handleSkip}
            >
              Skip — I&apos;ll set this up later
            </button>
          </div>
        </div>
      </div>
      <div className="flex w-[55%] items-center justify-center bg-gradient-to-b from-purple-50/10 to-purple-100 border-l-2 border-purple-100">
        <div className="flex flex-col items-center gap-4">
          {selectedDomain ? (
            <>
              <DomainIcon
                name={selectedDomain.icon}
                style={{ width: 220, height: 220, color: '#a78bfa' }}
              />
              <div className="text-center px-12">
                <div className="text-xl font-medium text-foreground">
                  {selectedDomain.name}
                </div>
                {selectedDomain.description && (
                  <div className="text-sm text-muted-foreground mt-2 max-w-sm">
                    {selectedDomain.description}
                  </div>
                )}
              </div>
            </>
          ) : (
            <Globe style={{ width: 220, height: 220, color: '#c4b5fd' }} />
          )}
        </div>
      </div>
    </div>
  )
}
