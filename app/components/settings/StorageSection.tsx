import { useState, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { del, get, createStore } from 'idb-keyval';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';

const CACHE_STORE = createStore('orchestrel-cache', 'store-cache');
const CACHE_KEYS = ['orchestrel:cards', 'orchestrel:projects'];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default observer(function StorageSection() {
  const [size, setSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    async function measure() {
      let total = 0;
      for (const key of CACHE_KEYS) {
        const data = await get(key);
        if (data) total += new Blob([JSON.stringify(data)]).size;
      }
      setSize(total);
    }
    void measure();
  }, []);

  async function handleClear() {
    setClearing(true);
    for (const key of CACHE_KEYS) {
      await del(key, CACHE_STORE);
    }
    setSize(0);
    setClearing(false);
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Storage</h2>
        <p className="text-xs text-muted-foreground max-w-prose mt-1">
          What lives on this machine, and what is safe to drop. The board&apos;s data itself belongs to the node&apos;s
          database.
        </p>
      </div>

      <Card>
        <CardContent className="py-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Local cache</p>
            <p className="text-xs text-muted-foreground">
              {size === null ? 'Calculating...' : formatBytes(size)} · offline snapshot of cards and projects
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleClear} disabled={clearing || size === 0}>
            {clearing ? 'Clearing...' : 'Clear'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
});
