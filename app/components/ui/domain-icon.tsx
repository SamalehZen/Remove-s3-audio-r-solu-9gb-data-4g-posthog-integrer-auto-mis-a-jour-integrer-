import {
  Briefcase,
  Headphones,
  AcademicHat,
  Wrench,
  Bank,
  Chat,
  Heart,
  Microphone,
  ShieldCheck,
  ChartLine,
  Code,
  Rocket,
  Globe,
} from '@mynaui/icons-react'

const iconMap: Record<string, React.ComponentType<any>> = {
  Briefcase,
  Headphones,
  AcademicHat,
  Wrench,
  Bank,
  Chat,
  Heart,
  Microphone,
  ShieldCheck,
  ChartLine,
  Code,
  Rocket,
  Globe,
  briefcase: Briefcase,
  headphones: Headphones,
  'academic-hat': AcademicHat,
  wrench: Wrench,
  bank: Bank,
  chat: Chat,
  heart: Heart,
  microphone: Microphone,
  'shield-check': ShieldCheck,
  'chart-line': ChartLine,
  code: Code,
  rocket: Rocket,
  globe: Globe,
  banknote: Bank,
  'heart-pulse': Heart,
  scales: ShieldCheck,
  'graduation-cap': AcademicHat,
  headset: Headphones,
}

export function DomainIcon({
  name,
  ...props
}: { name: string } & React.SVGProps<SVGSVGElement>) {
  const IconComponent = iconMap[name] || Globe
  return <IconComponent {...props} />
}
