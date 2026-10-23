"use client";

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Pencil, Trash2, UserPlus } from 'lucide-react'
import { api, ApiClientError } from '@/lib/client-api'
import { UserAvatar } from '@/components/shared/user-avatar'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { relativeTime } from './profile-bits'
import type { ContactDTO } from '@/lib/types'

function ContactSkeletonRow() {
  return (
    <div className="flex items-center gap-3 py-2">
      <Skeleton className="h-10 w-10 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  )
}

/**
 * Saved contacts (one-way: owner -> contact). Nicknames are private aliases
 * that only the owner ever sees.
 */
export function ContactsCard() {
  const queryClient = useQueryClient()
  const contactsQuery = useQuery({ queryKey: ['contacts'], queryFn: api.getContacts, staleTime: 15_000 })

  const [renameTarget, setRenameTarget] = useState<ContactDTO | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)

  const [removeTarget, setRemoveTarget] = useState<ContactDTO | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)

  function openRename(contact: ContactDTO) {
    setRenameTarget(contact)
    setRenameDraft(contact.nickname ?? '')
  }

  async function saveRename() {
    if (!renameTarget) return
    const cleaned = renameDraft.trim().slice(0, 40)
    if (!cleaned) {
      toast.error('Nickname cannot be empty.')
      return
    }
    setRenameBusy(true)
    try {
      await api.renameContact(renameTarget.publicId, cleaned)
      await queryClient.invalidateQueries({ queryKey: ['contacts'] })
      toast.success('Contact renamed.')
      setRenameTarget(null)
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not rename this contact.')
    } finally {
      setRenameBusy(false)
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return
    setRemoveBusy(true)
    try {
      await api.removeContact(removeTarget.publicId)
      await queryClient.invalidateQueries({ queryKey: ['contacts'] })
      toast.success(`Removed ${removeTarget.nickname ?? removeTarget.displayName} from saved contacts.`)
      setRemoveTarget(null)
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not remove this contact.')
    } finally {
      setRemoveBusy(false)
    }
  }

  const contacts = contactsQuery.data?.contacts ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-primary" aria-hidden /> Saved contacts
        </CardTitle>
        <CardDescription>
          People you saved, with private nicknames only you can see. Saved users appear in your
          friends-only stories.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {contactsQuery.isLoading ? (
          <div aria-hidden><ContactSkeletonRow /><ContactSkeletonRow /><ContactSkeletonRow /></div>
        ) : contacts.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No saved contacts yet. Save someone from a chat to give them a private nickname and
            find them again later.
          </p>
        ) : (
          <ul className="divide-y">
            {contacts.map((contact) => (
              <li key={contact.publicId} className="flex items-center gap-3 py-2.5">
                <UserAvatar
                  displayName={contact.displayName}
                  publicId={contact.publicId}
                  avatarUrl={contact.avatarUrl}
                  size={40}
                  online={contact.online}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {contact.nickname ?? contact.displayName}
                    {contact.nickname ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        ({contact.displayName})
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    Saved contact · saved {relativeTime(contact.savedAt)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => openRename(contact)}
                  aria-label={`Rename ${contact.nickname ?? contact.displayName}`}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => setRemoveTarget(contact)}
                  aria-label={`Remove ${contact.nickname ?? contact.displayName}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Rename dialog */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename contact</DialogTitle>
            <DialogDescription>
              A private alias for {renameTarget?.displayName ?? 'this person'} — they are never
              shown the nickname.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="contact-nickname">Nickname</Label>
            <Input
              id="contact-nickname"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              placeholder="e.g. Coffee friend"
              maxLength={40}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !renameBusy) void saveRename()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameTarget(null)} disabled={renameBusy}>
              Cancel
            </Button>
            <Button onClick={() => void saveRename()} disabled={renameBusy || renameDraft.trim().length === 0}>
              {renameBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Save nickname
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirm */}
      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove saved contact?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget
                ? `${removeTarget.nickname ?? removeTarget.displayName} will be removed from your saved contacts and the nickname you gave them is deleted. Existing conversations stay in your inbox.`
                : 'This contact will be removed from your saved contacts.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removeBusy}
              onClick={(e) => {
                e.preventDefault()
                void confirmRemove()
              }}
            >
              {removeBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
