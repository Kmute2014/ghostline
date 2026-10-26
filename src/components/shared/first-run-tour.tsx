"use client";

import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  Check,
  ChevronRight,
  CircleDashed,
  MapPin,
  MessagesSquare,
  ShieldCheck,
  Users,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const TOUR_STEPS = [
  {
    title: 'Meet people who are online',
    description: 'The People tab shows who is around. Open a profile to learn more or start a conversation.',
    icon: Users,
    color: 'text-primary',
  },
  {
    title: 'Discover people nearby',
    description: 'Nearby helps you find local connections. Location is optional, and others see only an approximate distance.',
    icon: MapPin,
    color: 'text-sky-400',
  },
  {
    title: 'Join the conversation',
    description: 'Buzz is Hushly’s public text feed. Share a thought, react to posts, or join in with a comment.',
    icon: Zap,
    color: 'text-amber-400',
  },
  {
    title: 'Share a moment',
    description: 'Post a Story to let people know what you’re up to. Stories disappear after 24 hours.',
    icon: CircleDashed,
    color: 'text-pink-400',
  },
  {
    title: 'Keep chatting',
    description: 'Your conversations live in Chats. Choose how long each chat lasts, from 24 hours to never.',
    icon: MessagesSquare,
    color: 'text-emerald-400',
  },
  {
    title: 'Make Hushly yours',
    description: 'Visit Profile to manage your identity and preferences. You can block or report people whenever you need to.',
    icon: ShieldCheck,
    color: 'text-violet-400',
  },
]

export function FirstRunTour({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const reduced = useReducedMotion() ?? false
  const [step, setStep] = useState(0)
  const current = TOUR_STEPS[step]
  const Icon = current.icon

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-1 bg-secondary">
          <motion.div
            className="h-full bg-primary"
            initial={false}
            animate={{ width: `${((step + 1) / TOUR_STEPS.length) * 100}%` }}
            transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 32 }}
          />
        </div>

        <DialogHeader className="pt-2">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            A quick tour · {step + 1} of {TOUR_STEPS.length}
          </p>
          <div className="flex justify-center py-3" aria-hidden>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.9 }}
                transition={{ duration: reduced ? 0 : 0.2 }}
                className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20"
              >
                <Icon className={`h-8 w-8 ${current.color}`} />
              </motion.div>
            </AnimatePresence>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: reduced ? 0 : 0.18 }}
            >
              <DialogTitle className="text-center">{current.title}</DialogTitle>
              <DialogDescription className="mt-2 text-center leading-relaxed">
                {current.description}
              </DialogDescription>
            </motion.div>
          </AnimatePresence>
        </DialogHeader>

        <div className="flex justify-center gap-1.5" aria-hidden>
          {TOUR_STEPS.map((tourStep, index) => (
            <span
              key={tourStep.title}
              className={`h-1.5 rounded-full transition-all ${
                index === step ? 'w-5 bg-primary' : 'w-1.5 bg-muted-foreground/30'
              }`}
            />
          ))}
        </div>

        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Skip tour
          </Button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="outline" onClick={() => setStep((value) => value - 1)}>
                Back
              </Button>
            )}
            <Button
              onClick={() => {
                if (step === TOUR_STEPS.length - 1) onOpenChange(false)
                else setStep((value) => value + 1)
              }}
            >
              {step === TOUR_STEPS.length - 1 ? 'Done' : 'Next'}
              {step === TOUR_STEPS.length - 1 ? (
                <Check className="ml-2 h-4 w-4" aria-hidden />
              ) : (
                <ChevronRight className="ml-2 h-4 w-4" aria-hidden />
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
