import { ReactNode } from 'react'
import React from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from './tooltip'

interface NavItemProps {
  icon: ReactNode
  label: string
  isActive?: boolean
  showText: boolean
  onClick?: () => void
}

export const NavItem = React.memo(function NavItem({
  icon,
  label,
  isActive = false,
  showText,
  onClick,
}: NavItemProps) {
  const navContent = (
    <div
      className={`flex items-center px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 ${
        isActive
          ? 'bg-sidebar-active text-sidebar-active-text font-medium'
          : 'text-sidebar-foreground hover:text-sidebar-active-text hover:bg-white/5'
      }`}
      onClick={onClick}
    >
      <div className="w-5 flex items-center justify-center flex-shrink-0">{icon}</div>
      <span
        className={`transition-opacity duration-100 text-[13px] ${
          showText ? 'opacity-100 ml-3' : 'opacity-0 w-0 overflow-hidden'
        }`}
      >
        {label}
      </span>
    </div>
  )

  if (!showText) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{navContent}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={4} className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
    )
  }

  return navContent
})
