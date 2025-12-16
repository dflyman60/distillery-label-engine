// src/lib/config.ts

export function getEnv(key: string): string | undefined {
  // Framer/Vite runtime supports import.meta.env, but TS types may not.
  const env = (import.meta as any)?.env
  const val = env?.[key]
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : undefined
}

export const API_BASE_URL =
  getEnv("VITE_BACKEND_URL") ||
  "https://distillery-label-engine-production.up.railway.app"

