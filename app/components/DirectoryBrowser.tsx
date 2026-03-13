import { useState, useEffect } from 'react';
import { useProjectStore } from '~/stores/context';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '~/components/ui/dialog';
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator } from '~/components/ui/breadcrumb';
import { Button } from '~/components/ui/button';
import { ScrollArea } from '~/components/ui/scroll-area';
import { Folder } from 'lucide-react';

interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface DirectoryBrowserProps {
  initialPath?: string;
  onSelect: (path: string, isGitRepo: boolean) => void;
  onCancel: () => void;
}

export default function DirectoryBrowser({ initialPath = '/home/ryan', onSelect, onCancel }: DirectoryBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useProjectStore();

  const segments = currentPath.split('/').filter(Boolean);

  useEffect(() => {
    setLoading(true);
    setError(null);
    projects.browse(currentPath)
      .then((data) => setDirs(data as DirEntry[]))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Error loading directory'))
      .finally(() => setLoading(false));
  }, [currentPath, projects]);

  function navigateTo(path: string) {
    setCurrentPath(path);
  }

  function navigateToBreadcrumb(idx: number) {
    const path = '/' + segments.slice(0, idx + 1).join('/');
    setCurrentPath(path);
  }

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-lg flex flex-col max-h-[80vh] p-0 gap-0" showCloseButton={false}>
        <DialogHeader className="px-4 pt-4 pb-2 border-b space-y-2">
          <DialogTitle className="sr-only">Browse Directories</DialogTitle>
          <Breadcrumb>
            <BreadcrumbList className="flex-nowrap overflow-x-auto">
              <BreadcrumbItem>
                <BreadcrumbLink
                  href="#"
                  onClick={(e) => { e.preventDefault(); setCurrentPath('/'); }}
                  className="cursor-pointer font-medium"
                >
                  /
                </BreadcrumbLink>
              </BreadcrumbItem>
              {segments.map((seg, i) => (
                <BreadcrumbItem key={i}>
                  <BreadcrumbSeparator>/</BreadcrumbSeparator>
                  <BreadcrumbLink
                    href="#"
                    onClick={(e) => { e.preventDefault(); navigateToBreadcrumb(i); }}
                    className="cursor-pointer"
                  >
                    {seg}
                  </BreadcrumbLink>
                </BreadcrumbItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </DialogHeader>

        {/* Directory list */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="max-h-64">
            {loading && (
              <div className="p-4 text-sm text-muted-foreground">Loading...</div>
            )}
            {error && (
              <div className="p-4 text-sm text-destructive">{error}</div>
            )}
            {!loading && !error && dirs.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground">No subdirectories</div>
            )}
            {dirs.map((dir) => (
              <Button
                key={dir.path}
                variant="ghost"
                className="w-full justify-start rounded-none h-auto px-4 py-2 text-sm font-normal"
                onClick={() => navigateTo(dir.path)}
              >
                <Folder className="size-4 text-muted-foreground shrink-0" />
                <span>{dir.name}</span>
              </Button>
            ))}
          </div>
        </ScrollArea>

        {/* Footer actions */}
        <DialogFooter className="px-4 py-3 border-t">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={() => onSelect(currentPath, false)}
          >
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
