/** 收藏的卡片：存在 localStorage，桌面版与浏览器版行为一致 */
export interface SavedCard {
  id: string
  packId?: string
  nodeId: string
  nodeName: string
  type: string
  front: string
  back: string
  at: number
}

const KEY = 'gapgraph.cards.v1'

export function loadCards(): SavedCard[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as SavedCard[]) : []
  } catch {
    return []
  }
}

function persist(cards: SavedCard[]): SavedCard[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(cards))
  } catch {
    /* 隐私模式/禁用存储时忽略 */
  }
  return cards
}

export function isSaved(packId: string, nodeId: string, front: string): boolean {
  return loadCards().some((c) => c.packId === packId && c.nodeId === nodeId && c.front === front)
}

export function addCard(card: Omit<SavedCard, 'id' | 'at'>): SavedCard[] {
  const cards = loadCards()
  if (cards.some((c) => c.packId === card.packId && c.nodeId === card.nodeId && c.front === card.front)) return cards
  const next: SavedCard[] = [
    ...cards,
    { ...card, id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, at: Date.now() }
  ]
  return persist(next)
}

export function removeCard(id: string): SavedCard[] {
  return persist(loadCards().filter((c) => c.id !== id))
}

export function cardCount(): number {
  return loadCards().length
}
