import { useEffect, useState } from 'react'
import { DomainIcon } from './domain-icon'

interface DomainInfo {
  slug: string
  name: string
  nameFr: string | null
  icon: string
  description: string | null
  descriptionFr: string | null
}

interface DomainSelectorProps {
  selectedSlug: string | null
  onSelect: (slug: string | null) => void
}

export function DomainSelector({ selectedSlug, onSelect }: DomainSelectorProps) {
  const [domains, setDomains] = useState<DomainInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    window.api.domainContexts.list().then(list => {
      setDomains(list)
      setIsLoading(false)
    })
  }, [])

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading domains...</div>

  return (
    <div className="grid grid-cols-3 gap-3">
      {domains.map(domain => (
        <div
          key={domain.slug}
          className={`border rounded-lg p-3 cursor-pointer transition-all text-center ${
            selectedSlug === domain.slug
              ? 'border-purple-300 bg-purple-50 border-2 shadow-sm'
              : 'border-[var(--border)] border bg-white hover:bg-gray-50'
          }`}
          onClick={() => onSelect(selectedSlug === domain.slug ? null : domain.slug)}
        >
          <DomainIcon name={domain.icon} className="w-6 h-6 mx-auto mb-1" />
          <div className="text-sm font-medium truncate">{domain.name}</div>
          {domain.nameFr && (
            <div className="text-xs text-muted-foreground truncate">{domain.nameFr}</div>
          )}
        </div>
      ))}
    </div>
  )
}
