import { autorun, toJS } from 'mobx'
import { get, set } from 'idb-keyval'

interface Persistable {
  serialize(): unknown[]
  hydrate(data: unknown[]): void
}

export function persistStore<T extends Persistable>(store: T, key: string) {
  let hasLiveData = store.serialize().length > 0

  get(key).then((cached: unknown) => {
    if (!Array.isArray(cached) || cached.length === 0 || hasLiveData) return
    store.hydrate(cached as unknown[])
  })

  autorun(() => {
    // JSON round-trip to strip MobX observable wrappers (toJS alone can leave non-cloneable proxies)
    const data = JSON.parse(JSON.stringify(toJS(store.serialize())))
    if (data.length > 0) hasLiveData = true
    set(key, data)
  }, { delay: 1000 })
}
