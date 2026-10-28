import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client

  const url = process.env.SUPABASE_URL
  const secretKey = process.env.SUPABASE_SECRET_KEY

  if (!url || !secretKey) {
    throw new Error('Supabase server environment variables are missing.')
  }

  client = createClient(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })

  return client
}

export async function mirrorRelayDocument(
  collectionPath: string,
  documentId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('hushly_relay_documents')
    .upsert(
      {
        collection_path: collectionPath,
        document_id: documentId,
        data,
        source_updated_at: new Date().toISOString(),
        mirrored_at: new Date().toISOString(),
        revision: 1,
      },
      { onConflict: 'collection_path,document_id' },
    )

  if (error) {
    throw new Error(`Supabase relay write failed: ${error.message}`)
  }
}

export async function readRelayDocumentsForUser(
  collectionPath: string,
  userId: string,
): Promise<Array<{ document_id: string; data: Record<string, unknown> }>> {
  const { data, error } = await getSupabaseAdmin()
    .from('hushly_relay_documents')
    .select('document_id,data')
    .eq('collection_path', collectionPath)
    .contains('data', { userId })

  if (error) {
    throw new Error(`Supabase relay read failed: ${error.message}`)
  }

  return (data ?? []) as Array<{
    document_id: string
    data: Record<string, unknown>
  }>
}

export async function deleteRelayDocument(
  collectionPath: string,
  documentId: string,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('hushly_relay_documents')
    .delete()
    .eq('collection_path', collectionPath)
    .eq('document_id', documentId)

  if (error) {
    throw new Error(`Supabase relay delete failed: ${error.message}`)
  }
}
