"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Globe2,
  ImageIcon,
  Loader2,
  Lock,
  RotateCw,
  Send,
  Type,
  Video,
  type LucideIcon,
} from 'lucide-react'
import { api, ApiClientError } from '@/lib/client-api'
import { useAppStore } from '@/store/app-store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type StoryKind = 'text' | 'image' | 'video'
type StoryAudience = 'public' | 'friends'

const MAX_TEXT_CHARS = 500
const MAX_CAPTION_CHARS = 200
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024

const KINDS: { value: StoryKind; label: string; icon: LucideIcon }[] = [
  { value: 'text', label: 'Text', icon: Type },
  { value: 'image', label: 'Photo', icon: ImageIcon },
  { value: 'video', label: 'Video', icon: Video },
]

function toErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

/**
 * Dialog for composing a new story: text, image or video, with an audience
 * picker. Media is validated client-side (8 MB images / 50 MB videos) and
 * uploaded before the story is created.
 */
export function StoryComposer({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const defaultAudience = useAppStore((s) => s.profile?.defaultStoryAudience)

  const [kind, setKind] = useState<StoryKind>('text')
  const [text, setText] = useState('')
  const [caption, setCaption] = useState('')
  const [audience, setAudience] = useState<StoryAudience>('public')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploadedFileId, setUploadedFileId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [creating, setCreating] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const wasOpenRef = useRef(false)

  // Fresh draft every time the composer opens.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setKind('text')
      setText('')
      setCaption('')
      setAudience(defaultAudience ?? 'public')
      setFile(null)
      setPreviewUrl(null)
      setUploadedFileId(null)
      setUploading(false)
      setCreating(false)
    }
    wasOpenRef.current = open
  }, [open, defaultAudience])

  // Free the object URL when the preview is replaced or on unmount.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const uploadFile = useCallback(async (f: File) => {
    setUploading(true)
    setUploadedFileId(null)
    try {
      const res = await api.upload(f, f.type.startsWith('video/') ? 'video' : 'image')
      setUploadedFileId(res.id)
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setUploading(false)
    }
  }, [])

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null
    e.target.value = '' // allow re-selecting the same file
    if (!selected) return
    if (kind === 'image' && !selected.type.startsWith('image/')) {
      toast.error('That file is not an image.')
      return
    }
    if (kind === 'video' && !selected.type.startsWith('video/')) {
      toast.error('That file is not a video.')
      return
    }
    const maxBytes = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
    if (selected.size > maxBytes) {
      toast.error(
        kind === 'video' ? 'Videos must be 50 MB or smaller.' : 'Images must be 8 MB or smaller.'
      )
      return
    }
    setFile(selected)
    setPreviewUrl(URL.createObjectURL(selected))
    setUploadedFileId(null)
    void uploadFile(selected)
  }

  function switchKind(next: StoryKind) {
    if (next === kind) return
    setKind(next)
    setFile(null)
    setPreviewUrl(null)
    setUploadedFileId(null)
    setUploading(false)
  }

  async function handleSubmit() {
    const trimmed = (kind === 'text' ? text : caption).trim()
    if (kind === 'text' && trimmed.length === 0) {
      toast.error('Write something for your story first.')
      return
    }
    if (kind !== 'text' && !uploadedFileId) {
      toast.error(
        uploading ? 'Hold on — your media is still uploading.' : 'Add a photo or video first.'
      )
      return
    }
    setCreating(true)
    try {
      await api.createStory({
        type: kind,
        text: trimmed.length > 0 ? trimmed : undefined,
        fileId: uploadedFileId,
        audience,
      })
      queryClient.invalidateQueries({ queryKey: ['stories'] })
      toast.success('Story shared. It disappears after 24 hours.')
      onOpenChange(false)
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  const busy = uploading || creating
  const canSubmit = kind === 'text' ? text.trim().length > 0 : Boolean(uploadedFileId) && !uploading
  const uploadFailed = kind !== 'text' && file !== null && !uploading && uploadedFileId === null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] gap-5 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New story</DialogTitle>
          <DialogDescription>Share a moment that vanishes after 24 hours.</DialogDescription>
        </DialogHeader>

        {/* Story type */}
        <div role="tablist" aria-label="Story type" className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              role="tab"
              aria-selected={kind === k.value}
              onClick={() => switchKind(k.value)}
              className={cn(
                'flex min-h-[44px] items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors',
                kind === k.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <k.icon className="h-4 w-4" aria-hidden />
              {k.label}
            </button>
          ))}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept={kind === 'video' ? 'video/*' : 'image/*'}
          onChange={handleFileChange}
          className="hidden"
          tabIndex={-1}
          aria-hidden
        />

        {kind === 'text' ? (
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="story-text">Your story</Label>
              <span
                className={cn(
                  'text-[11px] tabular-nums',
                  text.length >= MAX_TEXT_CHARS ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {text.length}/{MAX_TEXT_CHARS}
              </span>
            </div>
            <Textarea
              id="story-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={MAX_TEXT_CHARS}
              rows={5}
              placeholder="What is happening around you?"
              className="resize-none"
              autoFocus
            />
          </div>
        ) : (
          <div className="grid gap-4">
            {previewUrl && file ? (
              <div className="relative overflow-hidden rounded-lg border bg-foreground/5">
                {kind === 'image' ? (
                   
                  <img
                    src={previewUrl}
                    alt="Story preview"
                    className="max-h-[320px] w-full object-contain"
                  />
                ) : (
                  <video src={previewUrl} controls playsInline className="max-h-[320px] w-full" />
                )}
                {uploading && (
                  <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/70 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Uploading…
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex min-h-[120px] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground focus-visible:outline-none"
              >
                {kind === 'image' ? (
                  <ImageIcon className="h-6 w-6" aria-hidden />
                ) : (
                  <Video className="h-6 w-6" aria-hidden />
                )}
                <span className="text-sm font-medium">
                  {kind === 'image' ? 'Add a photo' : 'Add a video'}
                </span>
                <span className="text-xs">Max {kind === 'image' ? '8 MB' : '50 MB'}</span>
              </button>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-[44px]"
                onClick={() => fileInputRef.current?.click()}
              >
                {previewUrl ? 'Replace media' : 'Choose file'}
              </Button>
              {uploadFailed && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-[44px]"
                  onClick={() => file && void uploadFile(file)}
                >
                  <RotateCw className="h-4 w-4" aria-hidden />
                  Retry upload
                </Button>
              )}
            </div>

            <div className="grid gap-2">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="story-caption">Caption (optional)</Label>
                <span
                  className={cn(
                    'text-[11px] tabular-nums',
                    caption.length >= MAX_CAPTION_CHARS ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {caption.length}/{MAX_CAPTION_CHARS}
                </span>
              </div>
              <Textarea
                id="story-caption"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                maxLength={MAX_CAPTION_CHARS}
                rows={2}
                placeholder="Add context for your photo or video"
                className="resize-none"
              />
            </div>
          </div>
        )}

        {/* Audience */}
        <div className="grid gap-2">
          <Label>Who can see this</Label>
          <RadioGroup
            value={audience}
            onValueChange={(value) => setAudience(value === 'friends' ? 'friends' : 'public')}
            className="gap-2"
          >
            <label
              className={cn(
                'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                audience === 'public' ? 'border-primary/60 bg-accent/40' : 'hover:bg-accent/20'
              )}
            >
              <RadioGroupItem value="public" className="mt-0.5" />
              <span className="grid gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Globe2 className="h-3.5 w-3.5" aria-hidden />
                  Public
                </span>
                <span className="text-xs text-muted-foreground">
                  Visible to everyone on Ghostline
                </span>
              </span>
            </label>
            <label
              className={cn(
                'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                audience === 'friends' ? 'border-primary/60 bg-accent/40' : 'hover:bg-accent/20'
              )}
            >
              <RadioGroupItem value="friends" className="mt-0.5" />
              <span className="grid gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Lock className="h-3.5 w-3.5" aria-hidden />
                  Friends only
                </span>
                <span className="text-xs text-muted-foreground">
                  Only people you saved as contacts
                </span>
              </span>
            </label>
          </RadioGroup>
        </div>

        <Button
          type="button"
          className="min-h-[44px] w-full"
          disabled={busy || !canSubmit}
          onClick={() => void handleSubmit()}
        >
          {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
          {creating ? 'Sharing…' : uploading ? 'Uploading…' : 'Share story'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

export default StoryComposer
