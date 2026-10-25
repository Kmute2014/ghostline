import type { SVGProps } from 'react'

export function HushlyMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect x="7" y="7" width="50" height="50" rx="16" fill="#F5F7FF" />
      <path d="M18 19H32C39.732 19 46 25.268 46 33V46" stroke="#1F2937" strokeWidth="4.5" strokeLinecap="round"/>
      <path d="M18 45L28 31L35 38L46 20" stroke="#1F2937" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="46" cy="20" r="4.2" fill="#8BB8FF" />
      <circle cx="18" cy="19" r="5.5" fill="#FFB4A2" />
      <circle cx="34" cy="47" r="5" fill="#A8D5BA" />
      <path d="M48 42C50.9 42 53.3 39.6 53.3 36.7C53.3 33.8 50.9 31.4 48 31.4C45.1 31.4 42.7 33.8 42.7 36.7C42.7 39.6 45.1 42 48 42Z" fill="#F7D9A7"/>
    </svg>
  )
}
