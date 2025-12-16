export type NormalizedLabelHistoryRow = {
  id: number
  labelId: number
  action: "CREATE" | "UPDATE" | "DELETE"
  createdAt: string // ISO
  createdAtMs: number

  brandName?: string
  productName?: string
  spiritType?: string
  abv?: number
  volumeMl?: number

  // COLA fields
  colaStatus?: string | null
  colaApplicationId?: string | null
  colaLastChangedAt?: string | null
}

function pick(obj: any, keys: string[], fallback: any = undefined) {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null) return v
  }
  return fallback
}

function toNum(v: any): number | undefined {
  if (v === undefined || v === null || v === "") return undefined
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function toIso(v: any): string {
  if (!v) return ""
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString()
}

export function normalizeHistoryItems(items: any[]): NormalizedLabelHistoryRow[] {
  return (items || [])
    .map((r) => {
      const createdAtIso = toIso(pick(r, ["createdAt", "created_at"]))
      return {
        id: Number(pick(r, ["id"], 0)),
        labelId: Number(pick(r, ["labelId", "label_id"], 0)),
        action: String(pick(r, ["action"], "UPDATE")).toUpperCase() as any,
        createdAt: createdAtIso,
        createdAtMs: createdAtIso ? new Date(createdAtIso).getTime() : 0,

        brandName: pick(r, ["brandName", "brand_name"]),
        productName: pick(r, ["productName", "product_name"]),
        spiritType: pick(r, ["spiritType", "spirit_type"]),
        abv: toNum(pick(r, ["abv"])),
        volumeMl: toNum(pick(r, ["volumeMl", "volume_ml"])),

        colaStatus: pick(r, ["colaStatus", "cola_status"], null),
        colaApplicationId: pick(r, ["colaApplicationId", "cola_application_id"], null),
        colaLastChangedAt: (() => {
          const v = pick(r, ["colaLastChangedAt", "cola_last_changed_at"], null)
          return v ? toIso(v) : null
        })(),
      }
    })
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))
}

