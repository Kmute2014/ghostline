import { NextResponse } from 'next/server'

export class ApiError extends Error {
  status: number
  code: string
  extra?: Record<string, unknown>

  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data as object, init)
}

export function fail(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message, ...extra } }, { status })
}

/** Wraps a route handler so thrown ApiErrors become clean JSON responses. */
export function handle<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await fn(...args)
    } catch (err) {
      if (err instanceof ApiError) {
        return fail(err.status, err.code, err.message, err.extra)
      }
      const request = args.find(
  (arg): arg is Request =>
    typeof Request !== 'undefined' && arg instanceof Request
)

console.error('[api] unhandled error:', {
  method: request?.method,
  url: request?.url,
  error: err,
})
      return fail(500, 'INTERNAL', 'Something went wrong. Please try again.')
    }
  }
}

export function unauthorized() {
  return new ApiError(401, 'UNAUTHENTICATED', 'Your session is missing or expired.')
}

export function badRequest(message: string, code = 'BAD_REQUEST', extra?: Record<string, unknown>) {
  return new ApiError(400, code, message, extra)
}

export function forbidden(message: string, code = 'FORBIDDEN') {
  return new ApiError(403, code, message)
}

export function notFound(message = 'Not found', code = 'NOT_FOUND') {
  return new ApiError(404, code, message)
}

export function gone(message: string, code = 'GONE') {
  return new ApiError(410, code, message)
}

export function tooMany(message: string, retryAfterSec: number, code = 'RATE_LIMITED') {
  return new ApiError(429, code, message, { retryAfterSec })
}
