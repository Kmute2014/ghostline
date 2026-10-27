'use client'

import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

let app: FirebaseApp | undefined

function getFirebaseApp(): FirebaseApp {
  if (app) return app
  if (getApps().length > 0) {
    app = getApp()
    return app
  }

  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  }
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(`Missing Firebase web configuration: ${missing.join(', ')}`)
  }

  app = initializeApp(config)
  return app
}

export function getFirebaseClientAuth() {
  return getAuth(getFirebaseApp())
}

export function getFirebaseClientFirestore() {
  return getFirestore(getFirebaseApp())
}
