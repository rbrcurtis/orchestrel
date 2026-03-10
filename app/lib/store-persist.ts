import { autorun, toJS } from 'mobx'
import { get, set } from 'idb-keyval'

interface Persistable {
  serialize(): unknown[]
  hydrate(data: unknown[]): void
}

export function persistStore<T extends Persistable>(store: T, key: string) {
  get(key).then((cached: unknown) => {
    if (Array.isArray(cached) && cached.length > 0) store.hydrate(cached as unknown[])
  })

  autorun(() => {
    const data = toJS(store.serialize())
    set(key, data)
  }, { delay: 1000 })
}
